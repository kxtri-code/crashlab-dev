/**
 * Run verification.
 *
 * The question this answers is not "did everything pass?" but "how much of the
 * plan did we actually evaluate?"
 *
 * That distinction exists because a generated journey routinely ends with a
 * prose assertion nobody can evaluate. Treating that as a failure would report
 * a healthy run as broken; treating it as a pass would claim a conclusion the
 * evidence does not support. So the run *completes*, and its verification is
 * `partial`.
 *
 * Pure, so the whole completion model is testable without a browser.
 */

import type {
  ExecutionStatus,
  ExecutionVerification,
  StepExecutionResult,
  StepStatus,
  VerificationCoverage,
  VerificationStatus,
} from './types.js';

/** Count steps by status, including steps that never ran. */
function tally(steps: readonly StepExecutionResult[]): Record<StepStatus, number> {
  const counts: Record<StepStatus, number> = { passed: 0, failed: 0, blocked: 0, skipped: 0 };
  for (const step of steps) {
    if (step.status in counts) counts[step.status] += 1;
  }
  return counts;
}

/**
 * Build the verification record for a finished run.
 *
 * @param aborted whether execution stopped before the plan was processed.
 * @param hasOperatorExpectations whether operator-declared expectations were used.
 */
export function buildVerification(
  steps: readonly StepExecutionResult[],
  aborted: boolean,
  hasOperatorExpectations: boolean = false,
): ExecutionVerification {
  const counts = tally(steps);
  // An unverified assertion is a skipped step that says so explicitly. A step
  // skipped for another reason - no target, or an earlier failure - is a
  // different thing and is not counted here.
  //
  // A *failed* structured assertion is a real result and must keep the run out
  // of `complete`: the expectation was checked and did not hold.
  const unverified = steps.filter((step) => step.verification?.status === 'unverified');
  const unverifiedStepIds = unverified.map((step) => step.id).sort();

  // Steps that ran, as opposed to those never reached.
  const executedSteps = counts.passed + counts.failed + counts.blocked;

  let status: VerificationStatus;
  let coverage: VerificationCoverage;

  if (aborted || counts.failed > 0 || counts.blocked > 0) {
    // An interrupted, failed or refused run cannot claim it evaluated the plan.
    status = 'incomplete';
    coverage = 'partial-plan';
  } else if (counts.passed === 0 || executedSteps === 0) {
    // Zero meaningful steps passed or executed: run was only skipped or observational.
    // It cannot claim completion or executed-steps-only coverage.
    status = 'partial';
    coverage = 'partial-plan';
  } else if (unverified.length > 0) {
    // The important case: everything executable succeeded, but an expectation
    // was left unchecked. Completion, not success.
    status = 'partial';
    coverage = 'executed-steps-only';
  } else if (counts.skipped > 0) {
    // Skipped for a benign reason (an observation with no target) alongside passed steps.
    // Nothing is unverified, so the executable plan was evaluated.
    status = 'complete';
    coverage = 'executed-steps-only';
  } else {
    status = 'complete';
    // When operator-declared expectations are in use, coverage is
    // 'operator-declared', never 'full-plan'. This honestly reflects that the
    // verification came from operator declaration, not Scout-derived evidence.
    coverage = hasOperatorExpectations ? 'operator-declared' : 'full-plan';
  }

  return {
    status,
    complete: status === 'complete',
    executedSteps,
    passedSteps: counts.passed,
    failedSteps: counts.failed,
    blockedSteps: counts.blocked,
    skippedSteps: counts.skipped,
    unverifiedAssertions: unverified.length,
    unverifiedStepIds,
    coverage,
  };
}

/**
 * Derive the top-level status.
 *
 * `completed` and `passed` are separate on purpose: a run that finished while
 * leaving an expectation unverified is not a run where everything passed.
 */
export function deriveExecutionStatus(
  steps: readonly StepExecutionResult[],
  aborted: boolean,
): ExecutionStatus {
  const counts = tally(steps);

  // A real interruption outranks everything: the run did not finish.
  if (aborted) return 'aborted';
  if (counts.failed > 0) return 'failed';
  if (counts.blocked > 0) return 'blocked';

  const unverified = steps.filter((step) => step.verification?.status === 'unverified');
  if (unverified.length > 0) return 'completed';
  if (counts.passed > 0) return 'passed';
  // Nothing ran and nothing failed: every step was a no-op.
  return 'skipped';
}

/** Whether a run may be treated as fully verified. */
export function isFullyVerified(verification: ExecutionVerification | null): boolean {
  return verification !== null && verification.status === 'complete' && verification.complete && verification.passedSteps > 0;
}
