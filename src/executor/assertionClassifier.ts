/**
 * Assertion classification.
 *
 * Build 2 plans end with a prose step like "Define the expected successful
 * outcome" - natural language with no target and no machine-readable rule.
 * Nothing can evaluate that, and Build 3 must not pretend otherwise.
 *
 * The classification exists so the executor can tell three cases apart that used
 * to look alike:
 *
 *  - a **structured** assertion, which has a target and can be evaluated
 *  - a **prose-only** assertion, which cannot be evaluated and is therefore
 *    unverified rather than passed or failed
 *  - an **invalid** one, which claims a target it cannot name
 *
 * Pure, so the distinction is testable without a browser.
 */

import type { JourneyStep } from '../journey/types.js';
import type { SkipReason } from './types.js';

/** How an assertion step can be handled. */
export type AssertionVerdict =
  /** A target and a usable locator exist, so the expectation can be evaluated. */
  | { kind: 'structured'; locator: string }
  /**
   * Natural language with nothing machine-readable behind it. The expectation
   * is neither confirmed nor refuted; the step is skipped and unverified.
   */
  | { kind: 'prose-only'; skipReason: 'unsupported-prose-assertion'; reason: string }
  /** A targeted assertion whose expectation is still only prose. */
  | { kind: 'targeted-prose'; skipReason: 'unsupported-prose-assertion'; reason: string }
  /** Not an assertion at all. */
  | { kind: 'not-an-assertion' };

/** True when the step carries at least one usable locator. */
function hasUsableLocator(step: JourneyStep): boolean {
  return step.locatorCandidates.some((candidate) => typeof candidate === 'string' && candidate.trim() !== '');
}

/** True when the step names a target element. */
function hasTargetElement(step: JourneyStep): boolean {
  return Array.isArray(step.targetElementIds) && step.targetElementIds.length > 0;
}

/**
 * Classify one plan step.
 *
 * Only `assert` steps reach a verdict; everything else is `not-an-assertion` and
 * is handled by its own action.
 */
export function classifyAssertion(step: JourneyStep): AssertionVerdict {
  if (step.action !== 'assert') return { kind: 'not-an-assertion' };

  const targeted = hasTargetElement(step) || hasUsableLocator(step);

  if (!targeted) {
    // The common Build 2 shape: a final prose expectation with no target at all.
    return {
      kind: 'prose-only',
      skipReason: 'unsupported-prose-assertion',
      reason:
        'The assertion is natural language with no deterministic target or assertion rule. ' +
        'It was not evaluated, so the expected outcome is unverified rather than passed or failed.',
    };
  }

  // A target exists and can be located. Build 3's deterministic assertion
  // (the element is present, visible, enabled) is a real, machine-readable
  // check, so it is evaluated exactly as it always was. The prose outcome stays
  // a note, not the thing being verified.
  if (hasUsableLocator(step)) {
    return { kind: 'structured', locator: step.locatorCandidates.find((c) => c.trim() !== '') as string };
  }

  if (hasTargetElement(step)) {
    // A target is named but no locator resolves it, so there is nothing to
    // evaluate. Recorded as unverified rather than refused.
    return {
      kind: 'targeted-prose',
      skipReason: 'unsupported-prose-assertion',
      reason:
        'The assertion names a target element, but supplies no usable locator to reach it. ' +
        'The expectation was not evaluated, so it is unverified rather than passed or failed.',
    };
  }

  // The common Build 2 shape: a final prose expectation with no target at all.
  return {
    kind: 'prose-only',
    skipReason: 'unsupported-prose-assertion',
    reason:
      'The assertion is natural language with no deterministic target or assertion rule. ' +
      'It was not evaluated, so the expected outcome is unverified rather than passed or failed.',
  };
}

/** True when a step's expectation cannot be evaluated deterministically. */
export function isUnverifiableAssertion(step: JourneyStep): boolean {
  const verdict = classifyAssertion(step);
  return verdict.kind === 'prose-only' || verdict.kind === 'targeted-prose';
}

/** Human-readable summary of a skip decision, for a step result. */
export function skipReasonFor(step: JourneyStep): { skipReason: SkipReason; reason: string } | null {
  const verdict = classifyAssertion(step);
  if (verdict.kind === 'prose-only' || verdict.kind === 'targeted-prose') {
    return { skipReason: verdict.skipReason, reason: verdict.reason };
  }
  return null;
}
