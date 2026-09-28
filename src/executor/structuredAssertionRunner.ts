/**
 * Structured assertion evaluation.
 *
 * A structured assertion says what a browser can check. This evaluates it
 * against the live page and reports matched or not-matched, with a result
 * block that contains no secret.
 *
 * Two rules govern the result:
 *
 *  - **A failed assertion is not a confirmed bug.** It means the expectation did
 *    not hold this time. Whether that is a defect, a timing artefact or a
 *    changed page is not decided here.
 *  - **An unevaluable assertion is not a failure.** If it cannot be checked, the
 *    step is skipped and unverified, exactly as Build 6.1 treats prose.
 *
 * The only browser work is reading the current URL and querying the target
 * element's presence, visibility, enabled state and visible text.
 */

import type { Locator, Page } from 'playwright';
import type { JourneyStep, StructuredAssertion } from '../journey/types.js';
import { normalizePath, validateStructuredAssertion } from '../journey/structuredAssertion.js';

/** How an evaluated assertion turned out. */
export type AssertionResultKind = 'matched' | 'not-matched' | 'unevaluable';

/** A safe, structured record of what was checked. */
export interface AssertionOutcome {
  result: AssertionResultKind;
  type: StructuredAssertion['type'];
  /** Only for URL assertions: what the page actually was. */
  actualOrigin?: string | null;
  actualPath?: string;
  /** Only for element assertions: the target ids considered. */
  targetElementIds?: string[];
  /** A short factual message. Never an explanation of cause. */
  message: string;
  /** Present only when unevaluable, with the reason it could not be checked. */
  unevaluableReason?: string;
}

/** An element's observable state, for an element assertion. */
interface ElementState {
  present: boolean;
  visible: boolean;
  enabled: boolean;
  text: string;
}

/** Longest visible text read for a text assertion. */
const MAX_TEXT = 300;

/** Read an element's observable state without interacting with it. */
async function readElementState(locator: Locator): Promise<ElementState> {
  const count = await locator.count();
  if (count === 0) return { present: false, visible: false, enabled: false, text: '' };
  // An ambiguous target cannot be evaluated: picking one of several would make
  // the result depend on document order.
  if (count > 1) return { present: false, visible: false, enabled: false, text: '' };

  const state = await locator
    .first()
    .evaluate((node: Element) => {
      const style = window.getComputedStyle(node as HTMLElement);
      const rects = Array.prototype.slice.call((node as HTMLElement).getClientRects()) as DOMRect[];
      const hasBox = rects.some((rect) => rect.width > 0 && rect.height > 0);
      const input = node as HTMLInputElement;
      return {
        visible:
          style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && hasBox,
        enabled: input.disabled !== true && node.getAttribute('aria-disabled') !== 'true',
      };
    })
    .catch(() => ({ visible: false, enabled: false }));

  // innerText excludes hidden content and script, so a value typed into an
  // input - which is not part of innerText - is never read here.
  const text = await locator
    .first()
    .innerText({ timeout: 1000 })
    .catch(() => '');

  return {
    present: true,
    visible: state.visible,
    enabled: state.enabled,
    text: text.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT),
  };
}

/** Resolve a step's target locator, or null when it has none. */
function targetLocator(page: Page, step: JourneyStep): Locator | null {
  const candidate = step.locatorCandidates.find((entry) => entry.trim() !== '');
  if (candidate === undefined) return null;
  try {
    return page.locator(candidate);
  } catch {
    return null;
  }
}

/**
 * Evaluate a structured assertion.
 *
 * @returns the outcome, or `null` when the step carries no structured
 * assertion - in which case the caller keeps Build 6.1's prose behaviour.
 */
export async function evaluateStructuredAssertion(
  page: Page,
  step: JourneyStep,
): Promise<AssertionOutcome | null> {
  const parsed = validateStructuredAssertion(step.assertion);
  if (parsed === null) return null;

  // URL assertions need no element and work on any page.
  if (parsed.type === 'url-origin' || parsed.type === 'url-path') {
    let current: URL;
    try {
      current = new URL(page.url());
    } catch {
      return {
        result: 'unevaluable',
        type: parsed.type,
        message: 'The page URL could not be read, so the expectation was not checked.',
        unevaluableReason: 'unreadable-url',
      };
    }

    if (parsed.type === 'url-origin') {
      const matched = current.origin === parsed.expectedOrigin;
      return {
        result: matched ? 'matched' : 'not-matched',
        type: parsed.type,
        actualOrigin: current.origin,
        message: matched
          ? `The page origin is ${parsed.expectedOrigin}.`
          : `The page origin is ${current.origin}, which is not ${parsed.expectedOrigin}.`,
      };
    }

    const actualPath = normalizePath(current.pathname);
    const matched = parsed.match === 'prefix' ? actualPath.startsWith(parsed.expectedPath) : actualPath === parsed.expectedPath;
    return {
      result: matched ? 'matched' : 'not-matched',
      type: parsed.type,
      actualPath,
      message: matched
        ? `The page path is ${parsed.expectedPath}.`
        : `The page path is ${actualPath}, which is not ${parsed.expectedPath}.`,
    };
  }

  // Every remaining type needs a target element.
  const locator = targetLocator(page, step);
  if (locator === null) {
    return {
      result: 'unevaluable',
      type: parsed.type,
      targetElementIds: [...step.targetElementIds],
      message: 'The step supplies no usable locator, so the expectation was not checked.',
      unevaluableReason: 'no-locator',
    };
  }

  const state = await readElementState(locator);

  if (parsed.type === 'text-contains') {
    if (!state.present) {
      return {
        result: 'not-matched',
        type: parsed.type,
        targetElementIds: [...step.targetElementIds],
        message: 'The target element is not present, so it cannot contain the expected text.',
      };
    }
    const matched =
      parsed.match === 'exact' ? state.text === parsed.expectedText : state.text.includes(parsed.expectedText);
    return {
      result: matched ? 'matched' : 'not-matched',
      type: parsed.type,
      targetElementIds: [...step.targetElementIds],
      // The expected text is safe by construction; the page's own text is not
      // echoed, since it could contain a value the executor typed earlier.
      message: matched ? 'The target element contains the expected text.' : 'The target element does not contain the expected text.',
    };
  }

  const wantVisible = parsed.type === 'element-visible';
  const wantEnabled = parsed.type === 'element-enabled';
  const satisfied = wantVisible ? state.visible : wantEnabled ? state.enabled && state.present : state.present;

  return {
    result: satisfied ? 'matched' : 'not-matched',
    type: parsed.type,
    targetElementIds: [...step.targetElementIds],
    message: satisfied
      ? `The target element satisfies the ${parsed.type} expectation.`
      : `The target element does not satisfy the ${parsed.type} expectation.`,
  };
}
