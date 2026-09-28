/**
 * Environment comparison.
 *
 * Answers one question: did the original signal and its reruns happen in the
 * same recorded environment?
 *
 * The result is **context for the reproduction verdict, never a change to it.**
 * A signal that reproduces across different environments is still
 * `reproduced`; the difference is recorded alongside so a reader can weigh it.
 * Letting provenance overturn a classification would make the two verdicts
 * contradict each other, and the classification is the one backed by evidence.
 *
 * `unknown` is a first-class answer, not a failure. A legacy report has no
 * provenance, and comparing against nothing would produce a meaningless
 * `different`.
 *
 * Pure.
 */

import { FINGERPRINT_FIELDS, fingerprintPayload } from './fingerprint.js';
import type { FingerprintInput } from './types.js';
import type { EnvironmentComparison, EnvironmentComparisonResult, EnvironmentReference } from './types.js';

/** One attempt's environment, as recorded. */
export interface AttemptEnvironment {
  attempt: number;
  fingerprint: string | null;
  environmentId: string | null;
  applicationBuildId: string | null;
}

/** The environment a signal was first observed in. */
export interface OriginalEnvironment {
  fingerprint: string | null;
  environmentId: string | null;
  applicationBuildId: string | null;
}

/**
 * Compare one original environment against the attempts.
 *
 * Only the fingerprint and the two caller-supplied identifiers are used. The
 * comparison deliberately does not read `origin` or the browser fields: those
 * are already inside the fingerprint, and naming them individually would claim
 * to know *which* field diverged when only the hash is known.
 *
 * @param original the environment the signal was first observed in.
 * @param attempts the environments the reruns happened in, in order.
 */
export function compareEnvironments(
  original: OriginalEnvironment | EnvironmentReference | null,
  attempts: readonly AttemptEnvironment[],
): EnvironmentComparisonResult {
  // No provenance anywhere: nothing to compare, and inventing a verdict would
  // be worse than saying so.
  if (original === null || original.fingerprint === null) {
    return {
      classification: 'unknown',
      differences: [],
      unknownReason:
        'Environment provenance is unavailable for the original execution report, so environments could not be compared.',
    };
  }

  const usable = attempts.filter((attempt) => attempt.fingerprint !== null);
  if (usable.length === 0) {
    return {
      classification: 'unknown',
      differences: [],
      unknownReason: 'No controlled attempt recorded environment provenance, so environments could not be compared.',
    };
  }

  const differences = new Set<string>();
  let anyDifference = false;

  for (const attempt of usable) {
    if (attempt.fingerprint === null) continue;

    if (attempt.fingerprint === original.fingerprint) continue;

    anyDifference = true;

    // A differing fingerprint means at least one recorded field differs. The
    // caller-supplied identifiers are named first, because those are the
    // fields a reader can act on; anything else is reported as an unidentified
    // difference in the hashed inputs, because naming a specific field would
    // claim more than the hash can tell us.
    if (original.environmentId !== attempt.environmentId) differences.add('environmentId');
    if (original.applicationBuildId !== attempt.applicationBuildId) differences.add('applicationBuildId');
    if (differences.size === 0) differences.add('fingerprintInputs');
  }

  if (!anyDifference) {
    return { classification: 'same', differences: [], unknownReason: null };
  }

  // When the fingerprints differ but no named identifier explains it, say so
  // explicitly rather than implying a specific field was identified.
  const named = [...differences].filter((field) => field !== 'fingerprintInputs');
  return {
    classification: 'different',
    differences: named.length > 0 ? named.sort() : ['fingerprintInputs'],
    unknownReason: null,
  };
}

/** Human-readable wording for an environment comparison. */
export function describeComparison(
  classification: EnvironmentComparison,
  differences: readonly string[] = [],
): string {
  switch (classification) {
    case 'same':
      return 'Reproduced in the same recorded environment.';
    case 'different':
      return differences.length > 0
        ? `Reproduced across different recorded environments (differing: ${differences.join(', ')}).`
        : 'Reproduced across different recorded environments.';
    case 'unknown':
    default:
      return 'Reproduction occurred, but provenance was incomplete.';
  }
}

/** Exported for tests that need to reason about the canonical payload. */
export { FINGERPRINT_FIELDS, fingerprintPayload };
export type { FingerprintInput };
