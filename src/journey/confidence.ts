/**
 * Confidence scoring.
 *
 * Conservative by policy: a high score is only reachable when several
 * independent kinds of observable evidence agree, and any unresolved ambiguity
 * or missing prerequisite pulls the score down. Missing information can never
 * be offset by a strong match elsewhere in the plan.
 *
 * Pure and unit-testable; no I/O, no randomness.
 */

import type { RoleMatch, ScoredElement } from './match.js';
import { CONFIDENCE_BANDS } from './types.js';

/** Inputs to a per-step confidence calculation. */
export interface ConfidenceInput {
  /** How strong the best candidate is, 0..100. Null when nothing matched. */
  bestScore: number | null;
  /** How many candidates tied for the top score. */
  tiedCandidates: number;
  /** Candidates that matched but are hidden. */
  hiddenCount: number;
  /** Candidates that matched but are disabled. */
  disabledCount: number;
  /** Whether a stable locator is available for the best candidate. */
  hasLocator: boolean;
  /** Whether this step is a required one for the journey to make sense. */
  isRequired: boolean;
  /** Extra penalties applied by the caller, e.g. an ambiguous goal. */
  penalties?: number[];
}

/** Clamp to 0..1 with two decimals, for stable serialisation. */
function clamp(value: number): number {
  const bounded = Math.max(0, Math.min(1, value));
  return Math.round(bounded * 100) / 100;
}

/**
 * Convert match evidence into a 0..1 confidence.
 *
 * The curve is deliberately compressed: a perfect match with a clean locator
 * tops out around 0.95, not 1.0, because no Scout evidence can prove a journey
 * will actually succeed.
 */
export function scoreConfidence(input: ConfidenceInput): number {
  if (input.bestScore === null) {
    // Nothing matched at all: confidence is minimal regardless of penalties.
    return 0;
  }

  // Map a 0..100 relevance score onto 0..0.9. 100 is the practical maximum a
  // single match can reach (label + type + form + locator + visibility).
  let confidence = (input.bestScore / 100) * 0.9;

  // Ambiguity: two equally good candidates means the plan cannot say which one
  // it means, which is a real risk regardless of how well either matched.
  if (input.tiedCandidates > 1) {
    confidence *= 0.75;
  }

  // Hidden or disabled equivalents are usually a stronger signal than absence:
  // the control exists, but not in a state a user could interact with.
  if (input.hiddenCount > 0) confidence *= 0.85;
  if (input.disabledCount > 0) confidence *= 0.9;

  // A step with no usable locator cannot be turned into an action later.
  if (!input.hasLocator) confidence *= 0.6;

  for (const penalty of input.penalties ?? []) {
    confidence -= penalty;
  }

  return clamp(confidence);
}

/** Convenience wrapper for the common "score a role match" case. */
export function confidenceForMatch(match: RoleMatch, options: { isRequired: boolean; penalties?: number[] }): number {
  const best = bestCandidate(match);
  return scoreConfidence({
    bestScore: best?.score ?? null,
    tiedCandidates: match.ambiguous ? match.candidates.filter((c) => c.score === best?.score).length : 1,
    hiddenCount: match.hidden.length,
    disabledCount: match.disabled.length,
    hasLocator: Boolean(best?.locator),
    isRequired: options.isRequired,
    penalties: options.penalties,
  });
}

/** Highest-scoring planned candidate for a role, or `null`. */
export function bestCandidate(match: RoleMatch): ScoredElement | null {
  return match.candidates[0] ?? null;
}

/**
 * Confidence for the plan as a whole.
 *
 * Weighted toward the weakest required step, because a journey is only as
 * executable as its most important unresolved step.
 */
export function overallConfidence(stepConfidences: readonly { confidence: number; isRequired: boolean }[]): number {
  if (stepConfidences.length === 0) return 0;
  const required = stepConfidences.filter((step) => step.isRequired);
  const pool = required.length > 0 ? required : stepConfidences;
  const average = pool.reduce((sum, step) => sum + step.confidence, 0) / pool.length;
  const weakest = Math.min(...pool.map((step) => step.confidence));
  // Blends mean performance with the floor, so one bad required step shows.
  return clamp(average * 0.6 + weakest * 0.4);
}

/** True when a plan is too weak to act on without a warning. */
export function isLowConfidence(confidence: number): boolean {
  return confidence < CONFIDENCE_BANDS.reasonable;
}
