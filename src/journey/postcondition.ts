/**
 * Stateful postconditions for submit actions.
 *
 * A form's postcondition is a different kind of claim from a journey's final
 * assertion. An assertion asks "did the outcome we expected happen?". A
 * postcondition asks "did this action lead where the action *said* it would?".
 *
 * That distinction is the whole point of this module, and the reason the
 * derivation is narrow:
 *
 *   > A form action destination is a navigation expectation. It is not proof of
 *   > business success.
 *
 * `<form action="/thank-you">` proves the browser was told to go there. It proves
 * nothing about whether the order was placed, the payment cleared, or the message
 * was delivered — those need their own evidence-backed assertion, which is why
 * this derives only URL postconditions and never a business outcome.
 *
 * A postcondition therefore cannot be laundered into a success claim. Matching one
 * means navigation happened, full stop.
 *
 * Pure and Playwright-free: it reads a Scout report and returns data.
 */

import type { StructuredAssertion } from './types.js';
import type { ScoutForm, ScoutReport } from '../scout/types.js';
import { isStablePath, normalizeOrigin, normalizePath, validateStructuredAssertion } from './structuredAssertion.js';

/** A postcondition the executor checks immediately after a submit. */
export type Postcondition = Extract<StructuredAssertion, { type: 'url-path' | 'url-origin' }>;

/** Why a form's action was not converted into a postcondition. */
export type PostconditionDeclineReason =
  | 'no-action-attribute'
  | 'empty-action'
  | 'javascript-destination'
  | 'unresolvable-destination'
  | 'dynamic-path'
  | 'cross-origin'
  | 'payment-form'
  | 'secret-bearing-path';

/** The outcome of a derivation attempt. */
export type PostconditionGeneration =
  | { kind: 'generated'; postcondition: Postcondition; rationale: string }
  | { kind: 'declined'; reason: PostconditionDeclineReason; detail: string };

/**
 * Words that mark a form as payment-adjacent.
 *
 * A payment-looking destination is not made safe by being a URL. `/payment-success`
 * describes where a charge form sends the browser; it is not permission to submit
 * one, so no postcondition is derived and the prose fallback stands.
 */
const PAYMENT_FORM_PATTERN =
  /\b(pay|payment|checkout|billing|invoice|card|credit|debit|wallet|transfer|remit|donat|subscription|renew)\b/i;

/** A path holding a value that is a secret rather than a route. */
const SECRET_PATH_PATTERN =
  /\b(token|secret|password|passwd|api[_-]?key|apikey|session|sessionid|sid|jwt|cvv|cvc|otp|nonce|signature|auth)\b/i;

/** An unresolved template placeholder such as `/orders/{id}` or `/x/:id`. */
const TEMPLATE_PLACEHOLDER_PATTERN = /(\{[^}]+\}|:[A-Za-z_]\w*|\$\{[^}]+\}|<[^>]+>)/;

/** Longest action value inspected before it is treated as a template, not a URL. */
const MAX_ACTION_LENGTH = 2000;

/**
 * Derive a postcondition from a form's declared action.
 *
 * @param form the Scout form record.
 * @param formId a stable identifier for traceability, normally the form's `id`
 *   or `selector`.
 * @param pageUrl the page the form was observed on, for origin comparison.
 */
export function deriveFormPostcondition(
  form: ScoutForm,
  formId: string,
  pageUrl: string,
): PostconditionGeneration {
  const action = form.action;

  // A form with no action attribute submits to itself, and a JavaScript-driven
  // form goes nowhere a URL could describe. Neither is a navigation we can
  // check, and inventing a destination is exactly what this refuses to do.
  if (action === null || action === undefined) {
    return {
      kind: 'declined',
      reason: 'no-action-attribute',
      detail: 'The form declares no action, so it submits to the current page and no destination is observable.',
    };
  }

  const trimmed = action.trim();
  if (trimmed === '') {
    return {
      kind: 'declined',
      reason: 'empty-action',
      detail: 'The form action is empty, so no destination is observable.',
    };
  }

  if (/^javascript:/i.test(trimmed)) {
    return {
      kind: 'declined',
      reason: 'javascript-destination',
      detail: 'The form submits through a JavaScript handler, and CrashLab does not execute code to discover a destination.',
    };
  }

  if (trimmed.length > MAX_ACTION_LENGTH) {
    return {
      kind: 'declined',
      reason: 'unresolvable-destination',
      detail: 'The form action is implausibly long and is treated as an unresolvable template.',
    };
  }

  if (TEMPLATE_PLACEHOLDER_PATTERN.test(trimmed)) {
    return {
      kind: 'declined',
      reason: 'unresolvable-destination',
      detail: `The form action "${trimmed.slice(0, 80)}" contains an unresolved placeholder, so it is not a fixed destination.`,
    };
  }

  // Payment-adjacent forms get no postcondition at all. A destination that looks
  // like a payment is a reason for extra caution, never a licence to submit one.
  if (PAYMENT_FORM_PATTERN.test(trimmed)) {
    return {
      kind: 'declined',
      reason: 'payment-form',
      detail: `The form action "${trimmed.slice(0, 80)}" is payment-adjacent, so no postcondition is derived and the prose fallback stands.`,
    };
  }

  let resolved: URL;
  try {
    // A relative action resolves against the page it was observed on, which is
    // how a browser would treat it.
    resolved = new URL(trimmed, pageUrl);
  } catch {
    return {
      kind: 'declined',
      reason: 'unresolvable-destination',
      detail: 'The form action could not be resolved into a URL.',
    };
  }

  if (resolved.protocol === 'javascript:' || resolved.protocol === 'data:') {
    return {
      kind: 'declined',
      reason: 'javascript-destination',
      detail: `The form action uses the ${resolved.protocol} scheme, which is not a navigable destination.`,
    };
  }

  const pageOrigin = normalizeOrigin(pageUrl);
  const actionOrigin = normalizeOrigin(resolved.href);

  // A cross-origin destination is not silently trusted. The executor already
  // blocks off-origin navigation; a postcondition for a destination the run is
  // not allowed to reach would be a claim CrashLab cannot check.
  if (actionOrigin === null || pageOrigin === null || actionOrigin !== pageOrigin) {
    return {
      kind: 'declined',
      reason: 'cross-origin',
      detail: 'Cross-origin form destination was not converted into an executable postcondition.',
    };
  }

  const path = normalizePath(resolved.pathname);

  if (SECRET_PATH_PATTERN.test(path)) {
    return {
      kind: 'declined',
      reason: 'secret-bearing-path',
      detail: `The form destination "${path}" looks secret-bearing, so it is not recorded as an expectation.`,
    };
  }

  // A path with a generated id is data-dependent: asserting on it would fail
  // spuriously on a correct run, or pass for the wrong reason.
  if (!isStablePath(path)) {
    return {
      kind: 'declined',
      reason: 'dynamic-path',
      detail: `The form destination "${path}" contains a value that looks generated, so it is not a stable expectation.`,
    };
  }

  return {
    kind: 'generated',
    postcondition: {
      type: 'url-path',
      expectedPath: path,
      match: 'exact',
      source: {
        kind: 'scout-form-action',
        elementId: formId,
        field: 'action',
      },
    },
    rationale: `The form declares action "${path}" on the authorized origin.`,
  };
}

/**
 * Validate a postcondition list read from a plan file.
 *
 * Only URL postconditions qualify. A malformed or unsupported entry is dropped
 * rather than carried, so the executor falls back to the plain submit path
 * instead of half-checking an expectation it cannot vouch for.
 */
export function validatePostconditions(value: unknown): Postcondition[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const validated: Postcondition[] = [];
  for (const entry of value) {
    const parsed = validateStructuredAssertion(entry);
    // Re-narrow: only the URL forms are postconditions, never an element or
    // text expectation, which belongs to a journey's final assertion.
    if (parsed !== null && (parsed.type === 'url-path' || parsed.type === 'url-origin')) {
      validated.push(parsed);
    }
  }
  return validated.length > 0 ? validated : undefined;
}

/** Where a step's element belongs to, or null when it is not in a form. */
export function formForElement(
  report: ScoutReport,
  elementId: string,
): { form: ScoutForm; formId: string } | null {
  const index = Number.parseInt(elementId.replace(/^element-/, ''), 10);
  if (!Number.isFinite(index)) return null;
  const element = report.interactiveElements.find((candidate) => candidate.index === index - 1);
  if (!element || element.formIndex === null || element.formIndex === undefined) return null;

  const form = report.forms[element.formIndex];
  if (!form) return null;

  // A stable, traceable id. The form's own `id` when it has one, otherwise its
  // selector, so the source points at something a reader can find in Scout.
  const formId = form.id ?? form.selector;
  if (typeof formId !== 'string' || formId.trim() === '') return null;

  return { form, formId };
}
