/**
 * Locator resolution.
 *
 * A step may only be acted on through a locator the *plan* supplied. The
 * executor never invents a selector, never falls back to text matching that
 * the planner did not choose, and never silently picks one of several
 * candidates.
 *
 * Build 2 emits Playwright-flavoured strings (`page.getByRole('button', { name:
 * 'Buy' })`) as the common case, and the raw CSS `selector` as the fallback.
 * Only those two shapes are honoured. Anything else is refused as unsupported
 * rather than guessed at, because guessing means executing something the
 * planner never proposed.
 *
 * Resolution is deliberately strict: a locator must match exactly one element,
 * and for an interactive action that element must be visible and enabled.
 */

import type { Locator, Page } from 'playwright';
import type { JourneyStep } from '../journey/types.js';
import type { BlockReason, StepObservations } from './types.js';

/** What a resolution attempt produced. */
export type LocatorResolution =
  | {
      ok: true;
      locator: Locator;
      /** The exact plan string that was used. */
      selectedLocator: string;
      observations: StepObservations;
    }
  | {
      ok: false;
      reason: BlockReason;
      message: string;
      attemptedLocators: string[];
      observations: StepObservations | null;
    };

/**
 * True when a plan string looks like a Playwright locator expression.
 *
 * Deliberately narrow: the supported forms are enumerated rather than matched
 * loosely, so an unexpected string is refused instead of half-supported.
 */
export function isPlaywrightLocatorExpression(candidate: string): boolean {
  const trimmed = candidate.trim();
  return /^page\.(getByTestId|getByRole|getByLabel|getByPlaceholder|getByText|getByAltText|locator)\(/.test(trimmed);
}

/** True when a plan string looks like a plain CSS selector. */
export function isCssSelector(candidate: string): boolean {
  const trimmed = candidate.trim();
  if (!trimmed) return false;
  // Reject anything that looks like code or a path, which would indicate the
  // plan contains a non-selector string.
  if (/[(){};]/.test(trimmed)) return false;
  if (/^[a-z]+:\/\//i.test(trimmed)) return false;
  return /^[.#\[a-zA-Z*]/.test(trimmed);
}

/**
 * Convert a Playwright locator expression into a callable.
 *
 * The grammar accepted here is exactly what Build 2's `suggestLocator` emits:
 * a `getBy*` call with positional string arguments, and an optional trailing
 * options object for `getByRole`. The arguments are read as literals - no
 * expression is evaluated - so a plan string cannot execute arbitrary code.
 */
type CompiledLocator = (page: Page) => Locator;

/** Escape a single-quoted string body the way Playwright's own output does. */
function unquote(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length < 2) return null;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
    const body = trimmed.slice(1, -1);
    return body.replace(/\\(['"\\])/g, '$1');
  }
  return null;
}

/** Split a call's argument list on top-level commas. */
function splitArguments(args: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';

  for (const char of args) {
    if (quote) {
      current += char;
      if (char === quote && !current.endsWith(`\\${quote}`)) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === '(' || char === '[' || char === '{') depth++;
    if (char === ')' || char === ']' || char === '}') depth--;
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/** Find the matching close paren for the first `(` at or after `start`. */
function findMatchingParen(input: string, start: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < input.length; i++) {
    const char = input[i];
    if (quote) {
      if (char === quote && input[i - 1] !== '\\') quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '(') depth++;
    if (char === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Compile a supported Playwright locator expression, or return null. */
export function compileLocatorExpression(candidate: string): CompiledLocator | null {
  const trimmed = candidate.trim();
  const match = /^page\.(getByTestId|getByRole|getByLabel|getByPlaceholder|getByText|getByAltText|locator)\(/.exec(trimmed);
  if (!match) return null;

  const method = match[1] as string;
  const openParen = trimmed.indexOf('(', match[0].length - 1);
  const closeParen = findMatchingParen(trimmed, openParen);
  if (closeParen < 0) return null;

  // Anything after the call other than a trailing `)` or `;` is not understood.
  const tail = trimmed.slice(closeParen + 1).trim().replace(/;$/, '').trim();
  if (tail !== '') return null;

  const args = splitArguments(trimmed.slice(openParen + 1, closeParen));
  if (args.length === 0) return null;

  // `locator()` may take a raw CSS string; the getBy* methods take literals.
  const first = unquote(args[0] ?? '');
  if (first === null) return null;

  if (method === 'locator') {
    return (page) => page.locator(first);
  }

  if (args.length > 2) return null;

  // An optional trailing `{ name: '...' }` object, as emitted by getByRole.
  // The first argument is the role for getByRole, and a literal for every
  // other getBy* method.
  let name: string | null = null;
  if (args.length === 2) {
    const second = args[1] ?? '';
    if (!/^\{.*\}$/.test(second)) return null;
    const nameMatch = /name\s*:\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/.exec(second);
    if (!nameMatch) return null;
    name = unquote(nameMatch[1] ?? '');
    if (name === null) return null;
  }

  // getByRole takes the role first, so it is the only method with two args.
  if (method === 'getByRole' && name !== null) {
    const role = first;
    return (page) => page.getByRole(role as Parameters<Page['getByRole']>[0], { name: name as string });
  }

  return (page) => {
    const anyPage = page as unknown as Record<string, (...args: unknown[]) => Locator>;
    const fn = anyPage[method];
    if (typeof fn !== 'function') throw new Error(`Unsupported locator method: ${method}`);
    return name === null ? fn.call(page, first) : fn.call(page, first, { name });
  };
}

/** Compile any supported plan string, or return null when unsupported. */
export function compilePlanLocator(candidate: string): CompiledLocator | null {
  if (isPlaywrightLocatorExpression(candidate)) return compileLocatorExpression(candidate);
  if (isCssSelector(candidate)) {
    return (page) => page.locator(candidate.trim());
  }
  return null;
}

/** Read existence, visibility, enabled state and tag for a locator. */
export async function observeLocator(locator: Locator, matchCount: number): Promise<StepObservations> {
  if (matchCount === 0) {
    return { exists: false, visible: false, enabled: false, tag: null, matchCount: 0 };
  }

  const state = await locator
    .first()
    .evaluate((node: Element) => {
      const style = window.getComputedStyle(node as HTMLElement);
      const rects = Array.prototype.slice.call((node as HTMLElement).getClientRects()) as DOMRect[];
      const hasBox = rects.some((rect) => rect.width > 0 && rect.height > 0);
      const disabledAttribute = (node as HTMLInputElement).disabled === true;
      const ariaDisabled = node.getAttribute('aria-disabled') === 'true';
      const fieldsetDisabled = node.closest('fieldset[disabled]') !== null;
      return {
        visible: style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && hasBox,
        enabled: !disabledAttribute && !ariaDisabled && !fieldsetDisabled,
        tag: node.tagName.toLowerCase(),
      };
    })
    .catch(() => null);

  return {
    exists: true,
    visible: state?.visible ?? false,
    enabled: state?.enabled ?? false,
    tag: state?.tag ?? null,
    matchCount,
  };
}

/** How a step wants its target treated, which decides how strict to be. */
export type ResolutionIntent = 'observe' | 'interact';

/**
 * Resolve a step's target from the plan's locator candidates, in order.
 *
 * Never falls back to an element the plan did not name, and never picks a
 * random one of several matches.
 */
export async function resolveStepTarget(
  page: Page,
  step: JourneyStep,
  intent: ResolutionIntent = 'interact',
): Promise<LocatorResolution> {
  const attempted: string[] = [...step.locatorCandidates];

  if (attempted.length === 0) {
    return {
      ok: false,
      reason: 'no-locator-provided',
      message:
        `Step "${step.id}" has no locatorCandidates. The planner did not identify a target, ` +
        'so the executor will not search the page for one.',
      attemptedLocators: [],
      observations: null,
    };
  }

  for (const candidate of attempted) {
    const compiled = compilePlanLocator(candidate);
    if (!compiled) {
      continue;
    }

    let locator: Locator;
    try {
      locator = compiled(page);
    } catch {
      continue;
    }

    let matchCount = 0;
    try {
      matchCount = await locator.count();
    } catch {
      continue;
    }

    if (matchCount === 0) continue;

    if (matchCount > 1) {
      return {
        ok: false,
        reason: 'locator-ambiguous',
        message:
          `Step "${step.id}" locator ${candidate} matched ${matchCount} elements. ` +
          'The executor does not choose one arbitrarily; re-scout the page or disambiguate the plan.',
        attemptedLocators: attempted,
        observations: null,
      };
    }

    const observations = await observeLocator(locator, matchCount);

    if (intent === 'observe') {
      // Observation tolerates a hidden or disabled control: "is it present and
      // why can it not be used" is exactly what an observe step should report.
      return { ok: true, locator, selectedLocator: candidate, observations };
    }

    if (!observations.visible) {
      return {
        ok: false,
        reason: 'element-hidden',
        message: `Step "${step.id}" target (${candidate}) is present but not visible, so it was not interacted with.`,
        attemptedLocators: attempted,
        observations,
      };
    }
    if (!observations.enabled) {
      return {
        ok: false,
        reason: 'element-disabled',
        message: `Step "${step.id}" target (${candidate}) is present but disabled, so it was not interacted with.`,
        attemptedLocators: attempted,
        observations,
      };
    }

    return { ok: true, locator, selectedLocator: candidate, observations };
  }

  // Every candidate was either unsupported or matched nothing.
  const unsupported = attempted.filter((candidate) => compilePlanLocator(candidate) === null);
  if (unsupported.length === attempted.length) {
    return {
      ok: false,
      reason: 'locator-unsupported',
      message:
        `Step "${step.id}" locatorCandidates are not in a form the executor supports ` +
        `(Playwright getBy*/locator expressions and CSS selectors only): ${unsupported.join(', ')}.`,
      attemptedLocators: attempted,
      observations: null,
    };
  }

  return {
    ok: false,
    reason: 'locator-not-found',
    message: `Step "${step.id}" target was not found on the page. Attempted: ${attempted.join(', ')}.`,
    attemptedLocators: attempted,
    observations: null,
  };
}
