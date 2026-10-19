/**
 * Baseline identity and signal identity.
 *
 * Both are built on the **existing** Build 5 normalizer (`matchingKeyFor`) and
 * provenance, rather than a second matching algorithm. A baseline that used its
 * own notion of "the same signal" could disagree with reproduction about which
 * signals matched, and the two verdicts would then contradict each other.
 *
 * The journey hash covers canonical plan content only. A changed step, action or
 * confidence changes the hash, which is exactly how "the plan changed" becomes
 * detectable; a report path, timestamp or attempt number never enters it.
 */

import { createHash } from 'node:crypto';
import type { Anomaly } from '../anomaly/types.js';
import type { JourneyPlan } from '../journey/types.js';
import type { ExecutionReport } from '../executor/types.js';
import { matchingKeyFor } from '../reproducer/normalization.js';
import { safeTargetOrigin } from '../provenance/redaction.js';
import type { BaselineIdentity, BaselineSignal } from './types.js';

/**
 * Canonical journey content.
 *
 * Only fields that change *what the journey does* are included. Descriptive text
 * and the planner version are excluded, so a reworded description does not
 * invalidate an otherwise identical baseline - that would produce churn without
 * any behavioural difference.
 */
export function canonicalJourneyContent(journey: JourneyPlan): string {
  const steps = [...journey.steps]
    .map((step) => ({
      id: step.id,
      order: step.order,
      action: step.action,
      targetElementIds: [...(step.targetElementIds ?? [])].sort(),
      locatorCandidates: [...(step.locatorCandidates ?? [])].sort(),
    }))
    // Sorted by id so a reordered array cannot change the hash.
    .sort((a, b) => a.id.localeCompare(b.id));

  return JSON.stringify({
    goal: journey.normalizedGoal,
    journeyType: journey.journeyType,
    targetOrigin: safeTargetOrigin(journey.target.url).origin,
    steps,
  });
}

/** SHA-256 over the canonical journey content. */
export function journeyHash(journey: JourneyPlan): string {
  return `sha256:${createHash('sha256').update(canonicalJourneyContent(journey), 'utf8').digest('hex')}`;
}

/** Build the identity a baseline is stamped with. */
export function buildBaselineIdentity(
  journey: JourneyPlan,
  execution: ExecutionReport,
): BaselineIdentity {
  const environment = execution.environment ?? null;

  return {
    targetOrigin: safeTargetOrigin(execution.target.url ?? journey.target.url).origin,
    journeyHash: journeyHash(journey),
    journeySchemaVersion: journey.schemaVersion,
    journeyType: journey.journeyType,
    // Null when the source run predates Build 5.1. A missing fingerprint is
    // recorded as missing, never invented.
    environmentFingerprint: environment?.fingerprint ?? null,
    environmentId: environment?.application.environmentId ?? null,
    applicationBuildId: environment?.application.buildId ?? null,
    plannerVersion: environment?.source.plannerVersion ?? null,
    executorVersion: environment?.source.executorVersion ?? null,
  };
}

/**
 * Project an anomaly into the safe, comparable form stored in a baseline.
 *
 * @param accepted whether the operator knowingly accepted this signal.
 * @returns null when the signal has no stable key and cannot be compared.
 */
export function toBaselineSignal(anomaly: Anomaly, accepted: boolean): BaselineSignal | null {
  const signalKey = matchingKeyFor(anomaly);
  if (signalKey === null) return null;

  const detail = (key: string): string | null => {
    const value = anomaly.details?.[key];
    return value === null || value === undefined ? null : String(value);
  };
  const statusRaw = detail('statusCode');
  const status = statusRaw === null ? null : Number(statusRaw);

  return {
    signalKey,
    ruleId: anomaly.ruleId,
    kind: anomaly.kind,
    signalLevel: anomaly.signalLevel,
    statusCode: Number.isFinite(status) ? status : null,
    method: detail('method'),
    // Sanitized by the shared normalizer: no path, query or fragment.
    url: detail('url'),
    resourceType: detail('resourceType'),
    stepId: anomaly.stepId,
    accepted,
    anomalyId: anomaly.id,
  };
}

/**
 * Hash a signal key, for a compact stable reference in the candidate report.
 *
 * Hashing keeps the report readable and avoids re-printing a normalized URL that
 * might carry something sensitive in a shape the normalizer did not anticipate.
 */
export function signalKeyHash(signalKey: string): string {
  return `sha256:${createHash('sha256').update(signalKey, 'utf8').digest('hex')}`;
}
