/**
 * Redundant terminal-assertion detection.
 *
 * A generated journey ends with a placeholder step - "Define the expected
 * successful outcome" - that no executor can evaluate. When the journey's own
 * action already carries a structured postcondition measuring the same
 * observable outcome, that placeholder adds nothing: it is skipped, recorded as
 * unverified, and holds the whole run at partial verification forever.
 *
 * Removing it is only safe under a narrow rule, and this module is where that
 * rule lives so it can be tested without a planner or a browser:
 *
 *   A structured postcondition may replace a generic expectation only when it
 *   measures the same observable outcome.
 *
 * The default is to **keep** the assertion. A placeholder nobody can check is
 * annoying; a real expectation quietly deleted is a lie. So every condition
 * below must hold, and any doubt leaves the prose in place.
 *
 * Pure: no I/O, no Playwright, no module-level state.
 */

import type { JourneyStep, Postcondition } from './types.js';

/**
 * The planner's own terminal-assertion intent names.
 *
 * Matching on these is exact and far more reliable than string-matching the
 * prose: the planner generated them, so it knows their names. A hand-authored
 * plan with a user-written expectation will not carry one of these, and is
 * therefore never treated as a placeholder.
 */
const PLANNER_PLACEHOLDER_INTENTS = new Set([
  'define_login_success',
  'define_registration_success',
  'define_purchase_confirmation',
  'define_form_success',
  'define_search_results',
  'define_contact_success',
  'define_upload_success',
  'define_navigation_destination',
]);

/**
 * Generic placeholder prose, used as a second signal.
 *
 * Kept deliberately small and specific. A broad "contains 'expected'" rule would
 * match a real user expectation like "The expected total is 42.00" and delete it.
 */
const GENERIC_PLACEHOLDER_PHRASES = [
  'define the expected',
  'confirm the expected result',
  'verify that the action succeeds',
  'verify successful completion',
  'the expected confirmation text or state was not found',
  'is not represented in the scout report',
  'was not found in the scout report',
];

/** Actions whose postcondition can stand in for a terminal expectation. */
const POSTCONDITION_BEARING_ACTIONS = new Set(['submit', 'click']);

/**
 * Whether a step is the planner's own unevaluable placeholder.
 *
 * Requires *all* of: an `assert` action, no structured assertion, no target,
 * no usable locator, a recognised planner intent, and generic prose. A step
 * failing any of those is a real expectation and is never a candidate.
 */
export function isGenericPlaceholderAssertion(step: JourneyStep): boolean {
  if (step.action !== 'assert') return false;
  // A structured assertion is machine-checkable, so it is not a placeholder.
  if (step.assertion !== undefined) return false;
  if (step.targetElementIds.length > 0) return false;
  if (step.locatorCandidates.some((candidate) => candidate.trim() !== '')) return false;
  if (!PLANNER_PLACEHOLDER_INTENTS.has(step.intent)) return false;

  const prose = `${step.description} ${step.expectedOutcome}`.toLowerCase();
  return GENERIC_PLACEHOLDER_PHRASES.some((phrase) => prose.includes(phrase));
}

/** A step that carries at least one postcondition. */
function postconditionsOf(step: JourneyStep): Postcondition[] {
  return Array.isArray(step.postconditions) ? step.postconditions : [];
}

/** True when a postcondition is safe to evaluate. */
function isEvaluablePostcondition(postcondition: Postcondition): boolean {
  if (postcondition.type === 'url-path') return postcondition.expectedPath.trim() !== '';
  if (postcondition.type === 'url-origin') return postcondition.expectedOrigin.trim() !== '';
  return false;
}

/**
 * Whether a postcondition measures the same outcome a placeholder describes.
 *
 * A placeholder says only "did the expected thing happen" - it names no
 * specific business condition. A URL postcondition therefore covers it, because
 * "the browser reached the declared destination" is exactly the observable
 * outcome available. It does **not** extend to any unstated business claim,
 * which is why the coverage test is about the placeholder's own vagueness rather
 * than about the postcondition's strength.
 *
 * Exported separately from the removal decision so the two ideas stay
 * separable and testable.
 */
export function coversExpectedOutcome(postcondition: Postcondition): boolean {
  if (!isEvaluablePostcondition(postcondition)) return false;
  // Both postcondition types describe navigation to a declared destination, which
  // is the most a generic placeholder can be said to expect.
  return postcondition.type === 'url-path' || postcondition.type === 'url-origin';
}

/** The outcome a step's postconditions verify, for truthful wording. */
export function describePostconditionOutcome(postcondition: Postcondition): string {
  switch (postcondition.type) {
    case 'url-path':
      return `The page reaches the declared path ${postcondition.expectedPath}.`;
    case 'url-origin':
      return `The page reaches the declared origin ${postcondition.expectedOrigin}.`;
    default:
      return 'The declared destination is reached.';
  }
}

/** Why a placeholder was kept, for a plan's assumptions. */
export interface RetentionReason {
  stepId: string;
  reason: string;
}

/**
 * Decide which terminal placeholders a postcondition-covered step makes redundant.
 *
 * @param steps the built plan, in order.
 * @returns the step ids to drop, and why any placeholder was retained.
 */
export function planAssertionCleanup(
  steps: readonly JourneyStep[],
): { remove: string[]; retained: RetentionReason[] } {
  const remove: string[] = [];
  const retained: RetentionReason[] = [];

  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    if (step === undefined) continue;
    if (!isGenericPlaceholderAssertion(step)) continue;

    // Only a postcondition-bearing action *earlier* in the journey can cover
    // this expectation. Looking forward would let a later action justify
    // deleting an assertion that runs before it.
    const covered = steps
      .slice(0, index)
      .some(
        (previous) =>
          POSTCONDITION_BEARING_ACTIONS.has(previous.action) &&
          postconditionsOf(previous).some(
            (postcondition) => isEvaluablePostcondition(postcondition) && coversExpectedOutcome(postcondition),
          ),
      );

    if (covered) {
      remove.push(step.id);
      continue;
    }

    // No usable destination was observed, so the honest placeholder stays and
    // the run remains partially verified.
    retained.push({
      stepId: step.id,
      reason:
        step.intent === 'define_navigation_destination'
          ? 'No evaluated postcondition covers this destination expectation.'
          : 'No postcondition was derived, so this expectation remains unverified.',
    });
  }

  return { remove, retained };
}

/**
 * Rewrite a step's `expectedOutcome` to describe what its postcondition checks.
 *
 * The point is truthfulness: a step whose postcondition proves navigation must
 * not also claim a business outcome. Existing prose is replaced only when a
 * postcondition is present, and never for a step that has none.
 */
export function rewordExpectedOutcome(step: JourneyStep): string {
  const postconditions = postconditionsOf(step).filter(isEvaluablePostcondition);
  if (postconditions.length === 0) return step.expectedOutcome;

  // A step with a real structured assertion keeps its own wording: that
  // assertion, not the postcondition, is the primary claim.
  if (step.assertion !== undefined) return step.expectedOutcome;

  const described = postconditions.map(describePostconditionOutcome).join(' ');
  // Say what was checked and stop there. No order, payment, delivery or
  // persistence claim is implied or added.
  return `${described} This confirms navigation, not that the operation succeeded.`;
}
