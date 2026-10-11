/**
 * Execution report assembly and terminal summary.
 *
 * Pure: takes the collected step results and evidence, and produces the report
 * object. Keeping this separate from `executor.ts` means the schema is
 * testable without a browser, and the terminal output cannot disagree with the
 * JSON on disk.
 *
 * The vocabulary here is deliberately careful. A `failed` step means the step
 * did not succeed. It is not a bug, and this module never implies one.
 */

import type { JourneyPlan } from '../journey/types.js';
import type {
  ExecutionOptions,
  ExecutionReport,
  ExecutionStatus,
  RawEvidence,
  RedactionSummary,
  StepExecutionResult,
} from './types.js';
import { EXECUTION_SCHEMA_VERSION } from './types.js';
import type { ExecutionVerification } from './types.js';
import type { EnvironmentProvenance } from '../provenance/types.js';
import { buildVerification, deriveExecutionStatus } from './verification.js';
import { hashExpectationsFile } from './expectations.js';
import { TOOL_VERSION } from '../version.js';

/** Tally per-step statuses. */
export function countSteps(steps: readonly StepExecutionResult[]): ExecutionReport['stepCounts'] {
  const counts = { total: steps.length, passed: 0, failed: 0, blocked: 0, skipped: 0 };
  for (const step of steps) {
    if (step.status === 'passed') counts.passed += 1;
    else if (step.status === 'failed') counts.failed += 1;
    else if (step.status === 'blocked') counts.blocked += 1;
    else counts.skipped += 1;
  }
  return counts;
}

/**
 * Derive the overall run status.
 *
 * Re-exported from `verification.ts` so there is exactly one status model in
 * the codebase. `deriveStatus` is kept as the name Builds 3 and 4 already use.
 */
export { deriveExecutionStatus as deriveStatus } from './verification.js';

/** Assemble the report. Pure. */
export function buildExecutionReport(input: {
  plan: JourneyPlan;
  options: ExecutionOptions;
  steps: StepExecutionResult[];
  rawEvidence: RawEvidence;
  redaction: RedactionSummary;
  /**
   * Build 5.1 provenance. Optional at the builder boundary so a legacy caller
   * that predates provenance still assembles; it records `null`, which
   * downstream reads as "unknown" rather than inventing an environment.
   */
  environment?: EnvironmentProvenance | null;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  finalUrl: string | null;
  aborted: boolean;
  stoppedOnFailure: boolean;
  warnings: string[];
  /**
   * Build 6.1 completion. Optional so a caller can supply a precomputed record
   * or let it be derived from the steps; the derived value is always consistent
   * with them.
   */
  status?: import('./types.js').ExecutionStatus;
  verification?: ExecutionVerification | null;
}): ExecutionReport {
  const blockedSteps = input.steps
    .filter((step) => step.status === 'blocked')
    .map((step) => `${step.id}: ${step.error?.reason ?? 'unknown'} - ${step.error?.message ?? 'no reason recorded'}`);

  return {
    schemaVersion: EXECUTION_SCHEMA_VERSION,
    journeyPlanSchemaVersion: input.plan.schemaVersion,
    journeyReport: input.options.planPath,
    goal: input.plan.goal,
    journeyType: input.plan.journeyType,
    target: {
      url: input.plan.target.url,
      finalUrl: input.finalUrl,
      title: input.plan.target.title,
    },
    status: input.status ?? deriveExecutionStatus(input.steps, input.aborted),
    verification: input.verification ?? buildVerification(input.steps, input.aborted, input.options.expectations !== undefined),
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    durationMs: input.durationMs,
    stepCounts: countSteps(input.steps),
    steps: input.steps,
    rawEvidence: input.rawEvidence,
    warnings: [...new Set(input.warnings)],
    blockedSteps,
    redaction: input.redaction,
    // Provenance is carried through unchanged; a legacy caller that omits it
    // records `null`, which downstream reads as "unknown" rather than
    // inventing an environment.
    environment: input.environment ?? null,
    // Build 6.5: expectation file hash for provenance and reproduction consistency.
    expectationFileHash: input.options.expectations ? hashExpectationsFile(input.options.expectations) : null,
    executor: {
      mode: 'deterministic',
      version: TOOL_VERSION,
      // Build 3 performs no retries. This is a structural constant, not a policy.
      retries: 0,
      stoppedOnFailure: input.stoppedOnFailure,
      continueOnFailure: input.options.continueOnFailure === true,
      // Always true in this milestone: safe test mode has no opt-out, so a
      // live payment path cannot be enabled.
      safeTestMode: true,
    },
  };
}

/** Line-aligned `Label: value` helper, matching the earlier summaries. */
function row(label: string, value: string, width = 14): string {
  return `  ${label.padEnd(width)} ${value}`;
}

/**
 * Render the terminal summary.
 *
 * States plainly that a failure is not a confirmed bug, and that Build 3 does
 * not classify anomalies or reproduce anything.
 */
export function summarizeExecution(report: ExecutionReport): string {
  const lines: string[] = [];
  const counts = report.stepCounts;

  lines.push(`CRASHLAB SCOUT - JOURNEY EXECUTOR v${report.executor.version}`);
  lines.push('');
  lines.push(row('Goal:', report.goal || '(empty)'));
  lines.push(row('Journey type:', report.journeyType));
  lines.push(row('Target:', report.target.url));
  lines.push(row('Final URL:', report.target.finalUrl ?? '(none)'));
  lines.push(row('Plan:', report.journeyReport));
  lines.push(row('Overall:', report.status.toUpperCase()));
  if (report.verification) {
    // Completion and full verification are different claims, so both are shown.
    lines.push(row('Verified:', `${report.verification.status} (${report.verification.coverage})`));
    if (report.verification.unverifiedAssertions > 0) {
      lines.push(row('Unverified:', `${report.verification.unverifiedAssertions} expectation(s) not evaluated`));
    }
  }
  lines.push('');

  lines.push('STEPS');
  lines.push(
    `  Total ${counts.total}   passed ${counts.passed}   failed ${counts.failed}   blocked ${counts.blocked}   skipped ${counts.skipped}`,
  );
  for (const step of report.steps) {
    lines.push(`  ${step.id}  ${step.status.padEnd(8)} ${step.action.padEnd(9)} ${step.intent}`);
    if (step.error) lines.push(`        reason=${step.error.reason}`);
  }
  lines.push('');

  if (report.blockedSteps.length > 0) {
    lines.push(`BLOCKED STEPS (${report.blockedSteps.length})`);
    for (const entry of report.blockedSteps) lines.push(`  - ${entry}`);
    lines.push('');
  }

  if (report.warnings.length > 0) {
    lines.push(`WARNINGS (${report.warnings.length})`);
    for (const warning of report.warnings) lines.push(`  - ${warning}`);
    lines.push('');
  }

  const evidence = report.rawEvidence;
  lines.push('EVIDENCE');
  lines.push(`  Console events:  ${evidence.consoleEvents.length}`);
  lines.push(`  Page errors:     ${evidence.pageErrors.length}`);
  lines.push(`  Network events:  ${evidence.networkEvents.length}`);
  lines.push(`  Screenshots:     ${evidence.screenshots.length}`);
  lines.push(`  Sensitive values redacted: ${report.redaction.sensitiveValuesRedacted ? 'yes' : 'no'}`);
  if (report.redaction.screenshotsOmittedAfterSensitiveData) {
    lines.push('  Screenshots omitted after test data entered the page (a bitmap cannot be redacted).');
  }
  lines.push('');

  lines.push(`Execution finished: ${report.status}. Retries: ${report.executor.retries}.`);
  lines.push(`Safe test mode: ${report.executor.safeTestMode ? 'on (payment actions blocked)' : 'off'}.`);
  if (report.verification && !report.verification.complete) {
    lines.push(
      'Some expectations were left unverified. Completion means the run finished safely; ' +
        'it does not mean every expected outcome was proven.',
    );
  }
  lines.push('A failed or blocked step is an observation about this run, not a confirmed bug.');
  lines.push('Anomaly detection belongs to Build 4; reproduction belongs to Build 5.');

  return lines.join('\n');
}
