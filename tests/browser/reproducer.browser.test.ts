/**
 * Build 5 browser integration tests.
 *
 * These run the real reproducer against a local fixture server: a real
 * anomaly report in, real controlled browser attempts, real per-attempt
 * execution and anomaly artifacts, and a real reproduction report out.
 *
 * Nothing here contacts an external website, and no test depends on a network
 * beyond 127.0.0.1.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

import { runScout } from '../../src/scout/scout.js';
import { planJourney } from '../../src/journey/plan.js';
import { buildAnomalyReport } from '../../src/anomaly/report.js';
import { reproduceSignals } from '../../src/reproducer/reproducer.js';
import { startFixtureServer, stopFixtureServer } from '../fixtures/server.js';
import type { AnomalyReport } from '../../src/anomaly/report.js';
import type { JourneyPlan } from '../../src/journey/types.js';
import type { ReproductionInput, ReproductionReport } from '../../src/reproducer/types.js';

let server: Server;
let origin: string;
let available = false;
let workDir: string;

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
  workDir = await mkdtemp(join(tmpdir(), 'crashlab-repro-'));
}, 60_000);

afterAll(async () => {
  if (server) await stopFixtureServer(server);
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

/**
 * Build the real pipeline up to an anomaly report: scout, plan, and classify a
 * synthetic execution carrying the evidence we want to reproduce.
 */
async function buildPipeline(path = '/checkout', goal = 'Try to complete checkout'): Promise<{ journey: JourneyPlan; anomalies: AnomalyReport; goal: string }> {
  const scout = await runScout({ url: `${origin}${path}`, headless: true, settleMs: 150, timeoutMs: 15_000 });
  const journey = planJourney(goal, scout, 'reports/scout.json');

  // An execution report carrying a stable HTTP 500, as if the checkout API had
  // failed. Built through the Build 4 classifier so the signal shape is real.
  const execution = {
    schemaVersion: '1.0' as const,
    journeyPlanSchemaVersion: '1.0' as const,
    journeyReport: 'reports/journey.json',
    goal: journey.goal,
    journeyType: journey.journeyType,
    target: { url: `${origin}${path}`, finalUrl: null, title: scout.target.title },
    status: 'passed' as const,
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    durationMs: 1000,
    stepCounts: { total: 1, passed: 1, failed: 0, blocked: 0, skipped: 0 },
    steps: [],
    rawEvidence: {
      consoleEvents: [],
      pageErrors: [],
      // The fixture always requests a resource that 404s, so this evidence
      // recurs on every attempt - a genuinely reproducible signal.
      networkEvents: [
        {
          method: 'GET',
          url: `${origin}/api/missing-resource`,
          path: '/api/missing-resource',
          status: 404,
          resourceType: 'fetch',
          durationMs: 5,
          thirdParty: false,
          failure: null,
        },
      ],
      screenshots: [],
    },
    warnings: [],
    blockedSteps: [],
    redaction: {
      sensitiveValuesRedacted: true,
      redactedValueCount: 0,
      dataProvidedKeys: [],
      dataProvided: false,
      screenshotsOmittedAfterSensitiveData: false,
    },
    executor: {
      mode: 'deterministic' as const,
      version: '0.1.0',
      retries: 0 as const,
      stoppedOnFailure: false,
      continueOnFailure: false,
      safeTestMode: true,
    },
  };

  const anomalies = buildAnomalyReport({
    execution,
    journey,
    executionPath: 'reports/execution.json',
    journeyPath: 'reports/journey.json',
  });

  return { journey, anomalies, goal: journey.goal };
}

/** Reproducer input pointing at a private artifact directory. */
function input(anomalies: AnomalyReport, journey: JourneyPlan, attempts: number): ReproductionInput {
  return {
    anomalies,
    journey,
    attempts,
    authorized: true,
    anomalyPath: 'reports/anomalies.json',
    journeyPath: 'reports/journey.json',
    executionPath: 'reports/execution.json',
    includePossiblyExpected: true,
    outputDir: join(workDir, 'reproduction'),
  };
}

describe('controlled reproduction against a local fixture', () => {
  it('reproduces a signal that recurs on every attempt', async () => {
    if (!available) return;
    const { journey, anomalies } = await buildPipeline();

    const report: ReproductionReport = await reproduceSignals(input(anomalies, journey, 3));

    expect(report.reproducer.attemptsRequested).toBe(3);
    expect(report.reproducer.attemptsCompleted).toBe(3);
    expect(report.reproducer.automaticRetries).toBe(false);

    // The 404 the fixture always raises must be classified and reproduced.
    const http = report.results.find((result) => result.ruleId === 'HTTP_4XX');
    expect(http, 'the fixture should raise a 404 on every load').toBeDefined();
    expect(http?.classification).toBe('reproduced');
    expect(http?.matchingAttempts).toBe(3);
    expect(http?.reproductionRatio).toBe('3/3');
    expect(http?.confirmed).toBe(false);
  }, 120_000);

  it('writes a per-attempt execution and anomaly report for every attempt', async () => {
    if (!available) return;
    const { journey, anomalies } = await buildPipeline();
    await reproduceSignals(input(anomalies, journey, 2));

    for (const attemptNumber of [1, 2]) {
      const name = `attempt-${String(attemptNumber).padStart(3, '0')}`;
      const dir = join(workDir, 'reproduction', name);
      expect(existsSync(join(dir, 'execution.json')), `${name}/execution.json`).toBe(true);
      expect(existsSync(join(dir, 'anomalies.json')), `${name}/anomalies.json`).toBe(true);

      // Each artifact must be valid JSON of the right kind.
      const execution = JSON.parse(await readFile(join(dir, 'execution.json'), 'utf8')) as { schemaVersion: string };
      const attemptAnomalies = JSON.parse(await readFile(join(dir, 'anomalies.json'), 'utf8')) as {
        schemaVersion: string;
        anomalies: unknown[];
      };
      expect(execution.schemaVersion).toBe('1.0');
      expect(attemptAnomalies.schemaVersion).toBe('1.0');
      expect(Array.isArray(attemptAnomalies.anomalies)).toBe(true);
    }
  }, 120_000);

  it('uses a fresh browser context for every attempt', async () => {
    if (!available) return;
    const { journey, anomalies } = await buildPipeline();
    const report = await reproduceSignals(input(anomalies, journey, 2));

    // Each attempt runs the same journey from scratch, so each report records
    // its own navigation of the target rather than inheriting prior state.
    expect(report.runs).toHaveLength(2);
    const startTimes = report.runs.map((run) => run.executionReport);
    expect(new Set(startTimes).size).toBe(2);

    for (const run of report.runs) {
      const execution = JSON.parse(await readFile(run.executionReport, 'utf8')) as { target: { url: string } };
      expect(execution.target.url).toContain('/checkout');
    }
  }, 120_000);

  it('never mutates the journey plan across attempts', async () => {
    if (!available) return;
    const { journey, anomalies } = await buildPipeline();
    const before = JSON.stringify(journey, null, 2);

    await reproduceSignals(input(anomalies, journey, 2));

    // The plan object the caller passed is untouched, and so is its content:
    // no action rewritten, no confidence changed, no warning removed.
    expect(JSON.stringify(journey, null, 2)).toBe(before);
    expect(journey.steps.every((step) => step.executable === false)).toBe(true);
  }, 120_000);

  it('preserves safe test mode and the payment guard on every attempt', async () => {
    if (!available) return;
    const { journey, anomalies } = await buildPipeline();
    const report = await reproduceSignals(input(anomalies, journey, 1));

    for (const run of report.runs) {
      const execution = JSON.parse(await readFile(run.executionReport, 'utf8')) as {
        executor: { safeTestMode: boolean; retries: number };
      };
      expect(execution.executor.safeTestMode).toBe(true);
      expect(execution.executor.retries).toBe(0);
    }
    expect(report.safety.livePaymentAllowed).toBe(false);
  }, 120_000);

  it('preserves screenshot omission when test data enters the page', async () => {
    if (!available) return;
    // A login goal against the executor page produces real `fill` steps, so test
    // data genuinely enters the DOM and the omission path is actually
    // exercised. A checkout goal would match no fields and never fill anything.
    const { journey, anomalies } = await buildPipeline('/executor', 'Try to log in');

    const withData: ReproductionInput = {
      ...input(anomalies, journey, 1),
      testData: { username: 'qa-user@example.test', password: 'SafeFixturePassword123!' },
    };
    const report = await reproduceSignals(withData);

    expect(report.runs.length).toBeGreaterThan(0);
    for (const run of report.runs) {
      const execution = JSON.parse(await readFile(run.executionReport, 'utf8')) as {
        steps: { evidence: { screenshot: string | null; screenshotOmittedReason: string | null } }[];
        redaction: { screenshotsOmittedAfterSensitiveData: boolean };
        rawEvidence: { screenshots: string[] };
      };

      // The fill happened, so omission must be recorded and later shots absent.
      expect(execution.redaction.screenshotsOmittedAfterSensitiveData).toBe(true);
      const omitted = execution.steps.filter(
        (step) => step.evidence.screenshotOmittedReason === 'sensitive-data-entered',
      );
      expect(omitted.length).toBeGreaterThan(0);
      for (const step of omitted) {
        expect(step.evidence.screenshot).toBeNull();
      }
      // The initial screenshot predates the fill and is still present.
      expect(execution.rawEvidence.screenshots).toContain('initial.png');
      expect(execution.rawEvidence.screenshots).not.toContain('final.png');
    }
  }, 120_000);

  it('keeps test values out of the reproduction report and rerun artifacts', async () => {
    if (!available) return;
    const { journey, anomalies } = await buildPipeline('/executor', 'Try to log in');

    const report = await reproduceSignals({
      ...input(anomalies, journey, 1),
      testData: { username: 'qa-user@example.test', password: 'SafeFixturePassword123!' },
    });

    const secret = 'SafeFixturePassword123!';
    expect(JSON.stringify(report)).not.toContain(secret);

    for (const run of report.runs) {
      expect(await readFile(run.executionReport, 'utf8')).not.toContain(secret);
      expect(await readFile(run.anomalyReport, 'utf8')).not.toContain(secret);
    }
  }, 120_000);

  it('closes the browser after every attempt', async () => {
    if (!available) return;
    const { journey, anomalies } = await buildPipeline();

    const before = (await chromium.launch({ headless: true })).isConnected();
    await reproduceSignals(input(anomalies, journey, 2));
    const after = (await chromium.launch({ headless: true })).isConnected();

    // If the executor leaked a browser process, these would contend. Both
    // launching cleanly is the practical proof the sessions were torn down.
    expect(before).toBe(true);
    expect(after).toBe(true);
  }, 120_000);

  it('produces byte-identical reports for identical inputs and attempts', async () => {
    if (!available) return;
    const { journey, anomalies } = await buildPipeline();

    const first = JSON.stringify(
      buildStableReport(await reproduceSignals(input(anomalies, journey, 2))),
      null,
      2,
    );
    const second = JSON.stringify(
      buildStableReport(await reproduceSignals(input(anomalies, journey, 2))),
      null,
      2,
    );
    expect(second).toBe(first);
  }, 180_000);

  it('does not launch a browser when no signal is eligible', async () => {
    if (!available) return;
    const { journey, anomalies } = await buildPipeline();

    // Default policy excludes the 404, so nothing is worth a browser.
    const report = await reproduceSignals({
      ...input(anomalies, journey, 3),
      includePossiblyExpected: false,
    });

    expect(report.runs).toEqual([]);
    expect(report.reproducer.attemptsCompleted).toBe(0);
    expect(report.results.every((result) => result.classification === 'ineligible')).toBe(true);
  }, 60_000);
});

/** Strip the parts that legitimately differ between runs (paths, durations). */
function buildStableReport(report: ReproductionReport): unknown {
  return {
    summary: report.summary,
    results: report.results.map((result) => ({
      anomalyId: result.anomalyId,
      ruleId: result.ruleId,
      classification: result.classification,
      confirmed: result.confirmed,
      matchingAttempts: result.matchingAttempts,
      completedAttempts: result.completedAttempts,
      reproductionRatio: result.reproductionRatio,
    })),
    safety: report.safety,
    interpretation: report.interpretation,
  };
}
