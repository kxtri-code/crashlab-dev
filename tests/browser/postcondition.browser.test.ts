/**
 * Build 6.3 browser integration tests.
 *
 * The positive case runs the real planner over a real local form, executes the
 * generated journey, and shows the submit's postcondition matching. The negative
 * case shows a postcondition failing honestly rather than being laundered into
 * a success.
 *
 * No external website is contacted.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

import { runScout } from '../../src/scout/scout.js';
import { planJourney } from '../../src/journey/plan.js';
import { executeJourney } from '../../src/executor/executor.js';
import { validateJourneyPlan } from '../../src/executor/planValidator.js';
import { buildVerification, deriveExecutionStatus } from '../../src/executor/verification.js';
import { validateBaselineCandidate } from '../../src/baseline/validator.js';
import { buildAnomalyReport } from '../../src/anomaly/report.js';
import { startFixtureServer, stopFixtureServer } from '../fixtures/server.js';
import { journey } from '../fixtures/executionReports.js';
import type { ExecutionReport } from '../../src/executor/types.js';

let server: Server;
let origin: string;
let available = false;
let dir: string;

const TEST_DATA = {
  name: 'QA User',
  email: 'qa@example.test',
  message: 'A test message for the postcondition fixture.',
  password: 'SafeFixturePassword123!',
};

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
  dir = await mkdtemp(join(tmpdir(), 'crashlab-b63-'));
}, 60_000);

afterAll(async () => {
  if (server) await stopFixtureServer(server);
  if (dir) await rm(dir, { recursive: true, force: true });
});

/** Execute a plan against the local fixture. */
async function run(
  plan: Parameters<typeof executeJourney>[0]['plan'],
  options: { continueOnFailure?: boolean } = {},
): Promise<ExecutionReport> {
  return executeJourney({
    plan,
    planPath: 'journey.json',
    headed: false,
    continueOnFailure: options.continueOnFailure ?? true,
    screenshots: false,
    safeTestMode: true,
    testData: TEST_DATA,
  });
}

describe('planner derives a postcondition from a form action', () => {
  it('attaches a url-path postcondition to the submit step, traced to Scout', async () => {
    if (!available) return;
    const scout = await runScout({ url: `${origin}/contact`, headless: true, settleMs: 150, timeoutMs: 15_000 });
    const plan = planJourney('Submit the form', scout, 'reports/scout.json');

    const submitStep = plan.steps.find((step) => step.action === 'submit');
    expect(submitStep, 'the plan should contain a submit step').toBeDefined();
    expect(submitStep?.postconditions).toHaveLength(1);

    const postcondition = submitStep?.postconditions?.[0];
    expect(postcondition?.type).toBe('url-path');
    expect(postcondition?.type === 'url-path' ? postcondition.expectedPath : null).toBe('/thank-you');
    // Traceable to the form the action came from.
    expect(postcondition?.source.kind).toBe('scout-form-action');
    expect(postcondition?.source.elementId).toBe('contact-form');
  }, 60_000);

  it('is deterministic for the same goal and Scout report', async () => {
    if (!available) return;
    const scout = await runScout({ url: `${origin}/contact`, headless: true, settleMs: 150, timeoutMs: 15_000 });
    const first = JSON.stringify(planJourney('Submit the form', scout, 'r'), null, 2);
    for (let i = 0; i < 3; i++) {
      expect(JSON.stringify(planJourney('Submit the form', scout, 'r'), null, 2)).toBe(first);
    }
  }, 60_000);

  it('never derives a postcondition for a payment, cross-origin or dynamic destination', async () => {
    if (!available) return;
    const scout = await runScout({ url: `${origin}/contact`, headless: true, settleMs: 150, timeoutMs: 15_000 });
    const { deriveFormPostcondition } = await import('../../src/journey/postcondition.js');

    const byId = new Map(scout.forms.map((form) => [form.id, form]));
    // The fixture deliberately contains one of each unsafe shape.
    expect(deriveFormPostcondition(byId.get('payment-form')!, 'payment-form', scout.target.inputUrl).kind).toBe('declined');
    expect(deriveFormPostcondition(byId.get('external-form')!, 'external-form', scout.target.inputUrl).kind).toBe('declined');
    expect(deriveFormPostcondition(byId.get('order-form')!, 'order-form', scout.target.inputUrl).kind).toBe('declined');
    expect(deriveFormPostcondition(byId.get('js-form')!, 'js-form', scout.target.inputUrl).kind).toBe('declined');
    // Only the safe one generates.
    expect(deriveFormPostcondition(byId.get('contact-form')!, 'contact-form', scout.target.inputUrl).kind).toBe('generated');
  }, 60_000);
});

describe('positive integration: postcondition matches', () => {
  it('submits the form, matches its declared destination, and leaves no unverified assertion', async () => {
    if (!available) return;

    const scout = await runScout({ url: `${origin}/contact`, headless: true, settleMs: 150, timeoutMs: 15_000 });
    const plan = planJourney('Submit the form', scout, 'reports/scout.json');

    const journeyPath = join(dir, 'journey.json');
    const bytesBefore = `${JSON.stringify(plan, null, 2)}\n`;
    await writeFile(journeyPath, bytesBefore, 'utf8');

    const report = await run(plan);

    // The journey is never rewritten by execution.
    expect(await readFile(journeyPath, 'utf8')).toBe(bytesBefore);

    const submitStep = report.steps.find((step) => step.action === 'submit');
    expect(submitStep, 'the generated plan should have run a submit').toBeDefined();
    expect(submitStep?.status).toBe('passed');
    expect(submitStep?.postconditions?.[0]?.result).toBe('matched');
    expect(submitStep?.postconditions?.[0]?.actualPath).toBe('/thank-you');

    // A matched postcondition is a navigation claim, never a business-success
    // claim. The wording says so.
    expect(submitStep?.error).toBeNull();
  }, 90_000);

  it('produces a report with no secret from the submitted data', async () => {
    if (!available) return;
    const scout = await runScout({ url: `${origin}/contact`, headless: true, settleMs: 150, timeoutMs: 15_000 });
    const report = await run(planJourney('Submit the form', scout, 'r'));
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(TEST_DATA.password);
    expect(serialized).not.toContain('SafeFixturePassword123!');
  }, 90_000);

  it('records the postcondition on the step, and the anomaly engine adds no duplicate for it', async () => {
    if (!available) return;
    const scout = await runScout({ url: `${origin}/contact`, headless: true, settleMs: 150, timeoutMs: 15_000 });
    const plan = planJourney('Submit the form', scout, 'r');
    const report = await run(plan);

    const submitStep = report.steps.find((step) => step.action === 'submit');
    expect(submitStep?.postconditions).toHaveLength(1);

    // A matched postcondition is an observation on the step. Feeding the run
    // through the anomaly engine must not invent a second signal for it.
    const anomalies = buildAnomalyReport({
      execution: report,
      journey: plan,
      executionPath: 'execution.json',
      journeyPath: 'journey.json',
    });
    const stepSignals = anomalies.anomalies.filter((signal) => signal.stepId === submitStep?.id);
    expect(stepSignals).toEqual([]);
  }, 90_000);
});

describe('negative integration: postcondition does not match', () => {
  /** A plan whose form declares a destination the page will not reach. */
  function mismatchedPlan(targetUrl: string) {
    return validateJourneyPlan(
      {
        ...journey(),
        goal: 'Submit the form',
        // A `checkout` journey makes the payment guard fire before the
        // postcondition would even be reached, so this plan states the type it
        // actually is.
        journeyType: 'form_submission',
        target: { url: targetUrl, finalUrl: null, title: 'Contact' },
        steps: [
          {
            id: 'step-001',
            order: 1,
            intent: 'identify_submit_control',
            action: 'submit',
            description: 'Submit the contact form',
            targetElementIds: ['element-001'],
            locatorCandidates: ["page.getByTestId('send')"],
            // The form actually goes to /thank-you; this claims otherwise.
            postconditions: [
              {
                type: 'url-path',
                expectedPath: '/somewhere-else',
                match: 'exact',
                source: { kind: 'scout-form-action', elementId: 'contact-form', field: 'action' },
              },
            ],
            expectedOutcome: 'The form destination is reached',
            confidence: 0.8,
            executable: false,
            source: { report: 'r', elementIds: ['element-001'] },
          },
        ],
      },
      'j.json',
    );
  }

  it('fails honestly and does not confirm a bug', async () => {
    if (!available) return;
    const report = await run(mismatchedPlan(`${origin}/contact`));

    const submitStep = report.steps[0];
    expect(submitStep?.status).toBe('failed');
    expect(submitStep?.postconditions?.[0]?.result).toBe('not-matched');
    expect(submitStep?.postconditions?.[0]?.actualPath).toBe('/thank-you');
    // A real result, and nothing more than that.
    expect(submitStep?.error?.message).toMatch(/not reached/);
    expect(submitStep?.error?.message).not.toMatch(/bug|defect/i);
  }, 60_000);

  it('keeps verification out of complete', async () => {
    if (!available) return;
    const report = await run(mismatchedPlan(`${origin}/contact`));
    expect(report.verification?.status).toBe('incomplete');
    expect(report.verification?.complete).toBe(false);
    expect(deriveExecutionStatus(report.steps, false)).toBe('failed');
  }, 60_000);

  it('cannot become a fully verified baseline', async () => {
    if (!available) return;
    const report = await run(mismatchedPlan(`${origin}/contact`));
    const scout = await runScout({ url: `${origin}/contact`, headless: true, settleMs: 150, timeoutMs: 15_000 });
    const anomalies = buildAnomalyReport({
      execution: report,
      journey: planJourney('Submit the form', scout, 'r'),
      executionPath: 'execution.json',
      journeyPath: 'journey.json',
    });

    const validation = validateBaselineCandidate({
      execution: report,
      anomalies,
      journey: planJourney('Submit the form', scout, 'r'),
      acceptedSignalIds: [],
      // Even with the operator's allowance, a failed run is refused.
      allowUnverifiedAssertions: true,
    });
    expect(validation.safe).toBe(false);
    expect(validation.blockers.join(' ')).toMatch(/failed/i);
  }, 90_000);
});

describe('unevaluable postconditions', () => {
  it('stays unverified rather than failing', async () => {
    // An unresolvable URL leaves the executor on an error page, so the
    // destination cannot be read. That is not a failure.
    const verification = buildVerification(
      [
        {
          id: 'step-001',
          order: 1,
          intent: 'x',
          action: 'submit',
          status: 'skipped',
          startedAt: '2026-01-01T00:00:00.000Z',
          finishedAt: '2026-01-01T00:00:00.100Z',
          durationMs: 100,
          selectedLocator: null,
          targetElementIds: [],
          urlBefore: null,
          urlAfter: null,
          observations: null,
          evidence: {
            screenshot: null,
            screenshotOmitted: true,
            screenshotOmittedReason: 'screenshots-disabled',
            consoleEvents: [],
            pageErrors: [],
            networkEvents: [],
            dialogObserved: false,
            pageChanged: false,
          },
          error: null,
          description: '',
          planConfidence: 0.8,
          skipReason: 'unsupported-prose-assertion',
          verification: { status: 'unverified', reason: 'postcondition-unevaluable' },
          assertion: null,
          postconditions: [
            { type: 'url-path', status: 'unverified', result: 'unevaluable', reason: 'URL unreadable' },
          ],
        },
      ],
      false,
    );
    // Unevaluable is not "checked and wrong", so it cannot read as complete.
    expect(verification.complete).toBe(false);
    expect(verification.unverifiedAssertions).toBe(1);
  });
});

describe('safety controls are unchanged', () => {
  it('still blocks a payment submit before any browser interaction', async () => {
    if (!available) return;
    const scout = await runScout({ url: `${origin}/contact`, headless: true, settleMs: 150, timeoutMs: 15_000 });
    const plan = planJourney('Submit the form', scout, 'r');

    // Point the plan at the payment form and give it a payment postcondition,
    // to prove the guard runs before the postcondition would.
    const paymentPlan = validateJourneyPlan(
      {
        ...plan,
        target: { url: `${origin}/contact`, finalUrl: null, title: 'Contact' },        steps: [
          {
            id: 'step-001',
            order: 1,
            intent: 'submit_payment',
            action: 'submit',
            description: 'Pay now',
            targetElementIds: ['element-001'],
            locatorCandidates: ["page.getByTestId('pay')"],
            postconditions: [
              {
                type: 'url-path',
                expectedPath: '/payment-success',
                match: 'exact',
                source: { kind: 'scout-form-action', elementId: 'payment-form', field: 'action' },
              },
            ],
            expectedOutcome: 'Payment submitted',
            confidence: 0.9,
            executable: false,
            source: { report: 'r', elementIds: ['element-001'] },
          },
        ],
      },
      'j.json',
    );

    const report = await run(paymentPlan);
    const step = report.steps[0];
    // The payment guard refuses, so no postcondition is ever evaluated and no
    // navigation occurs.
    expect(step?.status).toBe('blocked');
    expect(step?.error?.reason).toBe('payment-blocked');
    expect(step?.postconditions).toBeNull();
  }, 60_000);

  it('does not follow a cross-origin submit off the authorized target', async () => {
    if (!available) return;
    const crossOriginPlan = validateJourneyPlan(
      {
        ...journey(),
        journeyType: 'form_submission',
        target: { url: `${origin}/contact`, finalUrl: null, title: 'Contact' },
        steps: [
          {
            id: 'step-001',
            order: 1,
            intent: 'submit_external',
            action: 'submit',
            description: 'Subscribe',
            targetElementIds: ['element-001'],
            locatorCandidates: ["page.getByTestId('send-external')"],
            expectedOutcome: 'Subscribed',
            confidence: 0.8,
            executable: false,
            source: { report: 'r', elementIds: ['element-001'] },
          },
        ],
      },
      'j.json',
    );
    const report = await run(crossOriginPlan);
    // The destination host does not resolve, so the page stays on the
    // authorized origin. The guarantee that matters is the one the executor
    // can actually keep: the run never ends up somewhere else.
    expect(report.target.finalUrl).toBe(`${origin}/contact`);
    expect(report.steps[0]?.urlAfter).not.toMatch(/external\.invalid/);
  }, 60_000);

  it('still blocks a fill with no test data', async () => {
    if (!available) return;
    const scout = await runScout({ url: `${origin}/contact`, headless: true, settleMs: 150, timeoutMs: 15_000 });
    const plan = planJourney('Submit the form', scout, 'r');

    const report = await executeJourney({
      plan,
      planPath: 'j',
      headed: false,
      continueOnFailure: true,
      screenshots: false,
      safeTestMode: true,
      // No test data at all.
    });
    // The run still completes; the fills that needed data are blocked, and the
    // submit postcondition is unaffected by the missing data.
    expect(report.steps.some((step) => step.error?.reason === 'missing-test-data')).toBe(true);
  }, 60_000);
});
