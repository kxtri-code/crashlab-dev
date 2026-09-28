/**
 * Baseline compatibility.
 *
 * Decides whether a current run may be compared against a baseline **at all**.
 * Everything downstream depends on this, because a wrong comparison here
 * produces confident, wrong candidate verdicts rather than an obvious failure.
 *
 * The order of checks is deliberate, from most disqualifying to least:
 *
 *  1. **journey hash** - a different plan means the signal sets describe
 *     different work, so no comparison is meaningful at all
 *  2. **application build** - a different build is a different application, so
 *     "persistent" and "resolved" would both be unsafe
 *  3. **environment fingerprint** - a different environment changes behaviour,
 *     so "novel" would be unsafe
 *
 * Pure.
 */

import type { Baseline, BaselineIdentity } from '../baseline/types.js';
import type { ReviewComparison } from './types.js';

/** The outcome of a compatibility check. */
export interface CompatibilityResult {
  comparable: boolean;
  classification: ReviewComparison;
  /** Named identity differences, for the report. */
  differences: string[];
  /** Why the comparison is impossible, when it is. */
  reason: string | null;
  /** Field names that may be compared directly. */
  matchedFields: string[];
}

/** Identity fields that must match exactly for a set comparison. */
const REQUIRED_FIELDS = ['targetOrigin', 'journeyHash', 'journeySchemaVersion', 'journeyType'] as const;

/** Compare a current identity against a baseline's. */
export function checkCompatibility(current: BaselineIdentity, baseline: Baseline | null): CompatibilityResult {
  if (baseline === null) {
    return {
      comparable: false,
      classification: 'no-baseline',
      differences: [],
      reason: 'No baseline was supplied, so nothing can be compared. Absence of a baseline means unknown, not novel.',
      matchedFields: [],
    };
  }

  const differences: string[] = [];
  const matchedFields: string[] = [];

  for (const field of REQUIRED_FIELDS) {
    if (current[field] === baseline.identity[field]) matchedFields.push(field);
    else differences.push(field);
  }

  // A different target origin is a different application. It has to be its own
  // check, not just another entry in `differences`: the journey checks below
  // look only at journey fields, so an origin mismatch would otherwise fall
  // through and be reported as a comparable run against a different app.
  if (differences.includes('targetOrigin')) {
    return {
      comparable: false,
      classification: 'incompatible-journey',
      differences: differences.sort(),
      reason:
        'The target origin differs from the baseline. Signals from two different applications are never compared.',
      matchedFields,
    };
  }

  // A different journey is not a comparison, it is a different piece of work.
  // Reporting its signals as novel or resolved would be actively misleading.
  if (differences.includes('journeyHash') || differences.includes('journeyType')) {
    return {
      comparable: false,
      classification: 'incompatible-journey',
      differences: differences.sort(),
      reason:
        'The journey plan differs from the baseline, so the two signal sets describe different work and are not compared.',
      matchedFields,
    };
  }

  if (differences.includes('journeySchemaVersion')) {
    return {
      comparable: false,
      classification: 'incompatible-journey',
      differences: differences.sort(),
      reason: 'The journey schema version differs from the baseline.',
      matchedFields,
    };
  }

  // Build identity. A null on one side is tolerated, because an operator who
  // did not supply a build id is not claiming a build.
  const currentBuild = current.applicationBuildId;
  const baselineBuild = baseline.identity.applicationBuildId;
  if (currentBuild !== null && baselineBuild !== null && currentBuild !== baselineBuild) {
    return {
      comparable: false,
      classification: 'different-build',
      differences: [...new Set([...differences, 'applicationBuildId'])].sort(),
      reason:
        'The application build differs from the baseline. A signal present in a different build is neither persistent nor resolved.',
      matchedFields,
    };
  }

  // Environment provenance. Without a fingerprint on either side, an
  // environment comparison is impossible - and an invented one would be worse.
  if (current.environmentFingerprint === null || baseline.identity.environmentFingerprint === null) {
    return {
      comparable: true,
      classification: 'unknown-environment',
      differences: [],
      reason: 'Environment provenance is missing, so the run cannot be placed in an environment.',
      matchedFields,
    };
  }

  if (current.environmentFingerprint !== baseline.identity.environmentFingerprint) {
    const environmentDifferences = describeEnvironmentDifference(current, baseline.identity);
    return {
      comparable: true,
      // Comparable in shape, but not treated as an identical environment.
      classification: 'different-environment',
      differences: environmentDifferences,
      reason:
        'The recorded environment differs from the baseline. Signals are reported as cross-environment rather than novel or persistent.',
      matchedFields,
    };
  }

  return {
    comparable: true,
    classification: 'same-environment',
    differences: [],
    reason: null,
    matchedFields,
  };
}

/**
 * Name the safe environment fields that differ.
 *
 * The fingerprint is a hash, so it cannot say *which* field diverged. Naming the
 * caller-supplied identifiers is honest; anything else is reported as an
 * unidentified difference rather than guessed at.
 */
function describeEnvironmentDifference(current: BaselineIdentity, baseline: BaselineIdentity): string[] {
  const differences: string[] = [];
  if (current.environmentId !== baseline.environmentId) differences.push('environmentId');
  if (current.applicationBuildId !== baseline.applicationBuildId) differences.push('applicationBuildId');
  if (differences.length === 0) differences.push('fingerprintInputs');
  return differences.sort();
}
