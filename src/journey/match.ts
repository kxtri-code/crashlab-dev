/**
 * Deterministic element matching.
 *
 * Pure: given the same Scout elements and the same goal, it always returns the
 * same ranked candidates. Relevance is scored from observable Scout evidence
 * only, and the score is decomposed so a step's confidence can be explained
 * rather than asserted.
 *
 * Safety rules enforced here:
 *  - Hidden elements are never promoted to normal user journey controls. They
 *    are returned separately so a step can say "a field exists but is hidden".
 *  - `value` is never read, so no hidden input value can leak into a plan.
 */

import type { InteractiveElement, ScoutForm } from '../scout/types.js';
import type { JourneyType } from './types.js';
import { elementIdFor } from './scoutLoader.js';

/** What a step is looking for in the DOM. */
export type ElementRole =
  | 'email_field'
  | 'username_field'
  | 'password_field'
  | 'confirm_password_field'
  | 'name_field'
  | 'search_field'
  | 'message_field'
  | 'text_field'
  | 'select_field'
  | 'file_field'
  | 'submit_control'
  | 'login_control'
  | 'register_control'
  | 'add_to_cart_control'
  | 'checkout_control'
  | 'buy_control'
  | 'ticket_control'
  | 'search_control'
  | 'contact_control'
  | 'upload_control'
  | 'product_card'
  | 'quantity_control'
  | 'payment_control'
  | 'link'
  | 'generic_control';

/** A scored match, with the reasons that produced the score. */
export interface ScoredElement {
  element: InteractiveElement;
  /** Stable id used in journey output. */
  elementId: string;
  role: ElementRole;
  /** 0..100, higher is more relevant. */
  score: number;
  /** Human-readable reasons, sorted, for plan assumptions. */
  reasons: string[];
  /** Field used to reach the element in the journey step. */
  locator: string | null;
}

/** Result of matching one role against the page. */
export interface RoleMatch {
  role: ElementRole;
  /** Visible, enabled candidates, best first. Deterministically ordered. */
  candidates: ScoredElement[];
  /** Hidden candidates, kept for reporting but never planned as controls. */
  hidden: ScoredElement[];
  /** Disabled candidates, kept for reporting but never planned as controls. */
  disabled: ScoredElement[];
  /** True when more than one candidate ties for the top score. */
  ambiguous: boolean;
}

/** Text fields a role will accept, in priority order. */
export interface RoleSpec {
  role: ElementRole;
  /** Input `type` values that satisfy the role. */
  inputTypes?: readonly string[];
  /** Element types that satisfy the role. */
  elementTypes?: readonly string[];
  /** Text matched against label / name / placeholder / aria-label / text. */
  labelPatterns?: readonly RegExp[];
  /** Text matched against an element's own visible text. */
  textPatterns?: readonly RegExp[];
  /** When true, an element with no matching text still qualifies structurally. */
  structuralMatch?: boolean;
  /** Substrings that positively disqualify an otherwise structural match. */
  negativePatterns?: readonly RegExp[];
  /** Extra score when the element is inside a form. */
  formBonus?: number;
}

/** Score awarded to a text match, higher for the more specific fields. */
const SCORE = {
  labelExact: 60,
  labelPartial: 40,
  nameOrId: 30,
  placeholder: 26,
  ariaLabel: 24,
  textExact: 46,
  textPartial: 30,
  structural: 18,
  inputType: 22,
  insideForm: 10,
  hasStableLocator: 8,
  visible: 6,
  enabled: 4,
} as const;

/** How elements are compared for ranking, in the spec's required order. */
function compareCandidates(a: ScoredElement, b: ScoredElement): number {
  return (
    b.score - a.score ||
    Number(b.element.visible) - Number(a.element.visible) ||
    Number(b.element.enabled) - Number(a.element.enabled) ||
    a.element.index - b.element.index ||
    a.elementId.localeCompare(b.elementId)
  );
}

/** All text a matcher will look at, as separate labelled sources. */
function searchableText(element: InteractiveElement): { label: string; name: string; text: string } {
  return {
    label: [element.label, element.placeholder, element.ariaLabel].filter(Boolean).join(' ').toLowerCase(),
    name: [element.name, element.id].filter(Boolean).join(' ').toLowerCase(),
    text: (element.text ?? '').toLowerCase(),
  };
}

/** The best locator string available for an element, or `null`. */
export function bestLocator(element: InteractiveElement): string | null {
  if (element.locator && element.locator.trim()) return element.locator.trim();
  if (element.selector && element.selector.trim()) return element.selector.trim();
  return null;
}

/**
 * Score one element against one role spec.
 *
 * @returns the score and reasons, or `null` when the element does not qualify.
 */
function scoreElement(
  element: InteractiveElement,
  spec: RoleSpec,
  goalTokens: ReadonlySet<string>,
): { score: number; reasons: string[] } | null {
  const reasons: string[] = [];
  let score = 0;

  // Negative disqualifiers apply before anything else, so a "Sign out" button
  // never matches a "sign in" goal.
  const haystack = searchableText(element);
  const combined = `${haystack.label} ${haystack.name} ${haystack.text}`;
  if (spec.negativePatterns?.some((pattern) => pattern.test(combined))) {
    return null;
  }

  // Tag/type is a *filter* for every role: a `select` is never a password
  // field. It is deliberately not a score contribution, because a bare type
  // match would otherwise make every button a candidate for every control
  // role and bury the real matches in noise.
  if (spec.elementTypes && !spec.elementTypes.includes(element.type)) return null;
  if (spec.inputTypes) {
    const type = (element.inputType ?? '').toLowerCase();
    if (type) {
      // An element that declares an input type must match it, or be structural.
      if (!spec.inputTypes.includes(type) && !spec.structuralMatch) return null;
      if (spec.inputTypes.includes(type)) {
        score += SCORE.inputType;
        reasons.push(`input type="${type}"`);
      }
    }
    // A `select`, `button` or link has no input type, so the list simply does
    // not apply to it - a quantity `<select>` is a legitimate quantity control.
  } else if (!spec.textPatterns?.length && !spec.labelPatterns?.length) {
    // A spec with neither input types nor text patterns would otherwise accept
    // every element of the right tag (every `select`, for instance).
    if (!spec.structuralMatch) return null;
  }

  // A role that declares text patterns requires text evidence. Without this
  // gate, `elementTypes` alone would let an unrelated link satisfy a
  // "checkout control" role.
  const needsText = Boolean(spec.labelPatterns?.length || spec.textPatterns?.length);
  let matchedText = false;

  // Label-ish text (label / placeholder / aria-label).
  if (spec.labelPatterns) {
    for (const pattern of spec.labelPatterns) {
      const match = pattern.exec(haystack.label);
      if (match) {
        score += pattern.source.includes('^') && match[0] === haystack.label.trim() ? SCORE.labelExact : SCORE.labelPartial;
        reasons.push(`label matches /${pattern.source}/`);
        matchedText = true;
        break;
      }
    }
  }

  // Name and id are stable, machine-meaningful handles.
  if (spec.labelPatterns?.some((pattern) => pattern.test(haystack.name))) {
    score += SCORE.nameOrId;
    reasons.push('name or id is descriptive');
    matchedText = true;
  }

  // The element's own visible text.
  if (spec.textPatterns) {
    for (const pattern of spec.textPatterns) {
      const match = pattern.exec(haystack.text);
      if (match) {
        score += match[0] === haystack.text.trim() ? SCORE.textExact : SCORE.textPartial;
        reasons.push(`text matches /${pattern.source}/`);
        matchedText = true;
        break;
      }
    }
  }

  if (needsText && !matchedText && !spec.structuralMatch) return null;

  // Direct overlap between the goal and the element's text is strong evidence
  // that this element is what the user meant.
  if (goalTokens.size > 0) {
    const elementTokens = new Set(combined.split(/[^a-z0-9]+/).filter(Boolean));
    for (const token of goalTokens) {
      if (token.length < 3) continue;
      if (elementTokens.has(token)) {
        score += 12;
        reasons.push(`shares goal term "${token}"`);
      }
    }
  }

  if (score === 0 && !spec.structuralMatch) return null;

  if (spec.elementTypes?.includes(element.type) && spec.structuralMatch) {
    score += SCORE.structural;
  }
  if (element.formIndex !== null) {
    score += spec.formBonus ?? 0;
    reasons.push('belongs to a form');
  }
  if (bestLocator(element)) {
    score += SCORE.hasStableLocator;
  }
  if (element.visible) {
    score += SCORE.visible;
  }
  if (element.enabled) {
    score += SCORE.enabled;
  }

  return { score, reasons: [...new Set(reasons)].sort() };
}

/**
 * Match every element against a role and split the result into planned
 * candidates versus reported-only hidden/disabled matches.
 */
export function matchRole(
  elements: readonly InteractiveElement[],
  spec: RoleSpec,
  goalTokens: ReadonlySet<string> = new Set(),
): RoleMatch {
  const candidates: ScoredElement[] = [];
  const hidden: ScoredElement[] = [];
  const disabled: ScoredElement[] = [];

  for (const element of elements) {
    const scored = scoreElement(element, spec, goalTokens);
    if (!scored) continue;

    const entry: ScoredElement = {
      element,
      elementId: elementIdFor(element.index),
      role: spec.role,
      score: scored.score,
      reasons: scored.reasons,
      locator: bestLocator(element),
    };

    // Hidden and disabled elements are reported, never planned. Visibility is
    // checked first: a hidden element is hidden whether or not it is also
    // disabled, and it must not slip into the candidate list.
    if (!element.visible) hidden.push(entry);
    else if (!element.enabled) disabled.push(entry);
    else candidates.push(entry);
  }

  candidates.sort(compareCandidates);
  hidden.sort(compareCandidates);
  disabled.sort(compareCandidates);

  const topScore = candidates[0]?.score ?? null;
  const ambiguous =
    candidates.length > 1 && topScore !== null && candidates.filter((c) => c.score === topScore).length > 1;

  return { role: spec.role, candidates, hidden, disabled, ambiguous };
}

/** Match a set of roles at once, preserving the given role order. */
export function matchRoles(
  elements: readonly InteractiveElement[],
  specs: readonly RoleSpec[],
  goalTokens: ReadonlySet<string> = new Set(),
): Map<ElementRole, RoleMatch> {
  const results = new Map<ElementRole, RoleMatch>();
  for (const spec of specs) {
    results.set(spec.role, matchRole(elements, spec, goalTokens));
  }
  return results;
}

// --- Role specifications per journey type ---------------------------------

/** Roles a login journey looks for, in plan order. */
export const LOGIN_ROLES: readonly RoleSpec[] = [
  {
    role: 'login_control',
    elementTypes: ['button', 'input', 'link'],
    textPatterns: [/^(sign in|log in|login|signin|log on|continue|submit|authenticate|next)$/],
    labelPatterns: [/^(sign in|log in|login|continue|authenticate)/],
    negativePatterns: [/sign out|signout|log out|logout|register|sign up|forgot/],
  },
  {
    role: 'username_field',
    elementTypes: ['input'],
    inputTypes: ['text', 'email', 'tel'],
    labelPatterns: [/user ?name/, /^user$/, /login/, /e-?mail/, /account/],
    negativePatterns: [/password|confirm|search|coupon|phone/],
  },
  {
    role: 'password_field',
    elementTypes: ['input'],
    inputTypes: ['password'],
    labelPatterns: [/pass ?word/, /^pass$/, /pwd/],
  },
  {
    role: 'submit_control',
    elementTypes: ['button', 'input'],
    textPatterns: [/^(sign in|log in|login|submit|continue|authenticate)$/],
    negativePatterns: [/sign out|log out|register|sign up|forgot|cancel/],
  },
];

/** Roles a registration journey looks for. */
export const REGISTRATION_ROLES: readonly RoleSpec[] = [
  {
    role: 'register_control',
    elementTypes: ['button', 'input', 'link'],
    textPatterns: [/^(sign up|signup|register|create account|join|submit|continue|next)$/],
    labelPatterns: [/^(sign up|register|create)/],
    negativePatterns: [/sign in|log in|login|already have/],
  },
  {
    role: 'name_field',
    elementTypes: ['input'],
    inputTypes: ['text'],
    labelPatterns: [/full name/, /^name$/, /first name/, /last name/, /display name/],
  },
  {
    role: 'username_field',
    elementTypes: ['input'],
    inputTypes: ['text', 'email'],
    labelPatterns: [/user ?name/, /^user$/, /e-?mail/],
    negativePatterns: [/password|confirm/],
  },
  {
    role: 'password_field',
    elementTypes: ['input'],
    inputTypes: ['password'],
    labelPatterns: [/pass ?word/, /^pass$/, /pwd/],
    negativePatterns: [/confirm/],
  },
  {
    role: 'confirm_password_field',
    elementTypes: ['input'],
    inputTypes: ['password'],
    labelPatterns: [/confirm/, /re-?enter/, /verify/, /repeat/],
  },
  {
    role: 'submit_control',
    elementTypes: ['button', 'input'],
    textPatterns: [/^(sign up|signup|register|create account|join|submit|continue|next)$/],
    negativePatterns: [/sign in|log in|login|cancel|already have/],
  },
];

/** Roles a checkout or purchase journey looks for. */
export const CHECKOUT_ROLES: readonly RoleSpec[] = [
  {
    role: 'product_card',
    elementTypes: ['link', 'button', 'other'],
    textPatterns: [/^(buy|buy now|add to cart|add to basket|select|choose|view|details|view details)$/],
    labelPatterns: [/(add to cart|buy now|add to basket)/],
    negativePatterns: [/remove|delete|wishlist|compare/],
  },
  {
    role: 'ticket_control',
    elementTypes: ['link', 'button', 'other'],
    textPatterns: [/^(buy ticket|purchase ticket|book|reserve|select ticket|get tickets|choose seat)$/],
    labelPatterns: [/(buy|purchase|book|reserve).{0,12}ticket/i],
  },
  {
    role: 'add_to_cart_control',
    elementTypes: ['button', 'input', 'link'],
    // Anchored where the phrase is the whole label, and open-ended where a
    // button adds context ("Reserve seat", "Add to cart - Blue Widget").
    textPatterns: [
      /^(add to cart|add to basket|add to bag|add item|add|reserve|reserve seat|select seat|choose seat)$/,
      /^(add to (cart|basket|bag)|reserve|book)\b/,
    ],
    labelPatterns: [/(add to cart|add to basket|add to bag|reserve|book)/],
    negativePatterns: [/remove/],
  },
  {
    role: 'quantity_control',
    elementTypes: ['input', 'select', 'button'],
    inputTypes: ['number', 'text'],
    labelPatterns: [/quantity/, /^qty$/, /how many/, /number of/],
  },
  {
    role: 'checkout_control',
    elementTypes: ['button', 'link', 'input'],
    textPatterns: [
      /^(checkout|check out|proceed to checkout|continue to checkout|view cart|go to cart|view basket|go to basket)$/,
      /^(proceed to|continue to|go to|view)\s+(checkout|cart|basket)\b/,
    ],
    labelPatterns: [/(checkout|check out|view cart|go to cart|view basket|go to basket)/],
  },
  {
    role: 'payment_control',
    elementTypes: ['button', 'link', 'input'],
    textPatterns: [/^(pay|place order|pay now|complete purchase|submit order|confirm order|complete order)$/],
    labelPatterns: [/(place order|pay now|payment|complete order|confirm order)/],
    negativePatterns: [/cancel|refund/],
  },
];

/** Roles a form-submission journey looks for. */
export const FORM_ROLES: readonly RoleSpec[] = [
  {
    role: 'text_field',
    elementTypes: ['input', 'textarea'],
    inputTypes: ['text', 'email', 'tel', 'url', 'number', 'date', 'time'],
    structuralMatch: true,
  },
  {
    role: 'message_field',
    elementTypes: ['textarea', 'input'],
    labelPatterns: [/message/, /comment/, /description/, /details/, /enquiry/, /inquiry/, /notes?/, /body/],
  },
  {
    role: 'select_field',
    elementTypes: ['select'],
    structuralMatch: true,
  },
  {
    role: 'file_field',
    elementTypes: ['input'],
    inputTypes: ['file'],
  },
  {
    role: 'submit_control',
    elementTypes: ['button', 'input'],
    // A submit button often carries context ("Submit application", "Send
    // message"), so these are prefix-anchored rather than fully anchored.
    textPatterns: [/^(submit|send|request|apply|enquire|inquire|continue|next|save|proceed)\b/],
    labelPatterns: [/^(submit|send|request|apply|enquire|inquire|continue|next|save)\b/],
    negativePatterns: [/cancel|reset|delete|clear/],
  },
];

/** Roles a search journey looks for. */
export const SEARCH_ROLES: readonly RoleSpec[] = [
  {
    role: 'search_field',
    elementTypes: ['input', 'textarea'],
    inputTypes: ['search', 'text'],
    labelPatterns: [/search/, /query/, /keyword/, /find/, /what are you looking for/i],
    negativePatterns: [/e-?mail|password|coupon/],
  },
  {
    role: 'search_control',
    elementTypes: ['button', 'input', 'other'],
    textPatterns: [/^(search|go|find|submit|search now)$/],
    labelPatterns: [/^search$/, /submit search/i],
    negativePatterns: [/cancel|clear/],
  },
];

/** Roles a contact journey looks for. */
export const CONTACT_ROLES: readonly RoleSpec[] = [
  {
    role: 'message_field',
    elementTypes: ['textarea', 'input'],
    labelPatterns: [/message/, /comment/, /enquiry/, /inquiry/, /how can we help/i, /tell us/],
  },
  {
    role: 'contact_control',
    elementTypes: ['button', 'input'],
    textPatterns: [/^(send|submit|contact|send message|reach out|get in touch)$/],
    labelPatterns: [/(send message|contact us|reach out)/],
    negativePatterns: [/cancel/],
  },
  {
    role: 'text_field',
    elementTypes: ['input'],
    inputTypes: ['text', 'email', 'tel'],
    labelPatterns: [/name/, /e-?mail/, /subject/, /phone/],
    structuralMatch: true,
  },
];

/** Roles an upload journey looks for. */
export const UPLOAD_ROLES: readonly RoleSpec[] = [
  {
    role: 'file_field',
    elementTypes: ['input'],
    inputTypes: ['file'],
  },
  {
    role: 'upload_control',
    elementTypes: ['button', 'input'],
    textPatterns: [/^(upload|submit|attach|choose file|select file|browse|send|continue|next)$/],
    labelPatterns: [/(upload|attach|choose file|select file)/],
  },
];

/** Roles a navigation journey looks for. */
export const NAVIGATION_ROLES: readonly RoleSpec[] = [
  {
    role: 'link',
    elementTypes: ['link'],
    structuralMatch: true,
  },
];

/** Roles a `purchase` journey looks for. Same surface as checkout, no ticket bias. */
export const PURCHASE_ROLES: readonly RoleSpec[] = CHECKOUT_ROLES.filter(
  (spec) => spec.role !== 'ticket_control',
);

/** Role specs for a journey type, in the order a plan should step through them. */
export function rolesForJourney(journeyType: JourneyType): readonly RoleSpec[] {
  switch (journeyType) {
    case 'login':
      return LOGIN_ROLES;
    case 'registration':
      return REGISTRATION_ROLES;
    case 'checkout':
    case 'purchase':
      return CHECKOUT_ROLES;
    case 'ticket_purchase':
      return CHECKOUT_ROLES;
    case 'form_submission':
      return FORM_ROLES;
    case 'search':
      return SEARCH_ROLES;
    case 'contact':
      return CONTACT_ROLES;
    case 'upload':
      return UPLOAD_ROLES;
    case 'navigation':
      return NAVIGATION_ROLES;
    case 'unknown':
    default:
      return FORM_ROLES;
  }
}

/** True when the journey type needs credentials to ever be executed. */
export function requiresCredentials(journeyType: JourneyType): boolean {
  return journeyType === 'login' || journeyType === 'registration';
}

/** True when the journey type would need payment details to ever be executed. */
export function requiresPayment(journeyType: JourneyType): boolean {
  return journeyType === 'checkout' || journeyType === 'purchase' || journeyType === 'ticket_purchase';
}

/** Forms that contain at least one matched element, for form-scoped reporting. */
export function formsReferencing(forms: readonly ScoutForm[], elementIds: ReadonlySet<string>): ScoutForm[] {
  return forms.filter((form) => form.fields.some((field) => elementIds.has(field.selector)));
}
