/**
 * Anomaly eligibility.
 *
 * Not every observed signal is worth rerunning. Two categories of signal are
 * excluded by default:
 *
 *  1. **Potentially expected signals.** A 404, a console warning, a repeated
 *     analytics beacon, or a redirect to an identity provider all reproduce
 *     perfectly and may be entirely correct. Spending browser attempts on them
 *     produces noise, and a reproduced 404 would look alarming while meaning
 *     nothing.
 *
 *  2. **Signals that did not come from an attempted action.** A skipped or
 *     blocked step is a decision CrashLab made, not something the application
 *     did. Rerunning a plan that will make the same decision again tells us
 *     nothing, so those are never reproduced.
 *
 * Pure, so the policy is directly assertable.
 */

import type { Anomaly } from '../anomaly/types.js';
import type { IneligibilityReason, ReproductionInput } from './types.js';
import { matchingKeyFor } from './normalization.js';

/** Rules reproduced by default: a genuine failure under controlled rerun. */
export const DEFAULT_ELIGIBLE_RULES: ReadonlySet<string> = new Set([
  'HTTP_5XX',
  'NETWORK_REQUEST_FAILED',
  'CONSOLE_ERROR',
  'PAGE_ERROR',
  'STEP_TIMEOUT',
  'TARGET_MISSING_AFTER_ACTION',
  'TARGET_DISABLED_AFTER_ACTION',
  'EXECUTION_ACTION_FAILED',
]);

/** Rules excluded by default, with the reason stated in the report. */
export const DEFAULT_INELIGIBLE_RULES: ReadonlyMap<string, string> = new Map([
  ['HTTP_4XX', 'HTTP_4XX is potentially expected and is excluded by default.'],
  ['CONSOLE_WARNING', 'CONSOLE_WARNING is potentially expected and is excluded by default.'],
  ['DUPLICATE_REQUEST', 'DUPLICATE_REQUEST is frequently legitimate polling or analytics and is excluded by default.'],
  ['UNEXPECTED_ORIGIN', 'UNEXPECTED_ORIGIN is frequently a routine provider redirect and is excluded by default.'],
  ['UNEXPECTED_REDIRECT', 'UNEXPECTED_REDIRECT is frequently a routine provider redirect and is excluded by default.'],
]);

/** Why a signal cannot or should not be rerun, or `null` when it is eligible. */
export function ineligibilityFor(anomaly: Anomaly, includePossiblyExpected: boolean): IneligibilityReason | null {
  // 1. Rule policy.
  const excluded = DEFAULT_INELIGIBLE_RULES.get(anomaly.ruleId);
  if (excluded !== undefined && !includePossiblyExpected) {
    return { code: 'rule-excluded', detail: excluded };
  }

  // 2. An informational signal is not a failure, whatever it is attached to.
  //    Spending a browser attempt to confirm that "a request repeated" or "a
  //    warning was logged" is not evidence of anything.
  if (anomaly.signalLevel === 'info') {
    return {
      code: 'skipped-step',
      detail: `Signal ${anomaly.id} is informational and is not evidence of a failure.`,
    };
  }

  // 3. No comparable evidence.
  if (matchingKeyFor(anomaly) === null) {
    return {
      code: 'no-stable-key',
      detail: `Signal ${anomaly.id} has no stable evidence key, so it cannot be compared between runs.`,
    };
  }

  return null;
}

/** Split the original signals into the ones to rerun and the reasons the rest are out. */
export function partitionEligible(
  anomalies: readonly Anomaly[],
  includePossiblyExpected: boolean,
): { eligible: Anomaly[]; ineligible: { anomaly: Anomaly; reason: IneligibilityReason }[] } {
  const eligible: Anomaly[] = [];
  const ineligible: { anomaly: Anomaly; reason: IneligibilityReason }[] = [];

  for (const anomaly of anomalies) {
    const reason = ineligibilityFor(anomaly, includePossiblyExpected);
    if (reason === null) eligible.push(anomaly);
    else ineligible.push({ anomaly, reason });
  }

  return { eligible, ineligible };
}

/** True when at least one signal is worth a browser attempt. */
export function hasEligibleSignals(input: Pick<ReproductionInput, 'anomalies' | 'includePossiblyExpected'>): boolean {
  return partitionEligible(input.anomalies.anomalies, input.includePossiblyExpected).eligible.length > 0;
}
