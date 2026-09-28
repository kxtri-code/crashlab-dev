import { describe, expect, it } from 'vitest';
import {
  compilePlanLocator,
  isCssSelector,
  isPlaywrightLocatorExpression,
} from '../../src/executor/locatorResolver.js';
import {
  collectSecrets,
  createScrubber,
  isSensitiveTestDataKey,
  redactExecutionUrl,
  redactMessage,
  summarizeValue,
  NO_SECRETS,
  REDACTED,
} from '../../src/executor/redaction.js';
import { loadTestData, resolveFixturePath, resolveValue, semanticKeysForIntent } from '../../src/executor/testData.js';
import { ExecutionRefused } from '../../src/executor/types.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

describe('locator expression recognition', () => {
  it('recognises the forms Build 2 emits', () => {
    const emitted = [
      "page.getByTestId('place-order')",
      "page.getByRole('button', { name: 'Place order' })",
      "page.getByLabel('Email address')",
      "page.getByPlaceholder('you@example.com')",
      '#email',
      'form#main > input[name="email"]',
      'a[href="/cart"]',
    ];
    for (const candidate of emitted) {
      expect(compilePlanLocator(candidate), candidate).not.toBeNull();
    }
  });

  it('recognises Playwright expressions', () => {
    expect(isPlaywrightLocatorExpression("page.getByTestId('x')")).toBe(true);
    expect(isPlaywrightLocatorExpression('#x')).toBe(false);
  });

  it('recognises CSS selectors and rejects non-selectors', () => {
    expect(isCssSelector('#email')).toBe(true);
    expect(isCssSelector('div.item > a')).toBe(true);
    expect(isCssSelector('https://example.test/')).toBe(false);
    expect(isCssSelector('page.getByRole("button")')).toBe(false);
    expect(isCssSelector('')).toBe(false);
  });

  it('refuses an expression the executor does not understand rather than guessing', () => {
    // These are not in the grammar the executor supports, and executing them
    // would mean acting on something the planner did not clearly specify.
    for (const candidate of [
      'page.waitForTimeout(1000)',
      'page.evaluate(() => 1)',
      'page.getByRole("button", { name: "x" }).first()',
      'page.getByRole("button", { name: "x" }).nth(2)',
      'page.locator("x") + page.locator("y")',
    ]) {
      expect(compilePlanLocator(candidate), candidate).toBeNull();
    }
  });

  it('never evaluates a plan string as code', () => {
    // A string that would be code if interpolated must simply not compile.
    expect(compilePlanLocator("page.getByTestId('x'); process.exit(1)")).toBeNull();
    expect(compilePlanLocator('process.exit(1)')).toBeNull();
  });

  it('preserves the role in a getByRole expression', async () => {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent('<a href="/x">Cart link</a><button>Cart button</button>');
      const compiled = compilePlanLocator("page.getByRole('link', { name: 'Cart link' })");
      expect(compiled).not.toBeNull();
      const locator = compiled!(page);
      // Resolving the link must not match the button with similar text.
      expect(await locator.count()).toBe(1);
      expect(await locator.getAttribute('href')).toBe('/x');
    } finally {
      await browser.close();
    }
  }, 30_000);
});

describe('redaction', () => {
  it('scrubs a known secret from free text', () => {
    const scrub = createScrubber(['SafeFixturePassword123!']);
    expect(scrub.scrub('submitted:SafeFixturePassword123!')).toBe(`submitted:${REDACTED}`);
  });

  it('scrubs regardless of case and surrounding noise', () => {
    const scrub = createScrubber(['hunter2secret']);
    expect(scrub.scrub('Value HUNTER2SECRET here')).toContain(REDACTED);
  });

  it('scrubs a URL-encoded secret', () => {
    const scrub = createScrubber(['p@ss word/word']);
    expect(scrub.scrub('p%40ss%20word%2Fword')).toBe(REDACTED);
  });

  it('ignores secrets too short to be meaningful', () => {
    // Replacing a 1-character string would corrupt unrelated text.
    const scrub = createScrubber(['a']);
    expect(scrub.secretCount).toBe(0);
    expect(scrub.scrub('a value')).toBe('a value');
  });

  it('leaves text untouched when there are no secrets', () => {
    expect(NO_SECRETS.scrub('anything at all')).toBe('anything at all');
  });

  it('redacts sensitive query values in an execution URL', () => {
    expect(redactExecutionUrl('https://x.test/a?token=abc&page=2')).toBe(`https://x.test/a?token=${REDACTED}&page=2`);
    expect(redactExecutionUrl('https://x.test/a?api_key=abc&ok=1')).toBe(`https://x.test/a?api_key=${REDACTED}&ok=1`);
    expect(redactExecutionUrl('https://x.test/a?page=2')).toBe('https://x.test/a?page=2');
  });

  it('preserves the fragment when redacting a URL', () => {
    expect(redactExecutionUrl('https://x.test/a?token=abc#frag')).toContain('#frag');
  });

  it('returns null for a null URL', () => {
    expect(redactExecutionUrl(null)).toBeNull();
    expect(redactExecutionUrl(undefined)).toBeNull();
  });

  it('scrubs a secret out of a URL', () => {
    const scrub = createScrubber(['supersecrettoken']);
    expect(redactExecutionUrl('https://x.test/a?plain=supersecrettoken', scrub)).toBe(`https://x.test/a?plain=${REDACTED}`);
  });

  it('collapses and caps an error message', () => {
    expect(redactMessage('a\n  b   c')).toBe('a b c');
    expect(redactMessage('x'.repeat(600)).length).toBeLessThanOrEqual(403);
  });

  it('scrubs a secret out of an error message', () => {
    const scrub = createScrubber(['SafeFixturePassword123!']);
    expect(redactMessage('rejected value SafeFixturePassword123!', scrub)).toBe(`rejected value ${REDACTED}`);
  });

  it('never reveals a value in a summary', () => {
    const summary = summarizeValue('SafeFixturePassword123!');
    expect(summary.provided).toBe(true);
    expect(summary.valueRedacted).toBe(true);
    expect(summary.length).toBe('SafeFixturePassword123!'.length);
    expect(JSON.stringify(summary)).not.toContain('SafeFixturePassword123!');
  });

  it('reports a missing value without a length', () => {
    expect(summarizeValue(undefined)).toEqual({ provided: false, valueRedacted: true, length: null });
    expect(summarizeValue(null)).toEqual({ provided: false, valueRedacted: true, length: null });
  });

  it('identifies sensitive test-data keys', () => {
    for (const key of ['password', 'Password', 'apiKey', 'cardNumber', 'cvv', 'sessionToken']) {
      expect(isSensitiveTestDataKey(key), key).toBe(true);
    }
    for (const key of ['email', 'username', 'country', 'message']) {
      expect(isSensitiveTestDataKey(key), key).toBe(false);
    }
  });

  it('collects only sensitive-keyed values as secrets', () => {
    const secrets = collectSecrets({ email: 'a@b.test', password: 'p1', cvv: '123' });
    expect(secrets).toContain('p1');
    expect(secrets).toContain('123');
    expect(secrets).not.toContain('a@b.test');
  });

  it('handles absent test data', () => {
    expect(collectSecrets(undefined)).toEqual([]);
  });
});

describe('test data resolution', () => {
  it('prefers an exact element id', () => {
    const resolved = resolveValue({ 'element-004': 'by-id', email: 'by-email' }, {
      elementIds: ['element-004'],
      intent: 'identify_email_field',
    });
    expect(resolved.found).toBe(true);
    expect(resolved.key).toBe('element-004');
    expect(resolved.value).toBe('by-id');
  });

  it('falls back to a semantic key derived from the intent', () => {
    const resolved = resolveValue({ email: 'by-email' }, { elementIds: [], intent: 'identify_email_field' });
    expect(resolved.found).toBe(true);
    expect(resolved.key).toBe('email');
  });

  it('prefers password over email for a password intent', () => {
    expect(semanticKeysForIntent('identify_password_field')[0]).toBe('password');
    const resolved = resolveValue({ email: 'a@b.test', password: 'p' }, { elementIds: [], intent: 'identify_password_field' });
    expect(resolved.key).toBe('password');
  });

  it('prefers confirmPassword for a confirmation intent', () => {
    const resolved = resolveValue(
      { confirmPassword: 'c', password: 'p' },
      { elementIds: [], intent: 'identify_password_confirmation' },
    );
    expect(resolved.key).toBe('confirmPassword');
  });

  it('falls back to a stable field name', () => {
    const resolved = resolveValue({ coupon: 'SAVE10' }, { elementIds: [], intent: 'mystery', fieldName: 'coupon' });
    expect(resolved.key).toBe('coupon');
  });

  it('reports no value rather than guessing', () => {
    const resolved = resolveValue({ email: 'a@b.test' }, { elementIds: ['element-009'], intent: 'identify_country_field' });
    // `email` exists but is not semantically relevant here, so the generic
    // vocabulary fallback must not hand it over for a country field.
    expect(resolved.found).toBe(false);
    expect(resolved.value).toBeNull();
  });

  it('never returns an empty string as a substitute', () => {
    const resolved = resolveValue({ email: '' }, { elementIds: [], intent: 'identify_email_field' });
    // An empty string is a real value the caller supplied, so it is returned;
    // what must never happen is substituting one when nothing was supplied.
    expect(resolved.found).toBe(true);
    expect(resolveValue(undefined, { elementIds: [], intent: 'identify_email_field' }).found).toBe(false);
  });

  it('reports the keys it tried, for the block reason', () => {
    const resolved = resolveValue({}, { elementIds: ['element-001'], intent: 'identify_password_field' });
    expect(resolved.triedKeys).toContain('element-001');
    expect(resolved.triedKeys).toContain('password');
  });
});

describe('loadTestData', () => {
  it('loads a flat string map', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crashlab-td-'));
    try {
      const path = join(dir, 'data.json');
      await writeFile(path, JSON.stringify({ email: 'a@b.test', password: 'p' }), 'utf8');
      await expect(loadTestData(path)).resolves.toEqual({ email: 'a@b.test', password: 'p' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses a missing file', async () => {
    await expect(loadTestData('no-such-data.json')).rejects.toThrow(ExecutionRefused);
  });

  it('refuses invalid JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crashlab-td-'));
    try {
      const path = join(dir, 'bad.json');
      await writeFile(path, '{ nope', 'utf8');
      await expect(loadTestData(path)).rejects.toThrow(/not valid JSON/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses a nested structure rather than coercing it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crashlab-td-'));
    try {
      const path = join(dir, 'nested.json');
      await writeFile(path, JSON.stringify({ user: { email: 'a@b.test' } }), 'utf8');
      await expect(loadTestData(path)).rejects.toThrow(/string keys to string values/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveFixturePath', () => {
  it('accepts a path inside the allowed root', () => {
    const root = join('a', 'fixtures');
    // The result is absolute, so compare against the resolved form.
    expect(resolveFixturePath(join(root, 'file.txt'), root)).toBe(resolve(root, 'file.txt'));
  });

  it('refuses a path outside the allowed root', () => {
    const root = join('a', 'fixtures');
    expect(() => resolveFixturePath(join('a', 'secrets.txt'), root)).toThrow(/outside the allowed fixture directory/i);
  });

  it('refuses a sibling directory that shares a name prefix', () => {
    // The classic prefix bug: "/a/fixtures-evil" must not pass as "/a/fixtures".
    const root = join('a', 'fixtures');
    expect(() => resolveFixturePath(join('a', `fixtures-evil${sep}secret.txt`), root)).toThrow(/outside/i);
  });

  it('refuses a traversal out of the root', () => {
    const root = join('a', 'fixtures');
    expect(() => resolveFixturePath(join('a', 'fixtures', '..', '..', 'etc', 'passwd'), root)).toThrow(/outside/i);
  });

  it('refuses an absolute path outside the root', () => {
    expect(() => resolveFixturePath(sep === '\\' ? 'C:\\Windows\\System32\\config' : '/etc/passwd', 'fixtures')).toThrow(/outside/i);
  });
});
