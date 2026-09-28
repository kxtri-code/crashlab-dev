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
import { BaselineError } from './types.js';

/** Execution statuses from which a baseline may be created. */
const ACCEPTABLE_EXECUTION_STATUSES = new Set(['passed', 'partial']);

/** Signal levels that must be explicitly accepted before a baseline is clean. */
const UNRESOLVED_LEVELS = new Set(['error']);

/** Everything the validator needs. */
export interface BaselineValidationInput {
  execution: ExecutionReport;
  anomalies: AnomalyReport;
  journey: JourneyPlan;
  /** Anomaly ids the operator explicitly accepted. */
  acceptedSignalIds: string[];
  /** Paths, echoed into any error so the operator knows which file. */
  paths?: { execution: string; anomalies: string; journey: string };
}

/** The outcome of a validation. */
export interface BaselineValidationResult {
  /** True when a baseline may be created. */
  safe: boolean;
  /** Problems that make the run unusable as a baseline. */
  blockers: string[];
  /** Warnings worth recording without blocking. */
  warnings: string[];
  /** Signal ids the operator accepted, after validation. */
  acceptedSignalIds: string[];
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

  const failedSteps = stepStatuses.filter((stepStatus) => stepStatus === 'failed').length;
  if (failedSteps > 0) {
    warnings.push(`${failedSteps} step(s) failed in the source execution.`);
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

  return {
    safe: blockers.length === 0,
    blockers,
    warnings,
    acceptedSignalIds: [...known].sort(),
  };
}

/** Throw when validation failed, listing every blocker. */
export function assertBaselineCandidate(result: BaselineValidationResult): void {
  if (result.safe) return;
  throw new BaselineError(
    `Refusing to create a baseline:\n${result.blockers.map((blocker) => `  - ${blocker}`).join('\n')}`,
  );
}
