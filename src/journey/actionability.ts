/**
 * Action eligibility.
 *
 * Build 2 originally emitted only `identify` and `assert` steps, which meant a
 * generated plan could never actually do anything. This module decides, from
 * Scout evidence alone, when a matched control is specific enough for a real
 * action to be planned against it.
 *
 * The bar is deliberately high, and the default is to stay inert:
 *
 *  - exactly one candidate, so the target is unambiguous
 *  - the candidate is visible and enabled
 *  - the match is *strong*, not merely present
 *  - the intent's text matched the element's own visible text exactly, so a
 *    control chosen by its label rather than its text is not clicked blindly
 *
 * Anything that falls short stays `identify`, because observing is safe and
 * guessing is not. A hidden or disabled control can never become an action.
 *
 * Pure and Playwright-free: this decides what a *plan* says, not what a browser
 * does. Execution re-verifies every one of these conditions against the live DOM
 * and can still block.
 */

import type { JourneyAction } from './types.js';
import type { RoleMatch, ScoredElement } from './match.js';

/** Why a step stayed inert instead of becoming an action. */
export interface IneligibilityReason {
  reason: string;
  detail: string;
}

/** The outcome of deciding whether a step can carry a real action. */
export interface ActionDecision {
  /** The action to plan. Defaults to the template's observation action. */
  action: JourneyAction;
  /** True when the step became a real, state-changing action. */
  actionable: boolean;
  /** Populated when `actionable` is false and something specific was found. */
  blockedBecause: IneligibilityReason | null;
}

/** Score at or above which a match is considered strong evidence. */
export const STRONG_MATCH_SCORE = 60;

/**
 * Normalised text used for the exact-text comparison.
 *
 * Deliberately strict: punctuation and case are significant, so "Buy now." is
 * not treated as the same control as "Buy now".
 */
function exactText(value: string | null): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

/** True when the element's own visible text is exactly one of these phrases. */
function hasExactText(candidate: ScoredElement, allowed: readonly string[]): boolean {
  const text = exactText(candidate.element.text).toLowerCase();
  if (text.length === 0) return false;
  return allowed.includes(text);
}

/**
 * Decide the action for a step given what the matcher found.
 *
 * @param observationAction the action to fall back to (usually `identify`).
 * @param requiredText exact element text that would justify the action.
 *   Empty means the text gate is skipped - used for field steps, where the
 *   element's identity comes from its label and type rather than a button name.
 */
export function decideAction(input: {
  match: RoleMatch | null;
  observationAction: JourneyAction;
  actionAction: JourneyAction;
  requiredText?: readonly string[];
}): ActionDecision {
  const { match, observationAction, actionAction, requiredText = [] } = input;

  if (!match || match.candidates.length === 0) {
    return { action: observationAction, actionable: false, blockedBecause: null };
  }

  // 1. Ambiguity: a tie is never resolved by the planner.
  if (match.ambiguous) {
    const tied = match.candidates.filter((candidate) => candidate.score === match.candidates[0]?.score);
    return {
      action: observationAction,
      actionable: false,
      blockedBecause: {
        reason: 'ambiguous-match',
        detail:
          `${tied.length} elements matched equally well ` +
          `(${tied.map((candidate) => candidate.elementId).join(', ')}), so no single action target can be chosen.`,
      },
    };
  }

  const best = match.candidates[0];
  if (!best) {
    return { action: observationAction, actionable: false, blockedBecause: null };
  }

  // 2. Hidden or disabled controls are never a normal action target.
  if (!best.element.visible) {
    return {
      action: observationAction,
      actionable: false,
      blockedBecause: {
        reason: 'hidden-control',
        detail: `The matched control (${best.elementId}) is not visible in the Scout report, so no action is planned against it.`,
      },
    };
  }
  if (!best.element.enabled) {
    return {
      action: observationAction,
      actionable: false,
      blockedBecause: {
        reason: 'disabled-control',
        detail: `The matched control (${best.elementId}) is disabled in the Scout report, so no action is planned against it.`,
      },
    };
  }

  // 3. A weak match is not specific enough to act on.
  if (best.score < STRONG_MATCH_SCORE) {
    return {
      action: observationAction,
      actionable: false,
      blockedBecause: {
        reason: 'weak-match',
        detail:
          `The best match (${best.elementId}, score ${best.score}) is below the ${STRONG_MATCH_SCORE} ` +
          'needed to plan a real action, so the step stays observational.',
      },
    };
  }

  // 4. Exact element text, when the role demands it. This is what stops a
  //    generic navigation link from becoming a purchase action.
  if (requiredText.length > 0 && !hasExactText(best, requiredText.map((text) => text.toLowerCase()))) {
    return {
      action: observationAction,
      actionable: false,
      blockedBecause: {
        reason: 'text-not-exact',
        detail:
          `The matched control (${best.elementId}) reads "${exactText(best.element.text)}", which is not an ` +
          `exact match for ${requiredText.map((text) => `"${text}"`).join(' or ')}.`,
      },
    };
  }

  // 5. A candidate with no usable locator cannot be turned into an action.
  if (!best.locator) {
    return {
      action: observationAction,
      actionable: false,
      blockedBecause: {
        reason: 'no-locator',
        detail: `The matched control (${best.elementId}) has no stable locator in the Scout report.`,
      },
    };
  }

  return { action: actionAction, actionable: true, blockedBecause: null };
}

/** Exact control texts that justify a purchase-related click. */
export const PURCHASE_ACTION_TEXTS = ['buy', 'buy now', 'add to cart', 'add to basket', 'select', 'choose', 'reserve', 'book'] as const;

/** Exact control texts that justify a sign-in or registration click. */
export const AUTH_ACTION_TEXTS = ['sign in', 'log in', 'login', 'sign up', 'register', 'create account', 'continue'] as const;

/** Exact control texts that justify a search or submit click. */
export const SUBMIT_ACTION_TEXTS = ['search', 'submit', 'send', 'apply', 'next', 'continue'] as const;
