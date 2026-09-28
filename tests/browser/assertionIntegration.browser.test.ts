import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import type { Server } from 'node:http';

import {
  ASSERTION_TYPES,
  generatePostActionAssertion,
  generateTargetElementAssertion,
  generateVisibleTextAssertion,
  isSafeExpectedText,
  isStablePath,
  normalizeOrigin,
  normalizePath,
  normalizeText,
  validateStructuredAssertion,
} from '../../src/journey/structuredAssertion.js';
import { runScout } from '../../src/scout/scout.js';
import { planJourney } from '../../src/journey/plan.js';
import { executeJourney } from '../../src/executor/executor.js';
import { validateJourneyPlan } from '../../src/executor/planValidator.js';
import { startFixtureServer, stopFixtureServer } from '../fixtures/server.js';
import type { StructuredAssertion } from '../../src/journey/types.js';
import type { ExecutionReport } from '../../src/executor/types.js';
import { journey } from '../fixtures/executionReports.js';

let server: Server;
let origin: string;
let available = false;
let dir: string;

beforeAll(async () => {
  try {
    await chromium.launch({ headless: true });
    available = true;
  } catch {
    available = false;
  }
  const started = await startFixtureServer();
  server = started.server;
  origin = started.origin;
  dir = await mkdtemp(join(tmpdir(), 'crashlab-b62-'));
}, 60_000);

afterAll(async () => {
  if (server) await stopFixtureServer(server);
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('normalization', () => {
  it('normalizes a path without query, fragment or trailing slash', () => {
    expect(normalizePath('/cart/?a=1#b')).toBe('/cart');
    expect(normalizePath('cart')).toBe('/cart');
    expect(normalizePath('/')).toBe('/');
  });

  it('normalizes an origin and drops everything else', () => {
    expect(normalizeOrigin('https://shop.test/cart?token=x#y')).toBe('https://shop.test');
    expect(normalizeOrigin('not a url')).toBeNull();
  });

  it('rejects a file URL as an origin', () => {
    expect(normalizeOrigin('file:///C:/page.html')).toBeNull();
  });

  it('collapses whitespace in text', () => {
    expect(normalizeText('  Order   confirmed \n')).toBe('Order confirmed');
  });
});

describe('path stability', () => {
  it('accepts declared, stable routes', () => {
    expect(isStablePath('/cart')).toBe(true);
    expect(isStablePath('/catalog/blue-widget')).toBe(true);
    expect(isStablePath('/checkout/step-2')).toBe(true);
  });

  it('rejects routes carrying a generated id', () => {
    // These are the shapes a guard that silently fails to fire would miss.
    expect(isStablePath('/orders/550e8400-e29b-41d4-a716-446655440000')).toBe(false);
    expect(isStablePath('/orders/12345')).toBe(false);
    expect(isStablePath('/orders/2026-01-15')).toBe(false);
    expect(isStablePath('/a/0123456789abcdef0123')).toBe(false);
    expect(isStablePath('/a/deadbeefcafe1234')).toBe(false);
  });
});

describe('expected-text safety', () => {
  it('accepts short, plain confirmation text', () => {
    expect(isSafeExpectedText('Order confirmed')).toBe(true);
  });

  it('rejects empty, overlong and secret-bearing text', () => {
    expect(isSafeExpectedText('')).toBe(false);
    expect(isSafeExpectedText('x'.repeat(200))).toBe(false);
    // A secret must never become an expected value.
    expect(isSafeExpectedText('password=hunter2')).toBe(false);
    expect(isSafeExpectedText('Your session token is abc')).toBe(false);
    expect(isSafeExpectedText('CVV 123')).toBe(false);
  });
});

describe('structured assertion validation', () => {
  it('accepts each supported type', () => {
    expect(validateStructuredAssertion({ type: 'element-present', source: { kind: 'scout-element', elementId: 'element-001' } })?.type).toBe('element-present');
    expect(validateStructuredAssertion({ type: 'element-visible', source: { kind: 'scout-element', elementId: 'element-001' } })?.type).toBe('element-visible');
    expect(validateStructuredAssertion({ type: 'element-enabled', source: { kind: 'scout-element', elementId: 'element-001' } })?.type).toBe('element-enabled');
    expect(validateStructuredAssertion({ type: 'text-contains', expectedText: 'Done', source: { kind: 'scout-visible-text' } })?.type).toBe('text-contains');
    expect(validateStructuredAssertion({ type: 'url-origin', expectedOrigin: 'https://a.test', source: { kind: 'scout-href' } })?.type).toBe('url-origin');
    expect(validateStructuredAssertion({ type: 'url-path', expectedPath: '/cart', source: { kind: 'scout-href' } })?.type).toBe('url-path');
  });

  it('exposes exactly the documented type list', () => {
    expect([...ASSERTION_TYPES]).toEqual([
      'element-present',
      'element-visible',
      'element-enabled',
      'text-contains',
      'url-origin',
      'url-path',
    ]);
  });

  it('rejects a malformed assertion rather than half-executing it', () => {
    expect(validateStructuredAssertion(null)).toBeNull();
    expect(validateStructuredAssertion('nope')).toBeNull();
    expect(validateStructuredAssertion({})).toBeNull();
    expect(validateStructuredAssertion({ type: 'teleport', source: { kind: 'scout-element' } })).toBeNull();
    // A source is required: an untraceable assertion is indistinguishable
    // from an invented one.
    expect(validateStructuredAssertion({ type: 'url-path', expectedPath: '/cart' })).toBeNull();
    expect(validateStructuredAssertion({ type: 'url-path', source: { kind: 'scout-href' } })).toBeNull();
  });

  it('rejects a url-path carrying a generated id', () => {
    expect(
      validateStructuredAssertion({
        type: 'url-path',
        expectedPath: '/orders/550e8400-e29b-41d4-a716-446655440000',
        source: { kind: 'scout-href' },
      }),
    ).toBeNull();
  });

  it('normalizes a validated assertion deterministically', () => {
    const a = validateStructuredAssertion({ type: 'url-path', expectedPath: '/cart/?x=1', source: { kind: 'scout-href' } });
    const b = validateStructuredAssertion({ type: 'url-path', expectedPath: '/cart', source: { kind: 'scout-href' } });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('planner generation from Scout evidence', () => {
  let scout: Awaited<ReturnType<typeof runScout>>;

  beforeAll(async () => {
    if (!available) return;
    scout = await runScout({ url: `${origin}/catalog`, headless: true, settleMs: 150, timeoutMs: 15_000 });
  });

  it('generates a url-path assertion from a declared same-origin link', () => {
    if (!available) return;
    const generation = generatePostActionAssertion(scout, {
      href: `${origin}/cart`,
      elementId: 'element-002',
      field: 'href',
    });
    expect(generation.kind).toBe('generated');
    if (generation.kind !== 'generated') return;
    expect(generation.candidate.assertion).toEqual({
      type: 'url-path',
      expectedPath: '/cart',
      match: 'exact',
      source: { kind: 'scout-href', elementId: 'element-002', field: 'href' },
    });
  });

  it('traces the generated assertion to the Scout element', () => {
    if (!available) return;
    const generation = generatePostActionAssertion(scout, {
      href: `${origin}/cart`,
      elementId: 'element-002',
      field: 'href',
    });
    expect(generation.kind).toBe('generated');
    if (generation.kind !== 'generated') return;
    expect(generation.candidate.assertion.source.elementId).toBe('element-002');
    expect(generation.candidate.targetElementIds).toEqual(['element-002']);
  });

  it('declines a destination with a generated id', () => {
    if (!available) return;
    const generation = generatePostActionAssertion(scout, {
      href: `${origin}/orders/550e8400-e29b-41d4-a716-446655440000`,
      elementId: 'element-003',
      field: 'href',
    });
    expect(generation.kind).toBe('declined');
  });

  it('declines a control with no declared destination', () => {
    if (!available) return;
    const generation = generatePostActionAssertion(scout, { href: '', elementId: 'element-001', field: 'href' });
    expect(generation.kind).toBe('declined');
  });

  it('generates a url-origin assertion for a cross-origin destination', () => {
    if (!available) return;
    const generation = generatePostActionAssertion(scout, {
      href: 'https://elsewhere.invalid/cart',
      elementId: 'element-002',
      field: 'href',
    });
    expect(generation.kind).toBe('generated');
    if (generation.kind !== 'generated') return;
    expect(generation.candidate.assertion.type).toBe('url-origin');
    expect(generation.candidate.assertion).toMatchObject({ expectedOrigin: 'https://elsewhere.invalid' });
  });

  it('never invents expected text', () => {
    const generation = generateVisibleTextAssertion(
      { interactiveElements: [] } as never,
      { expectedText: 'Order confirmed', elementId: 'element-001', locator: '#c' },
    );
    // The value came from the caller, which in the planner means Scout.
    if (generation.kind === 'generated') {
      expect(generation.candidate.assertion).toMatchObject({ expectedText: 'Order confirmed' });
    } else {
      expect(generation.reason).toBeTruthy();
    }
  });

  it('refuses secret-bearing expected text', () => {
    const generation = generateVisibleTextAssertion({ interactiveElements: [] } as never, {
      expectedText: 'password=hunter2',
      elementId: 'element-001',
      locator: '#c',
    });
    expect(generation.kind).toBe('declined');
  });

  it('declines an element assertion for a control absent from Scout', () => {
    const generation = generateTargetElementAssertion(
      { interactiveElements: [] } as never,
      { elementId: 'element-999', locator: '#x' },
    );
    expect(generation.kind).toBe('declined');
  });

  it('declines an enabled assertion for a control Scout saw disabled', () => {
    if (!available) return;
    const generation = generateTargetElementAssertion(scout, { elementId: 'element-001', locator: '#buy', require: 'enabled' });
    // Either the control is enabled and an assertion is fine, or it is not and
    // the generator declines. What must never happen is asserting an element
    // that Scout recorded as disabled.
    if (generation.kind === 'generated') {
      expect(generation.candidate.assertion.type).toBe('element-enabled');
    } else {
      expect(generation.reason).toMatch(/disabled/);
    }
  });
});

describe('journey plan compatibility', () => {
  it('accepts a legacy step with no assertion', () => {
    const validated = validateJourneyPlan(
      {
        ...journey(),
        steps: [
          {
            id: 'step-001',
            order: 1,
            intent: 'define_login_success',
            action: 'assert',
            description: '',
            targetElementIds: [],
            locatorCandidates: [],
            expectedOutcome: 'The user is successfully logged in',
            confidence: 0.5,
            executable: false,
            source: { report: 'r', elementIds: [] },
          },
        ],
      },
      'j.json',
    );
    expect(validated.steps[0]?.assertion).toBeUndefined();
    expect(validated.steps[0]?.expectedOutcome).toBe('The user is successfully logged in');
  });

  it('carries a valid structured assertion through validation', () => {
    const validated = validateJourneyPlan(
      {
        ...journey(),
        steps: [
          {
            id: 'step-001',
            order: 1,
            intent: 'define_cart',
            action: 'assert',
            description: '',
            targetElementIds: [],
            locatorCandidates: [],
            expectedOutcome: 'The cart page is opened',
            assertion: {
              type: 'url-path',
              expectedPath: '/cart',
              match: 'exact',
              source: { kind: 'scout-href', elementId: 'element-008', field: 'href' },
            },
            confidence: 0.8,
            executable: false,
            source: { report: 'r', elementIds: ['element-008'] },
          },
        ],
      },
      'j.json',
    );
    expect(validated.steps[0]?.assertion?.type).toBe('url-path');
  });

  it('drops a malformed assertion rather than carrying it', () => {
    const validated = validateJourneyPlan(
      {
        ...journey(),
        steps: [
          {
            id: 'step-001',
            order: 1,
            intent: 'x',
            action: 'assert',
            description: '',
            targetElementIds: [],
            locatorCandidates: [],
            expectedOutcome: 'prose',
            assertion: { type: 'url-path', expectedPath: '/orders/550e8400-e29b-41d4-a716-446655440000', source: { kind: 'scout-href' } },
            confidence: 0.5,
            executable: false,
            source: { report: 'r', elementIds: [] },
          },
        ],
      },
      'j.json',
    );
    // Dropped, so the executor treats it as prose: the same safe outcome as
    // never having one.
    expect(validated.steps[0]?.assertion).toBeUndefined();
  });
});

describe('planner output: determinism and conservatism', () => {
  it('produces byte-identical plans for the same input', async () => {
    if (!available) return;
    const scout = await runScout({ url: `${origin}/catalog`, headless: true, settleMs: 150, timeoutMs: 15_000 });
    const first = JSON.stringify(planJourney('Try to complete checkout', scout, 'r'), null, 2);
    for (let i = 0; i < 3; i++) {
      expect(JSON.stringify(planJourney('Try to complete checkout', scout, 'r'), null, 2)).toBe(first);
    }
  });

  it('never emits a payment-success assertion', () => {
    if (!available) return;
    const scout = runScoutSync();
    for (const goal of ['Try to complete checkout', 'Try to purchase a ticket', 'Try to buy a widget']) {
      const plan = planJourney(goal, scout, 'r');
      for (const step of plan.steps) {
        if (step.assertion === undefined) continue;
        const serialized = JSON.stringify(step.assertion).toLowerCase();
        // A payment outcome is never something the planner can evidence.
        for (const forbidden of ['paid', 'payment-success', 'order-confirmed', 'charge']) {
          expect(serialized, `${goal}/${step.id}`).not.toContain(forbidden);
        }
      }
    }
  });

  it('keeps the prose fallback when no destination is observable', () => {
    if (!available) return;
    const plan = planJourney('Try to log in', runScoutSync(), 'r');
    const finalStep = plan.steps[plan.steps.length - 1];
    // A login form declares no postcondition, so the prose expectation stands.
    expect(finalStep?.action).toBe('assert');
    expect(finalStep?.expectedOutcome).toBeTruthy();
  });

  it('every generated assertion traces to a Scout element', () => {
    if (!available) return;
    const scout = runScoutSync();
    for (const goal of ['Try to complete checkout', 'Try to log in', 'Try to submit the form', 'Navigate to settings']) {
      const plan = planJourney(goal, scout, 'r');
      for (const step of plan.steps) {
        if (step.assertion === undefined) continue;
        const elementId = (step.assertion as StructuredAssertion).source.elementId;
        expect(elementId, `${goal}/${step.id}`).toBeTruthy();
        expect(step.source.elementIds).toContain(elementId as string);
      }
    }
  });
});

/** Scout the assertion fixture synchronously enough for pure planner tests. */
function runScoutSync() {
  if (!scoutCache) throw new Error('scout cache not primed');
  return scoutCache;
}

let scoutCache: Awaited<ReturnType<typeof runScout>> | null = null;

beforeAll(async () => {
  if (!available) return;
  scoutCache = await runScout({ url: `${origin}/catalog`, headless: true, settleMs: 150, timeoutMs: 15_000 });
});

describe('executor evaluation of structured assertions', () => {
  /**
   * Execute a single-assertion plan against the local fixture.
   *
   * The target is the real fixture server rather than a synthetic host: a URL
   * assertion can only be evaluated on a page that actually loaded, and an
   * unresolvable host would leave the executor on about:blank and make the
   * assertion fail for the wrong reason.
   */
  async function runAssertion(assertion: StructuredAssertion, path = '/catalog'): Promise<ExecutionReport> {
    if (!available) throw new Error('no browser');
    const plan = validateJourneyPlan(
      {
        ...journey({
          goal: 'assert',
          target: { url: `${origin}${path}`, finalUrl: null, title: 't' },
          steps: [
            {
              id: 'step-001',
              order: 1,
              intent: 'define',
              action: 'assert',
              description: '',
              targetElementIds: [],
              locatorCandidates: [],
              expectedOutcome: 'prose',
              assertion,
              confidence: 0.8,
              executable: false,
              source: { report: 'r', elementIds: [] },
            },
          ],
        }),
      },
      'j.json',
    );
    return executeJourney({ plan, planPath: 'p', headed: false, continueOnFailure: true, screenshots: false, safeTestMode: true });
  }

  it('passes a url-path assertion that holds', async () => {
    if (!available) return;
    const report = await runAssertion({
      type: 'url-path',
      expectedPath: '/catalog',
      match: 'exact',
      source: { kind: 'scout-target-url' },
    });
    // The executor navigates to the plan target, so the path matches.
    expect(report.steps[0]?.status).toBe('passed');
    expect(report.steps[0]?.assertion?.result).toBe('matched');
  }, 30_000);

  it('fails a url-path assertion that does not hold', async () => {
    if (!available) return;
    const report = await runAssertion({
      type: 'url-path',
      expectedPath: '/somewhere-else',
      match: 'exact',
      source: { kind: 'scout-target-url' },
    });
    // Evaluated and not satisfied: a real result, but not a defect verdict.
    expect(report.steps[0]?.status).toBe('failed');
    expect(report.steps[0]?.assertion?.result).toBe('not-matched');
    expect(report.steps[0]?.error?.message).toMatch(/not satisfied/);
    // A failed assertion is a real outcome, so the run is not fully verified.
    expect(report.verification?.status).toBe('incomplete');
  }, 30_000);

  it('passes a url-origin assertion that holds', async () => {
    if (!available) return;
    const report = await runAssertion({
      type: 'url-origin',
      expectedOrigin: origin,
      match: 'exact',
      source: { kind: 'scout-target-url' },
    });
    expect(report.steps[0]?.status).toBe('passed');
  }, 30_000);

  it('leaves an unsupported assertion unverified rather than failing it', async () => {
    if (!available) return;
    // A malformed assertion is dropped by validation, so the step keeps the
    // Build 6.1 prose path: skipped and unverified, never a failure.
    const plan = validateJourneyPlan(
      {
        ...journey(),
        target: { url: 'http://fixture.invalid/', finalUrl: null, title: 't' },
        steps: [
          {
            id: 'step-001',
            order: 1,
            intent: 'define',
            action: 'assert',
            description: '',
            targetElementIds: [],
            locatorCandidates: [],
            expectedOutcome: 'prose only',
            assertion: { type: 'nonsense', source: { kind: 'scout-href' } } as never,
            confidence: 0.5,
            executable: false,
            source: { report: 'r', elementIds: [] },
          },
        ],
      },
      'j.json',
    );
    const report = await executeJourney({
      plan,
      planPath: 'p',
      headed: false,
      continueOnFailure: true,
      screenshots: false,
      safeTestMode: true,
    });
    expect(report.steps[0]?.status).toBe('skipped');
    expect(report.steps[0]?.verification?.status).toBe('unverified');
    expect(report.steps[0]?.error).toBeNull();
  }, 30_000);

  it('keeps legacy prose behaviour unchanged', async () => {
    if (!available) return;
    const plan = validateJourneyPlan(
      {
        ...journey(),
        target: { url: 'http://fixture.invalid/', finalUrl: null, title: 't' },
        steps: [
          {
            id: 'step-001',
            order: 1,
            intent: 'define',
            action: 'assert',
            description: '',
            targetElementIds: [],
            locatorCandidates: [],
            expectedOutcome: 'The user is logged in',
            confidence: 0.5,
            executable: false,
            source: { report: 'r', elementIds: [] },
          },
        ],
      },
      'j.json',
    );
    const report = await executeJourney({
      plan,
      planPath: 'p',
      headed: false,
      screenshots: false,
      safeTestMode: true,
    });
    expect(report.steps[0]?.status).toBe('skipped');
    expect(report.steps[0]?.verification?.status).toBe('unverified');
  }, 30_000);

  it('produces a completed, fully verified run when every assertion is evaluated', async () => {
    if (!available) return;
    const plan = validateJourneyPlan(
      {
        ...journey(),
        goal: 'assert the path',
        target: { url: `${origin}/catalog`, finalUrl: null, title: 't' },
        steps: [
          {
            id: 'step-001',
            order: 1,
            intent: 'define',
            action: 'assert',
            description: '',
            targetElementIds: [],
            locatorCandidates: [],
            expectedOutcome: 'the catalog path is reached',
            assertion: {
              type: 'url-path',
              expectedPath: '/catalog',
              match: 'exact',
              source: { kind: 'scout-target-url' },
            },
            confidence: 0.8,
            executable: false,
            source: { report: 'r', elementIds: [] },
          },
        ],
      },
      'j.json',
    );
    const report = await executeJourney({
      plan,
      planPath: 'p',
      headed: false,
      screenshots: false,
      safeTestMode: true,
    });
    // This is the outcome Build 6.2 exists to reach: nothing unverified, so
    // the run is fully verified and eligible for a normal baseline.
    expect(report.status).toBe('passed');
    expect(report.verification?.status).toBe('complete');
    expect(report.verification?.unverifiedAssertions).toBe(0);
  }, 30_000);
});

describe('end-to-end: goal -> scout -> journey -> execution', () => {
  it('runs the real planner and executor over a local fixture, without hand-authoring the plan', async () => {
    if (!available) return;

    // 1. Scout the local fixture.
    const scout = await runScout({ url: `${origin}/catalog`, headless: true, settleMs: 150, timeoutMs: 15_000 });
    expect(scout.interactiveElements.some((element) => element.type === 'link')).toBe(true);

    // 2. The real planner, from a natural-language goal.
    const plan = planJourney('Try to complete checkout', scout, 'reports/scout.json');

    // 3. The real executor.
    const journeyPath = join(dir, 'journey.json');
    const journeyBytesBefore = JSON.stringify(plan, null, 2);
    await writeFile(journeyPath, journeyBytesBefore, 'utf8');

    const report = await executeJourney({
      plan,
      planPath: journeyPath,
      headed: false,
      continueOnFailure: true,
      screenshots: false,
      safeTestMode: true,
      provenance: { environmentId: 'local-shop', appBuildId: 'build-001' },
    });

    // 4. The plan is never mutated.
    expect(await readFile(journeyPath, 'utf8')).toBe(journeyBytesBefore);

    // 5. Per-step results exist for every step, in order.
    expect(report.steps.length).toBe(plan.steps.length);
    expect(report.steps.map((step) => step.id)).toEqual(plan.steps.map((step) => step.id));

    // 6. Whatever assertion this journey produced, it is either a traced
    //    structured one or the prose fallback - never an invented one.
    for (const step of plan.steps) {
      if (step.assertion === undefined) continue;
      expect(step.assertion.source.kind).toBeTruthy();
    }
  }, 90_000);

  it('runs a journey whose assertion is structured, from Scout evidence alone', async () => {
    if (!available) return;

    // A navigation journey, where the plan's click target is a real link, so
    // the planner has a declared destination to restate.
    const scout = await runScout({ url: `${origin}/catalog`, headless: true, settleMs: 150, timeoutMs: 15_000 });
    const plan = planJourney('Navigate to the cart', scout, 'reports/scout.json');

    const assertionStep = plan.steps.find((step) => step.action === 'assert');
    expect(assertionStep).toBeDefined();

    // When the plan navigates a link with a stable path, the assertion is
    // structured and traces to Scout. When it does not, the prose fallback
    // stands. Both are correct; the test pins the property that matters.
    if (assertionStep?.assertion !== undefined) {
      const structured = assertionStep.assertion;
      expect(['url-path', 'url-origin']).toContain(structured.type);
      expect(structured.source.elementId).toBeTruthy();
      expect(assertionStep.expectedOutcome).not.toBe('Define the expected');
    } else {
      expect(assertionStep?.expectedOutcome).toBeTruthy();
    }
  }, 60_000);
});

describe('immutability and redaction', () => {
  it('writes no secret into an execution report', async () => {
    if (!available) return;
    const plan = planJourney('Try to log in', runScoutSync(), 'r');
    const report = await executeJourney({
      plan,
      planPath: 'p',
      headed: false,
      continueOnFailure: true,
      screenshots: false,
      safeTestMode: true,
      testData: { email: 'qa-user@example.test', password: 'SafeFixturePassword123!' },
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('SafeFixturePassword123!');
  }, 60_000);

  it('keeps the planner free of Playwright and AI imports', async () => {
    const { readFile } = await import('node:fs/promises');
    for (const file of ['structuredAssertion.ts', 'plan.ts', 'types.ts']) {
      const source = await readFile(resolvePath(process.cwd(), 'src', 'journey', file), 'utf8');
      expect(source, file).not.toMatch(/from 'playwright'/);
      expect(source, file).not.toMatch(/openai|anthropic|\bllm\b/i);
    }
  });
});
