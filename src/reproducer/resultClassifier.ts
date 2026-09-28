/**
 * Reproduction classification.
 *
 * The decision, in one place so it can be read and tested without a browser:
 *
 *   matching >= threshold  ->  reproduced
 *   matching == 0          ->  not-reproduced
 *   0 < matching < threshold, or the attempts could not settle it
 *                          ->  inconclusive
 *
 * The threshold exists because one hit out of three is a coincidence far more
 * often than a fault. Reporting it as `reproduced` would manufacture candidate
 * defects from noise.
 *
 * "Inconclusive" is a real outcome, not a failure of the tool. Mixed results, an
 * attempt that was blocked, or a signal with no stable key all mean the reruns
 * did not settle the question, and saying so is more useful than guessing.
 *
 * Pure and deterministic.
 */

import type { Anomaly } from '../anomaly/types.js';
import type { ReproductionClassification, ReproductionRun, IneligibilityReason } from './types.js';
import { REPRODUCTION_THRESHOLD } from './types.js';
import { matchingKeyFor, signalsMatch } from './normalization.js';

/** The outcome of comparing one original signal against every attempt. */
export interface MatchOutcome {
  classification: ReproductionClassification;
  matchingAttempts: number;
  completedAttempts: number;
  inconclusiveAttempts: number;
  /** Anomaly id within each attempt where a match was found. */
  matches: { attempt: number; anomalyId: string }[];
  reason: string;
}

/**
 * Compare one original signal against the attempts.
 *
 * @param attempts only attempts that actually ran, oldest first.
 */
export function classifyReproduction(original: Anomaly, attempts: readonly ReproductionRun[]): MatchOutcome {
  const completed = attempts.filter((run) => run.status === 'completed');
  const completedAttempts = completed.length;

  // Nothing ran, or nothing comparable ran.
  if (completedAttempts === 0) {
    return {
      classification: 'blocked',
      matchingAttempts: 0,
      completedAttempts: 0,
      inconclusiveAttempts: attempts.length,
      matches: [],
      reason:
        attempts.length === 0
          ? 'No controlled attempt ran, so the signal could not be reproduced.'
          : `None of the ${attempts.length} controlled attempt(s) completed, so the signal could not be evaluated.`,
    };
  }

  // A signal with no stable key cannot be compared at all. This is checked
  // here as well as at eligibility so a caller using this function directly is
  // protected.
  if (matchingKeyFor(original) === null) {
    return {
      classification: 'inconclusive',
      matchingAttempts: 0,
      completedAttempts,
      inconclusiveAttempts: completedAttempts,
      matches: [],
      reason: 'The signal has no stable evidence key, so attempts could not be compared reliably.',
    };
  }

  const matches: { attempt: number; anomalyId: string }[] = [];
  for (const run of completed) {
    const found = run.anomalies.anomalies.find((candidate) => signalsMatch(original, candidate));
    if (found) matches.push({ attempt: run.attempt, anomalyId: found.id });
  }

  const matchingAttempts = matches.length;

  if (matchingAttempts === 0) {
    return {
      classification: 'not-reproduced',
      matchingAttempts: 0,
      completedAttempts,
      inconclusiveAttempts: 0,
      matches: [],
      reason: `The same signal did not occur in any of the ${completedAttempts} controlled attempt(s).`,
    };
  }

  if (matchingAttempts >= REPRODUCTION_THRESHOLD) {
    const consistency =
      matchingAttempts === completedAttempts
        ? `all ${completedAttempts} controlled attempts`
        : `${matchingAttempts} of ${completedAttempts} controlled attempts`;
    return {
      classification: 'reproduced',
      matchingAttempts,
      completedAttempts,
      inconclusiveAttempts: 0,
      matches,
      reason: `The same signal occurred in ${consistency}.`,
    };
  }

  // Exactly one hit is not enough to call it reproduced.
  return {
    classification: 'inconclusive',
    matchingAttempts,
    completedAttempts,
    inconclusiveAttempts: 0,
    matches,
    reason:
      `The signal occurred in only 1 of ${completedAttempts} controlled attempts, ` +
      `below the threshold of ${REPRODUCTION_THRESHOLD}, so the result is inconclusive.`,
  };
}

/** The classification for a signal excluded before any attempt ran. */
export function ineligibleOutcome(reason: IneligibilityReason): ReproductionClassification {
  void reason;
  return 'ineligible';
}

/** Format a matching count as a ratio string. Never a probability. */
export function formatRatio(matching: number, completed: number): string {
  if (completed === 0) return '0/0';
  return `${matching}/${completed}`;
}
