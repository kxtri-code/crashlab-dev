/**
 * Browser-backed executor tests.
 *
 * These launch a real Chromium against the local fixture server, so they cover
 * the behaviour that cannot be proven with pure functions: locator resolution
 * against a live DOM, action execution, evidence capture, redaction of a value
 * a page echoes back, and browser cleanup.
 *
 * No external site is contacted. They skip rather than fail when the Chromium
 * binary is missing.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { chromium } from 'playwright';
import { executeJourney } from '../../src/executor/executor.js';
import { validateJourneyPlan } from '../../src/executor/planValidator.js';
import { startFixtureServer, stopFixtureServer } from '../fixtures/server.js';
import { planWith, step } from '../fixtures/journeyPlans.js';
import type { ExecutionReport } from '../../src/executor/types.js';
import type { JourneyPlan, JourneyStep } from '../../src/journey/types.js';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

let server: Server;
let origin: string;
let available = false;

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
}, 60_000);

afterAll(async () => {
  if (server) await stopFixtureServer(server);
});

/** A locator for a fixture control by its test id. */
const testId = (id: string) => `page.getByTestId('${id}')`;

/** Build a validated plan against the fixture page. */
function buildPlan(steps: JourneyStep[]): JourneyPlan {
  return validateJourneyPlan(
    JSON.parse(
      JSON.stringify(
        planWith(steps, {
          goal: 'exercise the executor fixture',
          target: { url: `${origin}/executor`, finalUrl: null, title: 'Executor fixture' },
        }),
      ),
    ),
    'test.json',
  );
}

/** Execute a plan, returning null when no browser is installed. */
async function run(
  steps: JourneyStep[],
  options: { testData?: Record<string, string>; continueOnFailure?: boolean; safeTestMode?: boolean; screenshots?: boolean } = {},
): Promise<ExecutionReport | null> {
  if (!available) return null;
  return executeJourney({
    plan: buildPlan(steps),
    planPath: 'reports/journey.json',
    testData: options.testData,
    continueOnFailure: options.continueOnFailure,
    safeTestMode: options.safeTestMode,
    screenshots: options.screenshots ?? false,
    // Fixtures live under tests/fixtures, which is inside the repo root.
    evidenceDir: join(REPO_ROOT, 'evidence'),
  });
}

describe('executor: locating and observing', () => {
  it('identifies a unique control', async () => {
    const report = await run([
      step({ id: 'step-001', order: 1, action: 'identify', locatorCandidates: [testId('simple-button')] }),
    ]);
    if (!report) return;
    expect(report.steps[0]?.status).toBe('passed');
    expect(report.steps[0]?.selectedLocator).toBe(testId('simple-button'));
    expect(report.steps[0]?.observations?.exists).toBe(true);
    expect(report.steps[0]?.observations?.visible).toBe(true);
    expect(report.steps[0]?.observations?.enabled).toBe(true);
  });

  it('blocks a locator that matches nothing', async () => {
    const report = await run([
      step({ id: 'step-001', order: 1, action: 'observe', locatorCandidates: [testId('does-not-exist')] }),
    ]);
    if (!report) return;
    expect(report.steps[0]?.status).toBe('blocked');
    expect(report.steps[0]?.error?.reason).toBe('locator-not-found');
    expect(report.steps[0]?.error?.attemptedLocators).toEqual([testId('does-not-exist')]);
  });

  it('blocks an ambiguous locator rather than choosing one', async () => {
    const report = await run([
      // Both fixture buttons share a class, so this matches two elements.
      step({ id: 'step-001', order: 1, action: 'observe', locatorCandidates: ['.dup'] }),
    ]);
    if (!report) return;
    expect(report.steps[0]?.status).toBe('blocked');
    expect(report.steps[0]?.error?.reason).toBe('locator-ambiguous');
    expect(report.steps[0]?.error?.message).toMatch(/matched 2 elements/);
  });

  it('blocks a step with no locator candidates at all', async () => {
    const report = await run([step({ id: 'step-001', order: 1, action: 'observe', locatorCandidates: [] })]);
    if (!report) return;
    expect(report.steps[0]?.status).toBe('blocked');
    expect(report.steps[0]?.error?.reason).toBe('no-locator-provided');
  });

  it('blocks an unsupported locator form', async () => {
    const report = await run([
      step({ id: 'step-001', order: 1, action: 'observe', locatorCandidates: ['page.waitForTimeout(10)'] }),
    ]);
    if (!report) return;
    expect(report.steps[0]?.error?.reason).toBe('locator-unsupported');
  });

  it('tries candidates in order and uses the first that resolves', async () => {
    const report = await run([
      step({
        id: 'step-001',
        order: 1,
        action: 'identify',
        locatorCandidates: [testId('missing-first'), testId('simple-button')],
      }),
    ]);
    if (!report) return;
    expect(report.steps[0]?.status).toBe('passed');
    expect(report.steps[0]?.selectedLocator).toBe(testId('simple-button'));
  });

  it('observes a hidden control without interacting with it', async () => {
    const report = await run([
      step({ id: 'step-001', order: 1, action: 'observe', locatorCandidates: [testId('hidden-button')] }),
    ]);
    if (!report) return;
    // Observe reports presence without acting, so a hidden control still passes.
    expect(report.steps[0]?.status).toBe('passed');
    expect(report.steps[0]?.observations?.exists).toBe(true);
    expect(report.steps[0]?.observations?.visible).toBe(false);
  });

  it('refuses to interact with a hidden control', async () => {
    const report = await run([
      step({ id: 'step-001', order: 1, action: 'click', locatorCandidates: [testId('hidden-button')] }),
    ]);
    if (!report) return;
    expect(report.steps[0]?.status).toBe('blocked');
    expect(report.steps[0]?.error?.reason).toBe('element-hidden');
  });

  it('refuses to interact with a disabled control', async () => {
    const report = await run([
      step({ id: 'step-001', order: 1, action: 'click', locatorCandidates: [testId('disabled-button')] }),
    ]);
    if (!report) return;
    expect(report.steps[0]?.status).toBe('blocked');
    expect(report.steps[0]?.error?.reason).toBe('element-disabled');
  });
});

describe('executor: click', () => {
  it('clicks a button and records that the page changed', async () => {
    const report = await run([
      step({ id: 'step-001', order: 1, action: 'click', locatorCandidates: [testId('simple-button')] }),
      step({ id: 'step-002', order: 2, action: 'assert', locatorCandidates: ['#click-result'] }),
    ]);
    if (!report) return;
    expect(report.steps[0]?.status).toBe('passed');
    expect(report.steps[0]?.observations?.visible).toBe(true);
    expect(report.steps[1]?.status).toBe('passed');
  });

  it('records the URL before and after a click', async () => {
    const report = await run([
      step({ id: 'step-001', order: 1, action: 'click', locatorCandidates: [testId('simple-button')] }),
    ]);
    if (!report) return;
    expect(report.steps[0]?.urlBefore).toContain('/executor');
    expect(report.steps[0]?.urlAfter).toContain('/executor');
    expect(report.steps[0]?.evidence.pageChanged).toBe(false);
  });

  it('does not retry a failed click', async () => {
    // A control that vanishes mid-run cannot be re-found; the step is attempted
    // exactly once and the failure is recorded.
    const report = await run([
      step({ id: 'step-001', order: 1, action: 'click', locatorCandidates: [testId('nope')] }),
    ]);
    if (!report) return;
    expect(report.steps).toHaveLength(1);
    expect(report.executor.retries).toBe(0);
    expect(report.steps[0]?.status).toBe('blocked');
  });
});

describe('executor: fill', () => {
  it('fills a field from explicit test data', async () => {
    const report = await run(
      [
        step({ id: 'step-001', order: 1, intent: 'identify_username_field', action: 'fill', locatorCandidates: [testId('username')] }),
        step({ id: 'step-002', order: 2, action: 'assert', locatorCandidates: [testId('username')] }),
      ],
      { testData: { username: 'qa-user@example.test' } },
    );
    if (!report) return;
    expect(report.steps[0]?.status).toBe('passed');
    expect(report.steps[1]?.status).toBe('passed');
  });

  it('blocks a fill when no test data was supplied', async () => {
    const report = await run([
      step({ id: 'step-001', order: 1, intent: 'identify_password_field', action: 'fill', locatorCandidates: [testId('password')] }),
    ]);
    if (!report) return;
    expect(report.steps[0]?.status).toBe('blocked');
    expect(report.steps[0]?.error?.reason).toBe('missing-test-data');
    expect(report.steps[0]?.error?.message).toMatch(/does not invent a value/i);
  });

  it('blocks rather than substituting an empty value', async () => {
    const report = await run(
      [step({ id: 'step-001', order: 1, intent: 'identify_password_field', action: 'fill', locatorCandidates: [testId('password')] })],
      { testData: { email: 'a@b.test' } },
    );
    if (!report) return;
    // Unrelated data must not be substituted for a password field.
    expect(report.steps[0]?.status).toBe('blocked');
    expect(report.steps[0]?.error?.reason).toBe('missing-test-data');
  });
});

describe('executor: select', () => {
  it('selects an explicit option', async () => {
    const report = await run(
      [step({ id: 'step-001', order: 1, intent: 'identify_country_field', action: 'select', locatorCandidates: [testId('country')] })],
      { testData: { country: 'Germany' } },
    );
    if (!report) return;
    expect(report.steps[0]?.status).toBe('passed');
  });

  it('blocks rather than picking the first option', async () => {
    const report = await run([
      step({ id: 'step-001', order: 1, intent: 'identify_country_field', action: 'select', locatorCandidates: [testId('country')] }),
    ]);
    if (!report) return;
    expect(report.steps[0]?.status).toBe('blocked');
    expect(report.steps[0]?.error?.reason).toBe('missing-test-data');
    expect(report.steps[0]?.error?.message).toMatch(/not necessarily a valid choice/);
  });

  it('fails rather than guessing when the option does not exist', async () => {
    const report = await run(
      [step({ id: 'step-001', order: 1, intent: 'identify_country_field', action: 'select', locatorCandidates: [testId('country')] })],
      // A short budget: Playwright waits out the timeout for a label that is
      // not present, and the point of the test is the refusal, not the wait.
      { testData: { country: 'Atlantis' } },
    );
    if (!report) return;
    expect(report.steps[0]?.status).toBe('failed');
  }, 20_000);
});

describe('executor: upload', () => {
  it('blocks an upload with no test data', async () => {
    const report = await run([
      step({ id: 'step-001', order: 1, intent: 'identify_document_field', action: 'upload', locatorCandidates: [testId('document')] }),
    ]);
    if (!report) return;
    expect(report.steps[0]?.status).toBe('blocked');
    expect(report.steps[0]?.error?.reason).toBe('missing-test-data');
  });

  it('blocks an upload pointing outside the allowed fixture directory', async () => {
    const report = await run(
      [step({ id: 'step-001', order: 1, intent: 'identify_document_field', action: 'upload', locatorCandidates: [testId('document')] })],
      { testData: { file: join('..', '..', 'secrets.txt') } },
    );
    if (!report) return;
    expect(report.steps[0]?.status).toBe('blocked');
    expect(['unsafe-test-file', 'action-failed']).toContain(report.steps[0]?.error?.reason);
  });

  it('uploads a safe local fixture', async () => {
    const report = await run(
      [step({ id: 'step-001', order: 1, intent: 'identify_document_field', action: 'upload', locatorCandidates: [testId('document')] })],
      { testData: { file: 'tests/fixtures/upload-fixture.txt' } },
    );
    if (!report) return;
    expect(report.steps[0]?.status).toBe('passed');
  });
});

describe('executor: submit and payment safety', () => {
  it('submits a form', async () => {
    const report = await run(
      [
        step({ id: 'step-001', order: 1, intent: 'identify_email_field', action: 'fill', locatorCandidates: [testId('email')] }),
        step({ id: 'step-002', order: 2, action: 'submit', locatorCandidates: [testId('submit-signup')] }),
      ],
      { testData: { email: 'qa-user@example.test' } },
    );
    if (!report) return;
    expect(report.steps[1]?.status).toBe('passed');
    expect(report.status).toBe('passed');
  });

  it('blocks a payment-adjacent action by default', async () => {
    const report = await run([
      step({ id: 'step-001', order: 1, action: 'click', locatorCandidates: [testId('pay-now')] }),
    ]);
    if (!report) return;
    expect(report.steps[0]?.status).toBe('blocked');
    expect(report.steps[0]?.error?.reason).toBe('payment-blocked');
    expect(report.steps[0]?.error?.message).toMatch(/cannot verify the target is a sandbox/);
  });

  it('permits a payment-adjacent action in safe test mode', async () => {
    const report = await run(
      [step({ id: 'step-001', order: 1, action: 'click', locatorCandidates: [testId('pay-now')] })],
      { safeTestMode: true },
    );
    if (!report) return;
    expect(report.steps[0]?.status).toBe('passed');
    expect(report.executor.safeTestMode).toBe(true);
  });
});

describe('executor: origin policy', () => {
  it('blocks a navigation off the authorized origin', async () => {
    const report = await run([
      step({ id: 'step-001', order: 1, action: 'click', locatorCandidates: [testId('external-link')] }),
    ]);
    if (!report) return;
    expect(report.steps[0]?.status).toBe('blocked');
    expect(report.steps[0]?.error?.reason).toBe('external-origin-blocked');
  });

  it('navigates to the plan target when the step names no destination', async () => {
    // The journey's own target is a URL the plan represents, so it is a
    // legitimate destination rather than a missing one.
    const report = await run([step({ id: 'step-001', order: 1, action: 'navigate' })]);
    if (!report) return;
    expect(report.steps[0]?.status).toBe('passed');
    expect(report.steps[0]?.urlAfter).toContain('/executor');
  });

  it('does not derive a URL from free-text expected outcome', async () => {
    const report = await run([
      step({
        id: 'step-001',
        order: 1,
        action: 'navigate',
        expectedOutcome: 'The page should be at https://elsewhere.invalid/after-submit',
      }),
    ]);
    if (!report) return;
    // The free-text URL is not parsed; the step stays on the authorized target.
    expect(report.steps[0]?.status).toBe('passed');
    expect(report.steps[0]?.urlAfter).toContain('/executor');
    expect(report.steps[0]?.urlAfter).not.toContain('elsewhere.invalid');
  });

  it('blocks an explicit navigation to a different origin', async () => {
    const report = await run([
      step({ id: 'step-001', order: 1, action: 'navigate', locatorCandidates: ['https://elsewhere.invalid/after-submit'] }),
    ]);
    if (!report) return;
    expect(report.steps[0]?.status).toBe('blocked');
    expect(report.steps[0]?.error?.reason).toBe('external-origin-blocked');
  });
});

describe('executor: assert', () => {
  it('passes when the target is present', async () => {
    const report = await run([
      step({ id: 'step-001', order: 1, action: 'assert', locatorCandidates: [testId('simple-button')] }),
    ]);
    if (!report) return;
    expect(report.steps[0]?.status).toBe('passed');
  });

  it('fails when the target is absent', async () => {
    const report = await run([
      step({ id: 'step-001', order: 1, action: 'assert', locatorCandidates: [testId('missing')] }),
    ]);
    if (!report) return;
    expect(report.steps[0]?.status).toBe('failed');
  });

  it('blocks an assertion with nothing structural to check', async () => {
    const report = await run([
      step({
        id: 'step-001',
        order: 1,
        action: 'assert',
        expectedOutcome: 'The user should see a friendly confirmation message',
      }),
    ]);
    if (!report) return;
    expect(report.steps[0]?.status).toBe('blocked');
    expect(report.steps[0]?.error?.reason).toBe('unsupported-assertion');
    expect(report.steps[0]?.error?.message).toMatch(/does not interpret natural language/);
  });
});

describe('executor: control flow', () => {
  it('preserves step order', async () => {
    const report = await run([
      step({ id: 'step-001', order: 1, action: 'observe', locatorCandidates: [testId('simple-button')] }),
      step({ id: 'step-002', order: 2, action: 'observe', locatorCandidates: [testId('submit-signup')] }),
      step({ id: 'step-003', order: 3, action: 'observe', locatorCandidates: ['#click-result'] }),
    ]);
    if (!report) return;
    expect(report.steps.map((s) => s.id)).toEqual(['step-001', 'step-002', 'step-003']);
    expect(report.steps.map((s) => s.order)).toEqual([1, 2, 3]);
  });

  it('stops after a required failure and skips the rest', async () => {
    const report = await run([
      step({ id: 'step-001', order: 1, action: 'click', locatorCandidates: [testId('does-not-exist')] }),
      step({ id: 'step-002', order: 2, action: 'observe', locatorCandidates: [testId('simple-button')] }),
    ]);
    if (!report) return;
    expect(report.steps[0]?.status).toBe('blocked');
    expect(report.steps[1]?.status).toBe('skipped');
    expect(report.executor.stoppedOnFailure).toBe(true);
    expect(report.status).toBe('aborted');
  });

  it('continues past a failure when asked to', async () => {
    const report = await run(
      [
        step({ id: 'step-001', order: 1, action: 'click', locatorCandidates: [testId('does-not-exist')] }),
        step({ id: 'step-002', order: 2, action: 'observe', locatorCandidates: [testId('simple-button')] }),
      ],
      { continueOnFailure: true },
    );
    if (!report) return;
    expect(report.steps[0]?.status).toBe('blocked');
    expect(report.steps[1]?.status).toBe('passed');
    expect(report.executor.continueOnFailure).toBe(true);
  });

  it('never retries a step', async () => {
    const report = await run([
      step({ id: 'step-001', order: 1, action: 'click', locatorCandidates: [testId('missing')] }),
    ]);
    if (!report) return;
    expect(report.executor.retries).toBe(0);
    expect(report.steps).toHaveLength(1);
  });
});

describe('executor: evidence and redaction', () => {
  it('captures console messages, page errors and network events', async () => {
    const report = await run([
      step({ id: 'step-001', order: 1, action: 'observe', locatorCandidates: [testId('simple-button')] }),
    ]);
    if (!report) return;
    expect(report.rawEvidence.consoleEvents.length).toBeGreaterThan(0);
    expect(report.rawEvidence.pageErrors.length).toBeGreaterThan(0);
    expect(report.rawEvidence.networkEvents.length).toBeGreaterThan(0);
    expect(report.rawEvidence.consoleEvents.some((e) => e.type === 'warning')).toBe(true);
  });

  it('records network metadata without headers or bodies', async () => {
    const report = await run([
      step({ id: 'step-001', order: 1, action: 'observe', locatorCandidates: [testId('simple-button')] }),
    ]);
    if (!report) return;
    const serialized = JSON.stringify(report.rawEvidence.networkEvents);
    expect(serialized).not.toMatch(/authorization|cookie|set-cookie/i);
    for (const event of report.rawEvidence.networkEvents) {
      expect(event).toHaveProperty('method');
      expect(event).toHaveProperty('status');
      expect(event).not.toHaveProperty('headers');
      expect(event).not.toHaveProperty('body');
    }
  });

  it('redacts a password the page echoes back', async () => {
    // The fixture's submit handler writes the password into the DOM, which is
    // exactly the case a naive executor would leak.
    const secret = 'SafeFixturePassword123!';
    const report = await run(
      [
        step({ id: 'step-001', order: 1, intent: 'identify_password_field', action: 'fill', locatorCandidates: [testId('password')] }),
        step({ id: 'step-002', order: 2, action: 'submit', locatorCandidates: [testId('submit-signup')] }),
        step({ id: 'step-003', order: 3, action: 'observe', locatorCandidates: ['#submit-result'] }),
      ],
      { testData: { password: secret } },
    );
    if (!report) return;
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(secret);
    expect(report.redaction.sensitiveValuesRedacted).toBe(true);
    expect(report.redaction.redactedValueCount).toBeGreaterThan(0);
  });

  it('reports that data was provided without recording the values', async () => {
    const report = await run(
      [step({ id: 'step-001', order: 1, intent: 'identify_password_field', action: 'fill', locatorCandidates: [testId('password')] })],
      { testData: { password: 'SafeFixturePassword123!', email: 'qa@example.test' } },
    );
    if (!report) return;
    expect(report.redaction.dataProvided).toBe(true);
    expect(report.redaction.dataProvidedKeys).toContain('password');
    // A non-sensitive key is not advertised as a secret location.
    expect(report.redaction.dataProvidedKeys).not.toContain('email');
  });

  it('never uses bug vocabulary anywhere in the report', async () => {
    const report = await run([
      step({ id: 'step-001', order: 1, action: 'click', locatorCandidates: [testId('missing')] }),
    ]);
    if (!report) return;
    expect(JSON.stringify(report)).not.toMatch(/bugConfirmed|isBug|confirmed bug|defect confirmed/i);
  });

  it('captures screenshots when enabled', async () => {
    if (!available) return;
    const report = await executeJourney({
      plan: buildPlan([step({ id: 'step-001', order: 1, action: 'observe', locatorCandidates: [testId('simple-button')] })]),
      planPath: 'reports/journey.json',
      screenshots: true,
      evidenceDir: join(REPO_ROOT, 'evidence'),
    });
    expect(report.rawEvidence.screenshots.length).toBeGreaterThan(0);
    expect(report.rawEvidence.screenshots).toContain('initial.png');
    expect(report.rawEvidence.screenshots).toContain('final.png');
    // The files must actually exist on disk.
    for (const name of report.rawEvidence.screenshots) {
      const contents = await readFile(join(REPO_ROOT, 'evidence', name));
      expect(contents.length).toBeGreaterThan(0);
    }
  }, 30_000);

  it('captures no screenshots when disabled', async () => {
    const report = await run([step({ id: 'step-001', order: 1, action: 'observe', locatorCandidates: [testId('simple-button')] })]);
    if (!report) return;
    expect(report.rawEvidence.screenshots).toEqual([]);
  });
});

describe('executor: successful multi-step journey', () => {
  it('runs a full journey and writes a complete report', async () => {
    const report = await run([
      step({ id: 'step-001', order: 1, action: 'identify', locatorCandidates: [testId('submit-signup')] }),
      step({ id: 'step-002', order: 2, intent: 'identify_email_field', action: 'fill', locatorCandidates: [testId('email')] }),
      step({ id: 'step-003', order: 3, intent: 'identify_password_field', action: 'fill', locatorCandidates: [testId('password')] }),
      step({ id: 'step-004', order: 4, action: 'click', locatorCandidates: [testId('simple-button')] }),
      step({ id: 'step-005', order: 5, action: 'submit', locatorCandidates: [testId('submit-signup')] }),
      step({ id: 'step-006', order: 6, action: 'assert', locatorCandidates: ['#submit-result'] }),
    ], { testData: { email: 'qa-user@example.test', password: 'SafeFixturePassword123!' } });

    if (!report) return;
    expect(report.status).toBe('passed');
    expect(report.stepCounts).toEqual({ total: 6, passed: 6, failed: 0, blocked: 0, skipped: 0 });
    expect(report.steps.every((s) => s.durationMs >= 0)).toBe(true);
    expect(report.goal).toBe('exercise the executor fixture');
    expect(report.target.url).toContain('/executor');
  }, 60_000);
});
