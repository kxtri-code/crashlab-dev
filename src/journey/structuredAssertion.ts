/**
 * Structured journey assertions.
 *
 * A structured assertion says *what will be checked* in a form a browser can
 * check. It exists because a prose expectation - "the cart page is opened" -
 * cannot be evaluated, so every generated journey ended partially verified with
 * its last step unverified.
 *
 * The governing rule is that **an assertion may only restate what Scout already
 * observed.** Every assertion carries a `source` naming the Scout element or
 * field it was read from, and the generators below refuse rather than infer:
 * no expected URL, no expected text, and no success condition is ever derived
 * from the goal's wording or from what a page "should" do.
 *
 * That is also why the prose fallback stays. A generated journey for a login
 * form has no observable postcondition in the Scout report, so it keeps prose
 * and stays partially verified - which is the honest answer, and better than a
 * confident assertion that cannot fail.
 *
 * Pure and Playwright-free: it reads a Scout report and returns data.
 */

import type { StructuredAssertion, TextContainsAssertion, UrlOriginAssertion, UrlPathAssertion } from './types.js';
import type { InteractiveElement, ScoutReport } from '../scout/types.js';

/** Assertion types the executor can evaluate. */
export const ASSERTION_TYPES = [
  'element-present',
  'element-visible',
  'element-enabled',
  'text-contains',
  'url-origin',
  'url-path',
] as const;

export type AssertionType = (typeof ASSERTION_TYPES)[number];

/** Text that must never become an expected value. */
const SENSITIVE_TEXT =
  /\b(?:password|passwd|secret|token|api[_-]?key|authorization|bearer|cookie|cvv|cvc|ssn|card\s?number|otp|pin)\b/i;

/** Input types whose value must never be read or asserted on. */
const SENSITIVE_INPUT_TYPES = new Set(['password', 'hidden', 'file', 'email', 'tel', 'number', 'date']);

/**
 * A route segment that looks generated rather than declared.
 *
 * The UUID alternative spells the real 8-4-4-4-12 shape rather than a
 * generalised "hex group with dashes": a pattern written as
 * `{4}(-hex{4}){n}` never matches a UUID, because a UUID's first group is eight
 * characters, and a guard that silently fails to fire is worse than no guard.
 *
 * The alternation is anchored, so a segment must match a shape in full to count
 * as generated.
 */
const DYNAMIC_PATH_SEGMENT =
  /^(?:[0-9A-HJKMNP-TV-Z]{26}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|\d{4}-\d{2}-\d{2}|[a-zA-Z0-9]{16,}|\d+|[0-9a-fA-F]{8,})$/i;

/** Normalize a path: no query, no fragment, no trailing slash, always rooted. */
export function normalizePath(value: string): string {
  try {
    const parsed = new URL(value, 'https://placeholder.invalid');
    const path = parsed.pathname.replace(/\/+$/, '');
    return path === '' ? '/' : path;
  } catch {
    const withoutQuery = value.split('?')[0] ?? value;
    const withoutFragment = withoutQuery.split('#')[0] ?? withoutQuery;
    const normalized = withoutFragment.replace(/\/+$/, '');
    if (normalized === '') return '/';
    return normalized.startsWith('/') ? normalized : `/${normalized}`;
  }
}

/** Normalize an origin, discarding path, query and fragment. */
export function normalizeOrigin(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'file:') return null;
    return parsed.origin === 'null' ? null : parsed.origin;
  } catch {
    return null;
  }
}

/** Collapse whitespace deterministically, for expected text. */
export function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Whether a path is safe to assert on.
 *
 * A segment that looks generated means the route is data-dependent, and
 * asserting on it would either fail spuriously or pass for the wrong reason.
 */
export function isStablePath(value: string): boolean {
  const path = normalizePath(value);
  return !path.split('/').some((segment) => segment !== '' && DYNAMIC_PATH_SEGMENT.test(segment));
}

/** True when text is safe to use as an expected value. */
export function isSafeExpectedText(value: string): boolean {
  const text = normalizeText(value);
  if (text.length === 0) return false;
  // Long prose is an expectation nobody can check meaningfully.
  if (text.length > 80) return false;
  if (SENSITIVE_TEXT.test(text)) return false;
  return true;
}

/** True when an element's value must never be read. */
function isSecretBearing(element: InteractiveElement): boolean {
  if (element.type === 'input' && SENSITIVE_INPUT_TYPES.has((element.inputType ?? '').toLowerCase())) return true;
  if (element.type === 'textarea') return true;
  if (!element.visible) return true;
  return false;
}

/** The element a source reference names, if the report still has it. */
function elementFor(report: ScoutReport, elementId: string | undefined): InteractiveElement | null {
  if (elementId === undefined) return null;
  return report.interactiveElements.find((element) => `element-${String(element.index + 1).padStart(3, '0')}` === elementId) ?? null;
}

/**
 * Validate an assertion object read from a plan file.
 *
 * A malformed assertion is rejected rather than half-executed: the executor
 * treats it as unverified, which is the same safe outcome as having none.
 */
export function validateStructuredAssertion(value: unknown): StructuredAssertion | null {
  if (!isRecord(value)) return null;
  const type = value['type'];
  if (typeof type !== 'string' || !(ASSERTION_TYPES as readonly string[]).includes(type)) return null;

  const source = value['source'];
  if (!isRecord(source) || typeof source['kind'] !== 'string') return null;

  const base = { source: source as unknown as StructuredAssertion['source'] };

  switch (type) {
    case 'element-present':
    case 'element-visible':
    case 'element-enabled': {
      // The target lives on the step, not the assertion, so there is nothing
      // extra to require here beyond a traceable source.
      return { type, ...base } as StructuredAssertion;
    }
    case 'text-contains': {
      const expectedText = value['expectedText'];
      if (typeof expectedText !== 'string') return null;
      if (expectedText.trim() === '') return null;
      return {
        type: 'text-contains',
        expectedText: normalizeText(expectedText),
        match: value['match'] === 'exact' ? 'exact' : 'substring',
        source: base.source,
      } satisfies TextContainsAssertion;
    }
    case 'url-origin': {
      const expectedOrigin = value['expectedOrigin'];
      if (typeof expectedOrigin !== 'string') return null;
      const origin = normalizeOrigin(expectedOrigin);
      if (origin === null) return null;
      return { type: 'url-origin', expectedOrigin: origin, match: 'exact', source: base.source } satisfies UrlOriginAssertion;
    }
    case 'url-path': {
      const expectedPath = value['expectedPath'];
      if (typeof expectedPath !== 'string') return null;
      const path = normalizePath(expectedPath);
      if (!isStablePath(path)) return null;
      return { type: 'url-path', expectedPath: path, match: 'exact', source: base.source } satisfies UrlPathAssertion;
    }
    default:
      return null;
  }
}

/** True for a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** What the generator found, and why it declined when it found nothing. */
export interface AssertionCandidate {
  assertion: StructuredAssertion;
  /** A traceable locator, when the element supports one. */
  locator: string | null;
  targetElementIds: string[];
  /** Why the generator is confident, for the plan's assumptions. */
  rationale: string;
}

/** What a generation attempt produced. */
export type AssertionGeneration =
  | { kind: 'generated'; candidate: AssertionCandidate }
  | { kind: 'declined'; reason: string };

/**
 * Derive a post-action assertion from what Scout observed.
 *
 * `href` is the link or form action the journey's own click step already
 * targets, so the expectation is the *declared destination of a control the
 * plan was going to click* - not a guess about where the page should lead.
 *
 * Nothing here reads the goal's wording. Every value comes from the Scout
 * report, which is why a journey with no observable postcondition declines and
 * keeps its prose expectation.
 */
export function generatePostActionAssertion(
  report: ScoutReport,
  options: { href: string; elementId: string; field: 'href' | 'action' },
): AssertionGeneration {
  const href = options.href;
  if (typeof href !== 'string' || href.trim() === '') {
    return { kind: 'declined', reason: 'The control declares no destination, so no URL expectation can be read from it.' };
  }

  const element = elementFor(report, options.elementId);
  if (element !== null && isSecretBearing(element)) {
    return { kind: 'declined', reason: 'The control is secret-bearing, so no expectation is derived from it.' };
  }

  const path = normalizePath(href);

  // A route with a generated segment is data-dependent: asserting on it would
  // fail spuriously or pass for the wrong reason.
  if (!isStablePath(path)) {
    return {
      kind: 'declined',
      reason: `The declared path "${path}" contains a value that looks generated, so it is not a stable expectation.`,
    };
  }

  const origin = normalizeOrigin(href);
  const pageOrigin = normalizeOrigin(report.target.inputUrl);

  // Prefer the more specific expectation, but only when the destination is on
  // the same origin the journey is already authorized against. A link to
  // another site is not this journey's postcondition.
  if (origin !== null && pageOrigin !== null && origin === pageOrigin) {
    return {
      kind: 'generated',
      candidate: {
        assertion: {
          type: 'url-path',
          expectedPath: path,
          match: 'exact',
          source: { kind: options.field === 'action' ? 'scout-form-action' : 'scout-href', elementId: options.elementId, field: options.field },
        },
        locator: null,
        targetElementIds: [options.elementId],
        rationale: `The ${options.field === 'action' ? 'form action' : 'link destination'} declares "${path}" on the authorized origin.`,
      },
    };
  }

  if (origin !== null) {
    return {
      kind: 'generated',
      candidate: {
        assertion: {
          type: 'url-origin',
          expectedOrigin: origin,
          match: 'exact',
          source: { kind: options.field === 'action' ? 'scout-form-action' : 'scout-href', elementId: options.elementId, field: options.field },
        },
        locator: null,
        targetElementIds: [options.elementId],
        rationale: `The declared destination is on origin ${origin}.`,
      },
    };
  }

  return {
    kind: 'declined',
    reason: 'The declared destination is not an absolute URL on a known origin, so no URL expectation can be read from it.',
  };
}

/**
 * Derive a visible-element assertion from a Scout-observed confirmation text.
 *
 * Used only when Scout actually saw the text. A confirmation that appeared
 * *after* the action cannot be read at Scout time, so this deliberately does
 * not attempt to predict one.
 */
export function generateVisibleTextAssertion(
  report: ScoutReport,
  options: { expectedText: string; elementId: string; locator: string },
): AssertionGeneration {
  if (!isSafeExpectedText(options.expectedText)) {
    return {
      kind: 'declined',
      reason: 'The observed text is empty, too long, or secret-bearing, so it is not a safe expectation.',
    };
  }
  if (!options.locator.trim() || !options.elementId.trim()) {
    return { kind: 'declined', reason: 'The observed text has no stable locator, so it cannot be asserted on.' };
  }

  return {
    kind: 'generated',
    candidate: {
      assertion: {
        type: 'text-contains',
        expectedText: normalizeText(options.expectedText),
        match: 'substring',
        source: { kind: 'scout-visible-text', elementId: options.elementId, field: 'text' },
      },
      locator: options.locator,
      targetElementIds: [options.elementId],
      rationale: `Scout observed the text "${normalizeText(options.expectedText)}" on ${options.elementId}.`,
    },
  };
}

/**
 * Derive a presence or visibility assertion for a control the journey will
 * interact with.
 *
 * This asserts only that the control is still there, never that using it
 * succeeded, which is what makes it safe as a postcondition.
 */
export function generateTargetElementAssertion(
  report: ScoutReport,
  options: { elementId: string; locator: string; require?: 'present' | 'visible' | 'enabled' },
): AssertionGeneration {
  const kind = options.require ?? 'present';
  const element = elementFor(report, options.elementId);

  if (element === null) {
    return { kind: 'declined', reason: `${options.elementId} is not present in the Scout report.` };
  }
  if (isSecretBearing(element)) {
    return {
      kind: 'declined',
      reason: `${options.elementId} is a secret-bearing or hidden control, so no expectation is derived from it.`,
    };
  }
  if (!options.locator.trim()) {
    return { kind: 'declined', reason: `${options.elementId} has no stable locator, so it cannot be asserted on.` };
  }
  if (kind === 'enabled' && !element.enabled) {
    return {
      kind: 'declined',
      reason: `${options.elementId} is disabled in the Scout report, so asserting it stays enabled would be false.`,
    };
  }

  const type = kind === 'present' ? 'element-present' : kind === 'visible' ? 'element-visible' : 'element-enabled';

  return {
    kind: 'generated',
    candidate: {
      assertion: { type, source: { kind: 'scout-element', elementId: options.elementId } } as StructuredAssertion,
      locator: options.locator,
      targetElementIds: [options.elementId],
      rationale: `${options.elementId} was observed ${kind} in the Scout report.`,
    },
  };
}
