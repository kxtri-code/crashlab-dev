/**
 * Build 6.5 browser integration tests.
 *
 * Exercises operator-declared expectations against a real JavaScript/fetch-driven
 * form in a live browser. Verifies:
 *  - Scout cannot derive a destination for a JS-driven form (no action attribute).
 *  - Operator declares an expectation with source: "operator-declared".
 *  - Valid expectation evaluates against live navigation and matches.
 *  - Verification coverage is stamped "operator-declared", never "full-plan".
 *  - Expectation file hash is recorded on execution report.
 *  - Failed expectation is an observation of a failed check, never a confirmed bug.
 *  - Unsafe / malformed expectation input is rejected before browser launch.
 *  - Journey plan remains immutable.
 *
 * No external website is contacted; uses the local fixture server.
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
import { journeyHash } from '../../src/baseline/identity.js';
import {
  EXPECTATIONS_SCHEMA_VERSION,
  OPERATOR_DECLARED_SOURCE,
  hashExpectationsFile,
  loadExpectationsFile,
  type ExpectationsFile,
} from '../../src/executor/expectations.js';
import { buildAnomalyReport } from '../../src/anomaly/report.js';
import { validateBaselineCandidate } from '../../src/baseline/validator.js';
import { buildBaseline } from '../../src/baseline/writer.js';
import { startFixtureServer, stopFixtureServer } from '../fixtures/server.js';
import type { ExecutionReport } from '../../src/executor/types.js';

let server: Server;
let origin: string;
let available = false;
let dir: string;

beforeAll(async () => {
  try {
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    available = true;
  } catch {
    available = false;
  }
  const started = await startFixtureServer();
  server = started.server;
  origin = started.origin;
  dir = await mkdtemp(join(tmpdir(), 'crashlab-b65-browser-'));
}, 60_000);

afterAll(async () => {
  if (server) await stopFixtureServer(server);
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('Build 6.5: Scout and planner on JavaScript/fetch form', () => {
  it('Scout observes no form destination and planner derives no postcondition', async () => {
    if (!available) return;

    const scout = await runScout({ url: `${origin}/spa-form`, headless: true, settleMs: 150, timeoutMs: 15_000 });
    const plan = planJourney('Submit the form', scout, 'reports/scout.json');

    // The form has no action attribute, so Scout captures null/empty action.
    const form = scout.forms.find((f) => f.id === 'spa-form');
    expect(form).toBeDefined();
    expect(form?.action).toBeNull();

    // The planner cannot derive any form postcondition for this step.
    for (const step of plan.steps) {
      expect(step.postconditions ?? []).toHaveLength(0);
    }
  }, 60_000);
});

describe('Build 6.5 positive integration: operator-declared expectation matches', () => {
  it('evaluates operator expectation against JS navigation, stamps operator-declared coverage, and preserves immutability', async () => {
    if (!available) return;

    const scout = await runScout({ url: `${origin}/spa-form`, headless: true, settleMs: 150, timeoutMs: 15_000 });
    const rawPlan = planJourney('Submit the form', scout, 'reports/scout.json');
    // Remove placeholder assert steps so we test the executable form flow with declared expectations
    const plan = {
      ...rawPlan,
      steps: rawPlan.steps.filter((s) => s.action !== 'assert' && s.targetElementIds.length > 0),
    };

    const submitStep = plan.steps.find((s) => s.action === 'submit' || s.action === 'click');
    expect(submitStep, 'plan should have an expectation-bearing action step').toBeDefined();

    const planHash = journeyHash(plan);
    const expectations: ExpectationsFile = {
      schemaVersion: EXPECTATIONS_SCHEMA_VERSION,
      journeyPlanHash: planHash,
      expectations: [
        {
          id: 'exp-001',
          afterStepId: submitStep!.id,
          type: 'url-path',
          expectedPath: '/thank-you',
          match: 'exact',
          source: OPERATOR_DECLARED_SOURCE,
          reason: 'SPA form submits via JS and redirects to /thank-you',
        },
      ],
    };

    const journeyPath = join(dir, 'journey-positive.json');
    const bytesBefore = `${JSON.stringify(plan, null, 2)}\n`;
    await writeFile(journeyPath, bytesBefore, 'utf8');

    const report: ExecutionReport = await executeJourney({
      plan,
      planPath: journeyPath,
      headed: false,
      continueOnFailure: true,
      screenshots: false,
      safeTestMode: true,
      testData: { query: 'test search' },
      expectations,
    });

    // 1. The journey plan is completely immutable on disk.
    expect(await readFile(journeyPath, 'utf8')).toBe(bytesBefore);

    // 2. The submit step ran and evaluated the expectation.
    const executedStep = report.steps.find((s) => s.id === submitStep!.id);
    expect(executedStep).toBeDefined();
    expect(executedStep?.status).toBe('passed');
    expect(executedStep?.expectationResults).toHaveLength(1);
    expect(executedStep?.expectationResults?.[0]?.result).toBe('matched');
    expect(executedStep?.expectationResults?.[0]?.actualPath).toBe('/thank-you');

    // 3. The verification coverage is 'operator-declared', NOT 'full-plan'.
    expect(report.verification?.status).toBe('complete');
    expect(report.verification?.coverage).toBe('operator-declared');

    // 4. The expectation file hash is recorded on the execution report.
    expect(report.expectationFileHash).toBe(hashExpectationsFile(expectations));

    // 5. Baseline candidate requires --allow-declared-expectations.
    const anomalies = buildAnomalyReport({
      execution: report,
      journey: plan,
      executionPath: 'execution.json',
      journeyPath: journeyPath,
    });

    const validationWithoutFlag = validateBaselineCandidate({
      execution: report,
      anomalies,
      journey: plan,
      acceptedSignalIds: [],
      allowDeclaredExpectations: false,
    });
    expect(validationWithoutFlag.safe).toBe(false);
    expect(validationWithoutFlag.blockers.some((b) => b.includes('operator-declared'))).toBe(true);

    const validationWithFlag = validateBaselineCandidate({
      execution: report,
      anomalies,
      journey: plan,
      acceptedSignalIds: [],
      allowDeclaredExpectations: true,
    });
    expect(validationWithFlag.safe).toBe(true);

    // 6. Baseline status is known-good-declared.
    const baseline = buildBaseline({
      baselineId: 'spa-baseline-001',
      name: 'SPA Baseline',
      execution: report,
      anomalies,
      journey: plan,
      acceptedSignalIds: [],
      confirmedBy: 'tester',
      paths: { execution: 'execution.json', anomalies: 'anomalies.json', journey: 'journey.json' },
      allowDeclaredExpectations: true,
    });
    expect(baseline.status).toBe('known-good-declared');
    expect(baseline.verification.coverage).toBe('operator-declared');
  }, 90_000);
});

describe('Build 6.5 negative integration: failed expectation does not become confirmed bug', () => {
  it('records not-matched observation and never confirms an automatic bug', async () => {
    if (!available) return;

    const scout = await runScout({ url: `${origin}/spa-form`, headless: true, settleMs: 150, timeoutMs: 15_000 });
    const rawPlan = planJourney('Submit the form', scout, 'reports/scout.json');
    const plan = {
      ...rawPlan,
      steps: rawPlan.steps.filter((s) => s.action !== 'assert'),
    };

    const submitStep = plan.steps.find((s) => s.action === 'submit' || s.action === 'click');
    expect(submitStep).toBeDefined();

    const planHash = journeyHash(plan);
    // Deliberately wrong path
    const expectations: ExpectationsFile = {
      schemaVersion: EXPECTATIONS_SCHEMA_VERSION,
      journeyPlanHash: planHash,
      expectations: [
        {
          id: 'exp-002',
          afterStepId: submitStep!.id,
          type: 'url-path',
          expectedPath: '/wrong-path',
          match: 'exact',
          source: OPERATOR_DECLARED_SOURCE,
          reason: 'Checking an unmet expectation',
        },
      ],
    };

    const report = await executeJourney({
      plan,
      planPath: 'journey.json',
      headed: false,
      continueOnFailure: true,
      screenshots: false,
      safeTestMode: true,
      expectations,
    });

    const executedStep = report.steps.find((s) => s.id === submitStep!.id);
    expect(executedStep?.expectationResults?.[0]?.result).toBe('not-matched');
    expect(executedStep?.expectationResults?.[0]?.actualPath).toBe('/thank-you');

    // Feeding the report through the anomaly engine:
    const anomalies = buildAnomalyReport({
      execution: report,
      journey: plan,
      executionPath: 'execution.json',
      journeyPath: 'journey.json',
    });

    // The failed expectation is NOT automatically confirmed as a bug.
    expect(anomalies.interpretation.confirmedBug).toBe(false);
  }, 90_000);
});

describe('Build 6.5 safety gate: unsafe expectations rejected before browser launch', () => {
  it('rejects payment and secret paths before browser execution', async () => {
    const fakePlan = validateJourneyPlan(
      {
        schemaVersion: '1.0',
        goal: 'test',
        journeyType: 'form_submission',
        target: { url: 'http://127.0.0.1:9/fake', finalUrl: null, title: 'Fake' },
        steps: [
          {
            id: 'step-001',
            order: 1,
            action: 'click',
            intent: 'click',
            description: '',
            targetElementIds: [],
            locatorCandidates: ['#btn'],
            expectedOutcome: '',
            confidence: 0.7,
            executable: false,
            source: { report: 'r', elementIds: [] },
          },
        ],
      },
      'journey.json',
    );

    const expectationsPath = join(dir, 'unsafe-exp.json');
    await writeFile(
      expectationsPath,
      JSON.stringify({
        schemaVersion: EXPECTATIONS_SCHEMA_VERSION,
        journeyPlanHash: journeyHash(fakePlan),
        expectations: [
          {
            id: 'exp-001',
            afterStepId: 'step-001',
            type: 'url-path',
            expectedPath: '/checkout/payment',
            match: 'exact',
            source: OPERATOR_DECLARED_SOURCE,
            reason: 'payment path',
          },
        ],
      }),
      'utf8',
    );

    // loadExpectationsFile must throw before any browser is launched.
    await expect(loadExpectationsFile(expectationsPath, fakePlan)).rejects.toThrow(/payment/);
  });
});
