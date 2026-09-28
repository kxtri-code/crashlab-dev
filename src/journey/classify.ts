/**
 * Deterministic goal classification.
 *
 * Pure, local, and explainable: a goal maps to a journey type by matching
 * keyword groups, and every match is reported so the plan can state *why* and
 * flag ambiguity. No model, no network, no randomness.
 *
 * Priority is explicit rather than emergent. A goal that matches several
 * categories resolves to the highest-priority one, and the losers become
 * warnings - the planner never pretends an ambiguous goal was clean.
 */

import type { JourneyType } from './types.js';
import { tokenize } from './goal.js';

/** A keyword group: which terms indicate the category, and how specific they are. */
interface KeywordGroup {
  type: JourneyType;
  /** Multi-word phrases, checked as substrings of the normalised goal. */
  phrases: readonly string[];
  /** Single words, checked against goal tokens. */
  words: readonly string[];
  /**
   * Higher wins when several categories match. Ordered most-specific first:
   * "sign in" must beat a bare "in", "upload a file" must beat "file".
   */
  priority: number;
}

/**
 * Keyword groups in priority order.
 *
 * Priorities are spaced so an ordering change is a deliberate edit, not an
 * accident. More specific intents (auth, purchase, upload) outrank generic ones
 * (navigation, form submission).
 */
const KEYWORD_GROUPS: readonly KeywordGroup[] = [
  {
    type: 'login',
    // "signin" is the collapsed form; the spaced variants are phrases.
    phrases: ['log in', 'sign in', 'signin', 'log on', 'sign on', 'log into', 'sign into', 'authenticate', 'authentication'],
    words: ['login', 'auth', 'credential', 'credentials'],
    priority: 100,
  },
  {
    type: 'registration',
    phrases: ['sign up', 'signup', 'signing up', 'create account', 'create an account', 'create my account', 'new account', 'register account'],
    words: ['register', 'registration', 'signup', 'join', 'onboard', 'onboarding'],
    priority: 95,
  },
  {
    type: 'ticket_purchase',
    phrases: ['buy a ticket', 'buy ticket', 'purchase a ticket', 'purchase ticket', 'book a ticket', 'reserve a ticket', 'get tickets', 'event ticket'],
    words: ['ticket', 'tickets', 'ticketsale', 'seating'],
    priority: 90,
  },
  {
    type: 'upload',
    phrases: ['add file', 'add a file', 'attach file', 'submit document', 'upload file', 'upload a file', 'upload document'],
    words: ['upload', 'attach', 'attachment', 'document', 'documents', 'file'],
    priority: 85,
  },
  {
    type: 'checkout',
    phrases: ['complete checkout', 'finish checkout', 'proceed to checkout', 'go to checkout', 'check out', 'checkout flow', 'payment method', 'place order', 'complete the order', 'order summary'],
    words: ['checkout', 'cart', 'basket', 'payment', 'pay', 'purchase', 'order', 'buy'],
    priority: 80,
  },
  {
    type: 'contact',
    phrases: ['get in touch', 'reach out', 'contact form', 'contact us', 'send a message', 'leave a message'],
    words: ['contact', 'message', 'enquiry', 'inquiry', 'support'],
    priority: 70,
  },
  {
    type: 'search',
    phrases: ['look for', 'search for', 'search the', 'find a', 'find the', 'locate a', 'locate the'],
    words: ['search', 'find', 'locate', 'query', 'filter'],
    priority: 60,
  },
  {
    type: 'form_submission',
    phrases: ['submit form', 'send form', 'fill out', 'fill in', 'fill out the', 'request access', 'apply for', 'make a request'],
    words: ['submit', 'form', 'apply', 'request', 'enquiry', 'inquiry'],
    priority: 50,
  },
  {
    type: 'navigation',
    // Lowest priority: reaching a page is a weaker signal than acting on it.
    phrases: ['navigate to', 'go to', 'visit', 'browse', 'open the page', 'open page'],
    words: ['navigate', 'navigateTo', 'browse', 'visit', 'goto'],
    priority: 20,
  },
];

/** Outcome of classifying a goal. */
export interface ClassificationResult {
  journeyType: JourneyType;
  /** Every category that matched, in priority order. Length > 1 means ambiguous. */
  matches: JourneyType[];
  /** Terms that caused the winning match, for the plan's assumptions. */
  matchedTerms: string[];
  /** True when more than one category matched. */
  ambiguous: boolean;
  /** True when nothing matched at all. */
  unmatched: boolean;
}

/**
 * Classify a normalised goal into a journey type.
 *
 * @param normalizedGoal output of `normalizeGoal`.
 */
export function classifyGoal(normalizedGoal: string): ClassificationResult {
  if (!normalizedGoal) {
    return { journeyType: 'unknown', matches: [], matchedTerms: [], ambiguous: false, unmatched: true };
  }

  const tokens = new Set(tokenize(normalizedGoal));
  const matches: { type: JourneyType; terms: string[] }[] = [];

  for (const group of KEYWORD_GROUPS) {
    const terms: string[] = [];
    for (const phrase of group.phrases) {
      if (normalizedGoal.includes(phrase)) terms.push(phrase);
    }
    for (const word of group.words) {
      if (tokens.has(word.toLowerCase())) terms.push(word.toLowerCase());
    }
    if (terms.length > 0) {
      // Sort so the reported terms are stable regardless of iteration order.
      matches.push({ type: group.type, terms: [...new Set(terms)].sort() });
    }
  }

  if (matches.length === 0) {
    return { journeyType: 'unknown', matches: [], matchedTerms: [], ambiguous: false, unmatched: true };
  }

  // Priority decides, not array order, so reordering the table cannot silently
  // change behaviour. Ties break on type name for determinism.
  const priorityOf = new Map(KEYWORD_GROUPS.map((group) => [group.type, group.priority]));
  matches.sort((a, b) => (priorityOf.get(b.type) ?? 0) - (priorityOf.get(a.type) ?? 0) || a.type.localeCompare(b.type));

  const winner = matches[0];
  if (!winner) {
    return { journeyType: 'unknown', matches: [], matchedTerms: [], ambiguous: false, unmatched: true };
  }

  return {
    journeyType: winner.type,
    matches: matches.map((match) => match.type),
    matchedTerms: winner.terms,
    ambiguous: matches.length > 1,
    unmatched: false,
  };
}
