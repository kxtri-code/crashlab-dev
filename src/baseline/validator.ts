/**
 * Baseline validation.
 *
 * A baseline is the input to every later "is this new?" question, so a bad one
 * poisons the whole comparison. This module refuses anything that would make a
 * baseline misleading.
 *
 * The central decision is the one the spec calls out: **absence of signals is not
 * evidence of health.** A run that produced no signals because evidence
 * collection failed, because the journey was aborted, or because every step was
 * blocked, is not a known-good state - it is an absent one. Creating a baseline
 * from it would make every future signal look novel, which is the precise
 * failure mode a baseline is supposed to prevent.
 */

import type { AnomalyReport } from '../anomaly/report.js';
import type { ExecutionReport } from '../executor/types.js';
import type { JourneyPlan } from '../journey/types.js';
import { buildBaselineIdentity } from './identity.js';
import { sanitizeIdentifier } from '../provenance/redaction.js';
import { BaselineError, MAX_LINEAGE_DEPTH } from './types.js';
import type { Baseline, BaselineIdentity, BaselineLineage } from './types.js';

/**
 * Validate that a baseline ID satisfies all filesystem and safety constraints.
 *
 * Rules:
 *  - non-empty string
 *  - free from control characters
 *  - free from path separators
 *  - free from traversal sequences
 *  - passes provenance identifier sanitization
 */
export function validateBaselineId(baselineId: string): void {
  if (!baselineId || typeof baselineId !== 'string' || baselineId.trim() === '') {
    throw new BaselineError('Baseline ID must be a non-empty string.');
  }
  const trimmed = baselineId.trim();
  if (/[\x00-\x1f\x7f]/.test(trimmed)) {
    throw new BaselineError('Baseline ID must not contain control characters.');
  }
  if (/[\\/]/.test(trimmed)) {
    throw new BaselineError('Baseline ID must not contain path separators.');
  }
  if (trimmed.includes('..')) {
    throw new BaselineError('Baseline ID must not contain traversal sequences.');
  }
  try {
    const sanitized = sanitizeIdentifier(trimmed, 'baseline ID');
    if (!sanitized) {
      throw new BaselineError('Baseline ID must be a valid identifier.');
    }
  } catch (err) {
    if (err instanceof BaselineError) throw err;
    throw new BaselineError((err as Error).message);
  }
}

/**
 * Execution statuses a baseline may be created from.
 *
 * `completed` is included because Build 6.1 made it the normal outcome for a
 * generated journey: every executable action succeeded and a prose assertion
 * was left unverified. That is a healthy run, not a failed one.
 */
const ACCEPTABLE_EXECUTION_STATUSES = new Set(['passed', 'completed', 'partial']);

/** Step statuses that make a run unusable as a baseline, whatever else is true. */
const DISQUALIFYING_STEP_STATUSES = new Set(['failed', 'blocked']);

/** Signal levels that must be explicitly accepted before a baseline is clean. */
const UNRESOLVED_LEVELS = new Set(['error']);

/** Everything the validator needs. */
export interface BaselineValidationInput {
  execution: ExecutionReport;
  anomalies: AnomalyReport;
  journey: JourneyPlan;
  /** Anomaly ids the operator explicitly accepted. */
  acceptedSignalIds: string[];
  /**
   * Whether the operator allowed a partially verified run. Without it, a run
   * carrying unverified assertions is refused rather than quietly downgraded.
   */
  allowUnverifiedAssertions?: boolean;
  /**
   * Build 6.5: whether the operator allowed a run that used operator-declared
   * expectations. Required when the source execution carries an
   * `expectationFileHash`; without it the baseline is refused.
   */
  allowDeclaredExpectations?: boolean;
  /** Paths, echoed into any error so the operator knows which file. */
  paths?: { execution: string; anomalies: string; journey: string };
  /** Optional parent baseline being descended from (Build 7). */
  parentBaseline?: Baseline | null;
  /** Optional candidate baseline id being created (Build 7). */
  candidateBaselineId?: string;
}

/** The outcome of a validation. */
export interface BaselineValidationResult {
  /** True when a baseline may be created. */
  safe: boolean;
  /**
   * True when the run is only partially verified and the operator approved it.
   * The baseline is then recorded as `known-good-partial`, never as fully
   * verified.
   */
  partial: boolean;
  /** Problems that make the run unusable as a baseline. */
  blockers: string[];
  /** Warnings worth recording without blocking. */
  warnings: string[];
  /** Signal ids the operator accepted, after validation. */
  acceptedSignalIds: string[];
  /** Lineage metadata computed when parent validation succeeds. */
  lineage?: BaselineLineage;
}

/**
 * Decide whether a run may become a known-good baseline.
 *
 * Pure: no I/O, no browser, no network.
 */
export function validateBaselineCandidate(input: BaselineValidationInput): BaselineValidationResult {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const paths = input.paths;

  const known = new Set(input.acceptedSignalIds);
  for (const id of input.acceptedSignalIds) {
    if (!input.anomalies.anomalies.some((anomaly) => anomaly.id === id)) {
      blockers.push(
        `--accept-signal ${id} does not match any anomaly in ${paths?.anomalies ?? 'the anomaly report'}. ` +
          'An accepted signal must be one that is actually present, so the record is verifiable.',
      );
    }
  }

  // --- structural integrity -------------------------------------------
  if (input.execution.target === undefined || typeof input.execution.target.url !== 'string') {
    blockers.push('The execution report has no target URL.');
  }
  if (typeof input.journey.goal !== 'string' || input.journey.goal.trim() === '') {
    blockers.push('The journey plan has no goal, so the baseline would be untraceable.');
  }
  if (!Array.isArray(input.journey.steps) || input.journey.steps.length === 0) {
    blockers.push('The journey plan has no steps, so there is nothing to compare against.');
  }

  // --- internal consistency ---------------------------------------------
  const referencedExecution = input.anomalies.executionReport;
  if (typeof referencedExecution === 'string' && referencedExecution !== '' && paths) {
    // The anomaly report should point at the execution report it analysed. A
    // mismatch means the two files are from different runs.
    if (!referencedExecution.endsWith(paths.execution.replace(/\\/g, '/')) && referencedExecution !== paths.execution) {
      warnings.push(
        `The anomaly report references "${referencedExecution}", which is not ${paths.execution}. ` +
          'Confirm these artifacts are from the same run.',
      );
    }
  }
  if (input.execution.goal !== input.journey.goal) {
    warnings.push(
      `The execution goal ("${input.execution.goal}") differs from the journey goal ("${input.journey.goal}"). ` +
        'Confirm these artifacts are from the same run.',
    );
  }

  // --- safety state ------------------------------------------------------
  if (input.execution.executor?.safeTestMode !== true) {
    blockers.push('The execution did not run with safe-test mode enabled, so it is not a safe baseline.');
  }
  // Safe test mode is the only mode that exists, so a live payment cannot have
  // occurred in a run that had it on. Nothing further to check here.

  // --- completeness ------------------------------------------------------
  const status = input.execution.status;
  if (!ACCEPTABLE_EXECUTION_STATUSES.has(status)) {
    blockers.push(
      `The execution status is "${status}". A baseline needs a run that completed enough to be meaningful; ` +
        'an aborted or blocked run records what did not happen, not a known-good state.',
    );
  }

  const stepStatuses = (input.execution.steps ?? []).map((step) => step.status);
  if (stepStatuses.length > 0 && stepStatuses.every((stepStatus) => stepStatus === 'skipped')) {
    // Every step skipped means the journey never acted. A baseline from this
    // would claim a healthy page it never actually exercised.
    blockers.push('Every step was skipped, so the run never exercised the journey.');
  }
  if (stepStatuses.every((stepStatus) => stepStatus === 'blocked')) {
    blockers.push('Every step was blocked, so the run never exercised the journey.');
  }

  // A real failure or refusal disqualifies a baseline outright. Allowing
  // unverified assertions must not become a route around this.
  const failedSteps = stepStatuses.filter((stepStatus) => stepStatus === 'failed').length;
  const blockedSteps = stepStatuses.filter((stepStatus) => stepStatus === 'blocked').length;
  if (failedSteps > 0) {
    blockers.push(
      `${failedSteps} step(s) failed. A run with a real execution failure cannot become a baseline, ` +
        'with or without --allow-unverified-assertions.',
    );
  }
  if (blockedSteps > 0) {
    blockers.push(
      `${blockedSteps} step(s) were blocked. A refusal is CrashLab declining to act, not a known-good state, ` +
        'and allowing unverified assertions does not override it.',
    );
  }

  // --- verification ------------------------------------------------------
  const verification = input.execution.verification ?? null;
  let partial = false;

  // Build 6.5: a run that used operator-declared expectations is only
  // baseline-eligible when the operator explicitly allowed them. The
  // expectationFileHash on the execution report is the signal that an
  // expectations file was used.
  const usedDeclaredExpectations =
    input.execution.expectationFileHash !== null && input.execution.expectationFileHash !== undefined;

  if (usedDeclaredExpectations && input.allowDeclaredExpectations !== true) {
    blockers.push(
      'The source execution used operator-declared expectations (expectationFileHash is present), ' +
        'so a baseline requires --allow-declared-expectations. Operator-declared expectations are ' +
        'a separate trust model and must be explicitly approved.',
    );
  }

  if (verification === null) {
    // A legacy report. It can still become a baseline, but nothing is claimed
    // about how much of the plan was verified.
    warnings.push(
      'The execution report has no verification metadata. The baseline will be recorded without a verification claim.',
    );
  } else if (!verification.complete) {
    const unverified = verification.unverifiedAssertions;
    if (input.allowUnverifiedAssertions === true) {
      partial = true;
      warnings.push(
        `The run left ${unverified} expectation(s) unverified. The baseline is recorded as ` +
          'known-good-partial, covering executed steps only.',
      );
    } else {
      blockers.push(
        `The run left ${unverified} expectation(s) unverified, so it is not a fully verified state. ` +
          'Re-run with --allow-unverified-assertions to record it as a known-good-partial baseline.',
      );
    }
  }

  // --- provenance --------------------------------------------------------
  if (input.execution.environment === null || input.execution.environment === undefined) {
    // Not a blocker: a baseline without provenance is still usable, it just
    // cannot take part in an environment comparison later.
    warnings.push(
      'The source execution has no environment provenance. The baseline can be created, ' +
        'but later comparisons will be reported as unknown-environment.',
    );
  } else if (input.execution.environment.fingerprint === null) {
    warnings.push('The source execution has provenance but no fingerprint; comparisons will be limited.');
  }

  // --- signals -----------------------------------------------------------
  const unresolved = input.anomalies.anomalies.filter(
    (anomaly) => UNRESOLVED_LEVELS.has(anomaly.signalLevel) && !known.has(anomaly.id),
  );
  if (unresolved.length > 0) {
    const ids = unresolved.map((anomaly) => anomaly.id);
    blockers.push(
      `The run has ${unresolved.length} unresolved error-level signal(s): ${ids.join(', ')}. ` +
        'Fix them, or accept them explicitly with --accept-signal <id> to record them as known.',
    );
  }

  const unaccepted = input.anomalies.anomalies.filter((anomaly) => !known.has(anomaly.id));
  if (unaccepted.length > 0) {
    warnings.push(
      `${unaccepted.length} signal(s) will be recorded in the baseline. ` +
        'A baseline with signals describes a state where those signals are expected.',
    );
  }

  // --- Build 7: candidate baseline ID & parent baseline validation --------
  if (input.candidateBaselineId !== undefined) {
    try {
      validateBaselineId(input.candidateBaselineId);
    } catch (error) {
      blockers.push((error as Error).message);
    }
  }

  let lineage: BaselineLineage | undefined;
  if (input.parentBaseline !== undefined && input.candidateBaselineId !== undefined) {
    const parentValidation = validateParentBaseline(
      input.candidateBaselineId,
      buildBaselineIdentity(input.journey, input.execution),
      input.parentBaseline,
    );
    lineage = parentValidation.lineage;
    blockers.push(...parentValidation.blockers);
  }

  return {
    safe: blockers.length === 0,
    partial,
    blockers,
    warnings,
    acceptedSignalIds: [...known].sort(),
    lineage,
  };
}

/** Outcome of validating parent baseline lineage and compatibility. */
export interface ParentValidationResult {
  valid: boolean;
  blockers: string[];
  lineage: BaselineLineage;
}

/**
 * Validate that a parent baseline candidate is compatible and safe to descend from.
 *
 * Rules:
 *  - A baseline cannot be its own parent.
 *  - Must not create a cycle (the candidate baselineId must not appear in parent ancestry).
 *  - Must belong to the same target origin.
 *  - Must belong to the same journey identity (journeyHash, journeyType, journeySchemaVersion).
 *  - Must not belong to an incompatible application build (if both specify a build ID and they differ).
 *  - Lineage depth is bounded by MAX_LINEAGE_DEPTH with honest truncation reporting.
 */
export function validateParentBaseline(
  candidateBaselineId: string,
  candidateIdentity: BaselineIdentity,
  parent: Baseline | null,
): ParentValidationResult {
  if (parent === null) {
    return {
      valid: true,
      blockers: [],
      lineage: {
        parentBaselineId: null,
        rootBaselineId: candidateBaselineId,
        depth: 0,
        ancestors: [],
        truncated: false,
      },
    };
  }

  const blockers: string[] = [];

  if (parent.baselineId === candidateBaselineId) {
    blockers.push('A baseline cannot be its own parent.');
  }

  const parentAncestors = parent.lineage?.ancestors ?? [];
  if (parentAncestors.includes(candidateBaselineId) || (parent.lineage?.rootBaselineId === candidateBaselineId && parent.baselineId === candidateBaselineId)) {
    blockers.push(`Cycle detected in baseline lineage: candidate ID "${candidateBaselineId}" already appears in parent ancestry.`);
  }

  if (parent.identity.targetOrigin !== candidateIdentity.targetOrigin) {
    blockers.push(
      `Parent baseline belongs to a different target origin ("${parent.identity.targetOrigin ?? 'unknown'}" vs "${candidateIdentity.targetOrigin ?? 'unknown'}"). target origin mismatch.`,
    );
  }

  if (parent.identity.journeyHash !== candidateIdentity.journeyHash) {
    blockers.push('Parent baseline belongs to a different journey plan (journey hash mismatch).');
  }

  if (parent.identity.journeyType !== candidateIdentity.journeyType) {
    blockers.push(`Parent baseline belongs to a different journey type ("${parent.identity.journeyType}" vs "${candidateIdentity.journeyType}").`);
  }

  if (parent.identity.journeySchemaVersion !== candidateIdentity.journeySchemaVersion) {
    blockers.push('Parent baseline journey schema version does not match candidate.');
  }

  if (
    parent.identity.applicationBuildId !== null &&
    candidateIdentity.applicationBuildId !== null &&
    parent.identity.applicationBuildId !== candidateIdentity.applicationBuildId
  ) {
    blockers.push(
      `Parent baseline belongs to a different application build ("${parent.identity.applicationBuildId}" vs "${candidateIdentity.applicationBuildId}"). application build mismatch.`,
    );
  }

  const parentDepth = parent.lineage?.depth ?? 0;
  const rawAncestors = [parent.baselineId, ...parentAncestors];
  const truncated = parent.lineage?.truncated === true || (parentDepth + 1) >= MAX_LINEAGE_DEPTH;
  const depth = truncated ? Math.min(parentDepth + 1, MAX_LINEAGE_DEPTH) : parentDepth + 1;
  const rootBaselineId = parent.lineage?.rootBaselineId ?? parent.baselineId;
  const ancestors = truncated ? rawAncestors.slice(0, MAX_LINEAGE_DEPTH) : rawAncestors;

  return {
    valid: blockers.length === 0,
    blockers,
    lineage: {
      parentBaselineId: parent.baselineId,
      rootBaselineId,
      depth,
      ancestors,
      truncated,
    },
  };
}

/** Throw when validation failed, listing every blocker. */
export function assertBaselineCandidate(result: BaselineValidationResult): void {
  if (result.safe) return;
  throw new BaselineError(
    `Refusing to create a baseline:\n${result.blockers.map((blocker) => `  - ${blocker}`).join('\n')}`,
  );
}
