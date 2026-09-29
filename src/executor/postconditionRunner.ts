/**
 * Postcondition evaluation.
 *
 * Runs immediately after a submit action, and answers one narrow question: did
 * the browser land where the form's own `action` said it would?
 *
 * A matched postcondition means navigation happened. It is not evidence that an
 * order was placed, a payment cleared, or a message was delivered — those need
 * their own evidence-backed assertion, and this module deliberately cannot
 * speak to them.
 *
 * The wait for navigation is bounded by the run's existing timeout and uses the
 * same primitive the executor already uses. There are no arbitrary sleeps: a
 * fixed delay would be a guess about the target's speed, and a guess that turns
 * into a false "not-matched" on a slow machine.
 */

import type { Page } from 'playwright';
import type { Postcondition } from '../journey/types.js';
import { normalizePath } from '../journey/structuredAssertion.js';

/** How a postcondition turned out. */
export type PostconditionResult = 'matched' | 'not-matched' | 'unevaluable';

/** A safe, structured record of one postcondition check. */
export interface PostconditionOutcome {
  type: Postcondition['type'];
  status: 'passed' | 'failed' | 'unverified';
  result: PostconditionResult;
  /** Only for URL postconditions: the safe value actually observed. */
  actualOrigin?: string | null;
  actualPath?: string;
  /** Present only when unevaluable. */
  reason?: string;
}

/** Read the current URL, tolerating a torn-down or error page. */
async function currentUrl(page: Page): Promise<URL | null> {
  try {
    const raw = page.url();
    if (raw === '' || raw.startsWith('chrome-error:')) return null;
    return new URL(raw);
  } catch {
    return null;
  }
}

/**
 * Wait for the navigation a submit may trigger, without exceeding the budget.
 *
 * Resolves as soon as the page settles, and gives up at `timeoutMs` rather than
 * retrying. A timeout is not a failure: the URL is read afterwards either way,
 * and the postcondition is decided from what the page actually is.
 */
async function settleAfterSubmit(page: Page, timeoutMs: number): Promise<void> {
  try {
    // `domcontentloaded` resolves immediately when no navigation is pending, so
    // a submit that stays on the page costs nothing.
    await page.waitForLoadState('domcontentloaded', { timeout: Math.min(timeoutMs, 5000) });
  } catch {
    // A late or absent load is not itself a postcondition failure; the URL check
    // below decides the outcome.
  }
}

/**
 * Evaluate every postcondition attached to a step, after that step's action ran.
 */
export async function evaluatePostconditions(
  page: Page,
  postconditions: readonly Postcondition[],
  timeoutMs: number,
): Promise<PostconditionOutcome[]> {
  if (postconditions.length === 0) return [];

  await settleAfterSubmit(page, timeoutMs);
  const current = await currentUrl(page);

  return postconditions.map((postcondition) => {
    if (current === null) {
      return {
        type: postcondition.type,
        status: 'unverified' as const,
        result: 'unevaluable' as const,
        reason: 'The page URL could not be read after the submit, so the destination was not checked.',
      };
    }

    if (postcondition.type === 'url-origin') {
      const matched = current.origin === postcondition.expectedOrigin;
      return {
        type: postcondition.type,
        status: matched ? ('passed' as const) : ('failed' as const),
        result: matched ? ('matched' as const) : ('not-matched' as const),
        actualOrigin: current.origin,
      };
    }

    const actualPath = normalizePath(current.pathname);
    const matched =
      postcondition.match === 'prefix'
        ? actualPath.startsWith(postcondition.expectedPath)
        : actualPath === postcondition.expectedPath;

    return {
      type: postcondition.type,
      status: matched ? ('passed' as const) : ('failed' as const),
      result: matched ? ('matched' as const) : ('not-matched' as const),
      actualPath,
    };
  });
}

/** The worst outcome across a set of postconditions, for a step's status. */
export function worstOutcome(outcomes: readonly PostconditionOutcome[]): PostconditionResult | null {
  if (outcomes.length === 0) return null;
  if (outcomes.some((outcome) => outcome.result === 'not-matched')) return 'not-matched';
  if (outcomes.some((outcome) => outcome.result === 'unevaluable')) return 'unevaluable';
  return 'matched';
}
