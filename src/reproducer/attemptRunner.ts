/**
 * Controlled attempt execution.
 *
 * Each attempt is a full, fresh run of the same journey, so every signal is
 * evaluated under identical conditions. This is the strategy the spec calls
 * for: one journey per attempt, not one journey per anomaly, which would both
 * waste browser time and make signals incomparable.
 *
 * Reuses the Build 3 executor and the Build 4 classifier directly, in process.
 * No child processes, no shell, and no duplicated action logic.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { executeJourney } from '../executor/executor.js';
import { buildAnomalyReport } from '../anomaly/report.js';
import { toEnvironmentReference } from '../provenance/reportMetadata.js';
import type { AnomalyReport } from '../anomaly/report.js';
import type { ReproductionInput, ReproductionRun, AttemptStatus } from './types.js';

/** Stable, ordered directory name for an attempt. */
export function attemptName(attempt: number): string {
  return `attempt-${String(attempt).padStart(3, '0')}`;
}

/** Paths an attempt writes, relative to the reproduction output directory. */
export function attemptPaths(outputDir: string, attempt: number): { execution: string; anomalies: string; dir: string } {
  const name = attemptName(attempt);
  const dir = join(outputDir, name);
  return {
    dir,
    execution: join(dir, 'execution.json'),
    anomalies: join(dir, 'anomalies.json'),
  };
}

/**
 * Run one controlled attempt and classify its evidence.
 *
 * An attempt is `completed` whenever the executor produced a report, even if
 * some steps were refused: a refusal is itself evidence, and the run still
 * yields comparable data for the signals under test. `blocked` and `failed`
 * are reserved for an attempt that could not run at all.
 */
export async function runAttempt(input: ReproductionInput, attempt: number): Promise<ReproductionRun> {
  const paths = attemptPaths(input.outputDir, attempt);
  const name = attemptName(attempt);

  let execution;
  try {
    execution = await executeJourney({
      plan: input.journey,
      planPath: input.journeyPath,
      // The same data for every attempt, so conditions are held constant.
      testData: input.testData,
      timeoutMs: input.timeoutMs,
      headed: input.headed,
      // Every attempt is independent by design, so a failure in one must not
      // leave the next in a partial state.
      continueOnFailure: true,
      // Safe test mode is unconditional in the executor and stays so here.
      safeTestMode: true,
      // Screenshots inherit the executor's omission behaviour: the moment test
      // data enters the page, capture stops.
      screenshots: true,
      evidenceDir: join(paths.dir, 'evidence'),
      // Build 5.1: the caller-declared environment identity is forwarded so
      // every attempt records the same declared provenance.
      provenance: input.provenance,
      testDataFixtureHashSource: input.testDataFixtureHashSource,
    });
  } catch (error) {
    // The executor could not run at all - a browser failure, a target that
    // would not load. Recorded, not thrown, so later attempts still run.
    return {
      attempt,
      name,
      executionReport: paths.execution,
      anomalyReport: paths.anomalies,
      status: 'failed',
      detail: (error as Error).message.slice(0, 200),
      // An attempt that never launched a browser has no environment to record.
      environmentFingerprint: null,
      environmentId: null,
      applicationBuildId: null,
      // Minimal placeholders so matching and the report builder have a shape.
      execution: emptyExecution(input),
      anomalies: emptyAnomalies(input),
    };
  }

  // Re-run the existing Build 4 classifier against this attempt's evidence.
  // The rules are not duplicated or reimplemented; the same code that produced
  // the original report produces the rerun reports.
  const anomalyReport: AnomalyReport = buildAnomalyReport({
    execution,
    journey: input.journey,
    executionPath: paths.execution,
    journeyPath: input.journeyPath,
  });

  // The attempt status describes the *attempt*, not the steps. A step refused
  // by a safety or data guard is evidence, and a run that refuses some steps
  // still produced comparable evidence for the rest. Conflating the two would
  // report a run that completed as blocked, and then nothing could be
  // classified as reproduced or not-reproduced.
  const status: AttemptStatus = 'completed';

  await mkdir(dirname(paths.execution), { recursive: true });
  await writeFile(paths.execution, `${JSON.stringify(execution, null, 2)}\n`, 'utf8');
  await writeFile(paths.anomalies, `${JSON.stringify(anomalyReport, null, 2)}\n`, 'utf8');

  const refusedSteps = execution.steps.filter((step) => step.status === 'blocked').length;

  return {
    attempt,
    name,
    executionReport: paths.execution,
    anomalyReport: paths.anomalies,
    status,
    // Recorded for context, without making it an attempt-level block.
    detail:
      refusedSteps > 0
        ? `${refusedSteps} step(s) were refused by an executor guard; the attempt still completed.`
        : null,
    // Build 5.1: read back from the execution report the executor produced, so
    // the recorded fingerprint is the one that actually ran.
    environmentFingerprint: execution.environment?.fingerprint ?? null,
    environmentId: execution.environment?.application.environmentId ?? null,
    applicationBuildId: execution.environment?.application.buildId ?? null,
    execution,
    anomalies: anomalyReport,
  };
}

/** A minimal valid execution report, for an attempt that could not run. */
function emptyExecution(input: ReproductionInput) {
  return {
    schemaVersion: '1.0',
    journeyPlanSchemaVersion: input.journey.schemaVersion,
    journeyReport: input.journeyPath,
    goal: input.journey.goal,
    journeyType: input.journey.journeyType,
    target: { url: input.journey.target.url, finalUrl: null, title: input.journey.target.title },
    status: 'aborted' as const,
    startedAt: '',
    finishedAt: '',
    durationMs: 0,
    stepCounts: { total: 0, passed: 0, failed: 0, blocked: 0, skipped: 0 },
    steps: [],
    rawEvidence: { consoleEvents: [], pageErrors: [], networkEvents: [], screenshots: [] },
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
      // Structurally zero: an attempt that never ran performed no retries.
      retries: 0 as const,
      stoppedOnFailure: false,
      continueOnFailure: false,
      safeTestMode: true,
    },
    // An attempt that never launched a browser has no environment to record.
    // Null reads as "unknown" downstream, which is the honest answer.
    environment: null,
  };
}

/** A minimal valid anomaly report, for an attempt that could not run. */
function emptyAnomalies(input: ReproductionInput): AnomalyReport {
  return {
    schemaVersion: '1.0',
    executionReport: attemptPaths(input.outputDir, 0).execution,
    journeyReport: input.journeyPath,
    executionStatus: 'aborted',
    goal: input.journey.goal,
    journeyType: input.journey.journeyType,
    summary: {
      totalSignals: 0,
      httpErrors: 0,
      networkFailures: 0,
      consoleErrors: 0,
      pageErrors: 0,
      timeouts: 0,
      navigationSignals: 0,
      uiStateSignals: 0,
      duplicateRequestSignals: 0,
      stepFailureSignals: 0,
      ruleIds: [],
    },
    anomalies: [],
    warnings: [],
    analyzer: { mode: 'deterministic', version: '0.1.0' },
    // An attempt that never ran has no environment to reference.
    environment: toEnvironmentReference(null),
    interpretation: {
      confirmedBug: false as const,
      requiresInvestigation: false,
      note: 'Attempt could not run.',
    },
  };
}
