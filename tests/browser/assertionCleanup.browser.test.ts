/**
 * Build 6.4 browser integration tests.
 *
 * The positive case shows a generated form journey reaching full verification
 * because the redundant placeholder was removed. The negative case shows a
 * journey with no declared destination keeping its prose fallback and remaining
 * honestly partial.
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
import { buildAnomalyReport } from '../../src/anomaly/report.js';
import { validateBaselineCandidate } from '../../src/baseline/validator.js';
import { startFixtureServer, stopFixtureServer } from '../fixtures/server.js';
import type { JourneyPlan } from '../../src/journey/types.js';

let server: Server;
let origin: string;
let available = false;
let dir: string;

const TEST_DATA = {
  name: 'QA User',
  email: 'qa@example.test',
  message: 'A test message.',
  username: 'qa@example.test',
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
  dir = await mkdtemp(join(tmpdir(), 'crashlab-b64-'));
}, 60_000);

afterAll(async () => {
  if (server) await stopFixtureServer(server);
  if (dir) await rm(dir, { recursive: true, force: true });
});

/** Run a plan with the fixture's test data. */
async function run(plan: JourneyPlan) {
  return executeJourney({
    plan,
    planPath: 'journey.json',
    headed: false,
    continueOnFailure: true,
    screenshots: false,
    safeTestMode: true,
    testData: TEST_DATA,
  });
}

describe('generated form journey reaches full verification', () => {
  it('derives a postcondition, drops the redundant placeholder, and verifies', async () => {
    if (!available) return;

    const scout = await runScout({ url: `${origin}/contact`, headless: true, settleMs: 150, timeoutMs: 15_000 });
    const plan = planJourney('Submit the form', scout, 'reports/scout.json');

    // A structured postcondition exists, on the submit step.
    const submitStep = plan.steps.find((step) => step.action === 'submit');
    expect(submitStep?.postconditions).toHaveLength(1);

    // No generic terminal placeholder survives.
    const remainingAsserts = plan.steps.filter((step) => step.action === 'assert');
    expect(remainingAsserts).toEqual([]);

    // The plan says plainly what it removed and why.
    expect(plan.assumptions.join(' ')).toMatch(/Removed a generic terminal assertion/);

    // The surviving step's wording describes navigation, not business success.
    const outcome = submitStep?.expectedOutcome.toLowerCase() ?? '';
    expect(outcome).toContain('/thank-you');
    for (const forbidden of ['payment', 'order completed', 'account created', 'email sent']) {
      expect(outcome, forbidden).not.toContain(forbidden);
    }
  }, 60_000);

  it('produces a fully verified run with no unverified assertion', async () => {
    if (!available) return;
    const scout = await runScout({ url: `${origin}/contact`, headless: true, settleMs: 150, timeoutMs: 15_000 });
    const report = await run(planJourney('Submit the form', scout, 'r'));

    expect(report.status).toBe('passed');
    expect(report.verification?.complete).toBe(true);
    expect(report.verification?.unverifiedAssertions).toBe(0);
    // The postcondition genuinely matched.
    const submitStep = report.steps.find((step) => step.action === 'submit');
    expect(submitStep?.postconditions?.[0]?.result).toBe('matched');
  }, 90_000);

  it('is eligible for a fully verified baseline with no allowance flag', async () => {
    if (!available) return;
    const scout = await runScout({ url: `${origin}/contact`, headless: true, settleMs: 150, timeoutMs: 15_000 });
    const plan = planJourney('Submit the form', scout, 'r');
    const report = await run(plan);

    const anomalies = buildAnomalyReport({
      execution: report,
      journey: plan,
      executionPath: 'execution.json',
      journeyPath: 'journey.json',
    });

    const validation = validateBaselineCandidate({
      execution: report,
      anomalies,
      journey: plan,
      acceptedSignalIds: [],
      // Deliberately not passing --allow-unverified-assertions.
    });
    expect(validation.safe).toBe(true);
    expect(validation.partial).toBe(false);
  }, 90_000);

  it('leaves journey.json byte-identical', async () => {
    if (!available) return;
    const scout = await runScout({ url: `${origin}/contact`, headless: true, settleMs: 150, timeoutMs: 15_000 });
    const plan = planJourney('Submit the form', scout, 'r');

    const path = join(dir, 'journey.json');
    const before = `${JSON.stringify(plan, null, 2)}\n`;
    await writeFile(path, before, 'utf8');

    await run(plan);

    expect(await readFile(path, 'utf8')).toBe(before);
  }, 90_000);

  it('is deterministic across repeated planning', async () => {
    if (!available) return;
    const scout = await runScout({ url: `${origin}/contact`, headless: true, settleMs: 150, timeoutMs: 15_000 });
    const first = JSON.stringify(planJourney('Submit the form', scout, 'r'), null, 2);
    for (let i = 0; i < 3; i++) {
      expect(JSON.stringify(planJourney('Submit the form', scout, 'r'), null, 2)).toBe(first);
    }
  }, 90_000);

  it('writes no secret into the report', async () => {
    if (!available) return;
    const scout = await runScout({ url: `${origin}/contact`, headless: true, settleMs: 150, timeoutMs: 15_000 });
    const report = await run(planJourney('Submit the form', scout, 'r'));
    expect(JSON.stringify(report)).not.toContain(TEST_DATA.password);
  }, 90_000);
});

describe('negative case: no safe destination keeps the prose fallback', () => {
  it('retains the terminal expectation and stays partial', async () => {
    if (!available) return;

    // A login form declares no destination, so nothing can cover its outcome.
    const scout = await runScout({ url: `${origin}/contact`, headless: true, settleMs: 150, timeoutMs: 15_000 });
    const plan = planJourney('Try to log in', scout, 'r');

    const asserts = plan.steps.filter((step) => step.action === 'assert');
    expect(asserts.length).toBeGreaterThan(0);
    expect(asserts[0]?.expectedOutcome.length).toBeGreaterThan(0);

    // The plan says why it kept it.
    expect(plan.assumptions.join(' ')).toMatch(/Kept the terminal expectation/);

    const report = await run(plan);
    expect(report.verification?.complete).toBe(false);
    expect(report.verification?.unverifiedAssertions).toBeGreaterThan(0);
    // Partial is honest, not a failure.
    expect(report.status).not.toBe('failed');
  }, 90_000);

  it('does not remove an assertion for a form whose destination was refused', async () => {
    if (!available) return;
    const { deriveFormPostcondition } = await import('../../src/journey/postcondition.js');
    const scout = await runScout({ url: `${origin}/contact`, headless: true, settleMs: 150, timeoutMs: 15_000 });

    // The payment, cross-origin and dynamic-id forms all refuse, so a plan
    // built around one must keep its expectation.
    const byId = new Map(scout.forms.map((form) => [form.id, form]));
    for (const id of ['payment-form', 'external-form', 'order-form', 'js-form']) {
      const generation = deriveFormPostcondition(byId.get(id)!, id, scout.target.inputUrl);
      expect(generation.kind, id).toBe('declined');
    }
  }, 60_000);

  it('still requires the allowance flag for a partial run', async () => {
    if (!available) return;
    const scout = await runScout({ url: `${origin}/contact`, headless: true, settleMs: 150, timeoutMs: 15_000 });
    const plan = planJourney('Try to log in', scout, 'r');
    const report = await run(plan);
    const anomalies = buildAnomalyReport({
      execution: report,
      journey: plan,
      executionPath: 'execution.json',
      journeyPath: 'journey.json',
    });

    const without = validateBaselineCandidate({
      execution: report,
      anomalies,
      journey: plan,
      acceptedSignalIds: [],
    });
    expect(without.safe).toBe(false);
    expect(without.blockers.join(' ')).toMatch(/--allow-unverified-assertions/);
  }, 90_000);
});

describe('safety and failure behaviour is unchanged', () => {
  it('does not hide a failed postcondition behind a removed assertion', async () => {
    if (!available) return;
    const { validateJourneyPlan } = await import('../../src/executor/planValidator.js');
    const { journey } = await import('../fixtures/executionReports.js');

    const plan = validateJourneyPlan(
      {
        ...journey(),
        goal: 'Submit the form',
        journeyType: 'form_submission',
        target: { url: `${origin}/contact`, finalUrl: null, title: 'Contact' },
        steps: [
          {
            id: 'step-001',
            order: 1,
            intent: 'identify_submit_control',
            action: 'submit',
            description: 'Submit the contact form',
            targetElementIds: ['element-001'],
            locatorCandidates: ["page.getByTestId('send')"],
            postconditions: [
              {
                type: 'url-path',
                expectedPath: '/somewhere-else',
                match: 'exact',
                source: { kind: 'scout-form-action', elementId: 'contact-form', field: 'action' },
              },
            ],
            expectedOutcome: 'The page reaches the declared path /somewhere-else.',
            confidence: 0.8,
            executable: false,
            source: { report: 'r', elementIds: ['element-001'] },
          },
        ],
      },
      'j.json',
    );

    const report = await run(plan);
    // The failure stands on its own. No placeholder was there to hide it, and
    // none was added.
    expect(report.steps[0]?.status).toBe('failed');
    expect(report.steps[0]?.postconditions?.[0]?.result).toBe('not-matched');
    expect(report.verification?.complete).toBe(false);
  }, 90_000);

  it('keeps the payment guard ahead of any postcondition', async () => {
    if (!available) return;
    const { validateJourneyPlan } = await import('../../src/executor/planValidator.js');
    const { journey } = await import('../fixtures/executionReports.js');

    const plan = validateJourneyPlan(
      {
        ...journey(),
        goal: 'Pay now',
        journeyType: 'checkout',
        target: { url: `${origin}/contact`, finalUrl: null, title: 'Contact' },
        steps: [
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
            expectedOutcome: 'The page reaches the declared path /payment-success.',
            confidence: 0.9,
            executable: false,
            source: { report: 'r', elementIds: ['element-001'] },
          },
        ],
      },
      'j.json',
    );

    const report = await run(plan);
    expect(report.steps[0]?.status).toBe('blocked');
    expect(report.steps[0]?.error?.reason).toBe('payment-blocked');
    // The postcondition never ran, so no navigation claim was made.
    expect(report.steps[0]?.postconditions).toBeNull();
  }, 90_000);

  it('keeps a legacy plan with a prose assertion working', async () => {
    if (!available) return;
    const { validateJourneyPlan } = await import('../../src/executor/planValidator.js');
    const { journey } = await import('../fixtures/executionReports.js');

    const plan = validateJourneyPlan(
      {
        ...journey(),
        goal: 'Submit the form',
        journeyType: 'form_submission',
        target: { url: `${origin}/contact`, finalUrl: null, title: 'Contact' },
        steps: [
          {
            id: 'step-001',
            order: 1,
            intent: 'define_form_success',
            action: 'assert',
            description: 'Define the expected successful outcome',
            targetElementIds: [],
            locatorCandidates: [],
            expectedOutcome: 'The expected confirmation text was not found in the Scout report.',
            confidence: 0.5,
            executable: false,
            source: { report: 'r', elementIds: [] },
          },
        ],
      },
      'j.json',
    );

    const report = await run(plan);
    // Exactly the Build 6.1 behaviour, unchanged.
    expect(report.steps[0]?.status).toBe('skipped');
    expect(report.steps[0]?.verification?.status).toBe('unverified');
    expect(report.verification?.status).toBe('partial');
  }, 90_000);
});
