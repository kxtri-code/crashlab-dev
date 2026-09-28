/**
 * Pure page-type inference.
 *
 * No browser APIs, so this is unit-testable. Rules produce weighted signals;
 * the winner has to clear `CONFIDENCE_THRESHOLD` or the answer is `unknown`.
 * Being wrong here is worse than saying nothing, so the bar is deliberate.
 */

import type { DetectedPageType, PageTypeSignal } from './types.js';
import type { RawPageSignals } from './domRaw.js';

/** Minimum score for the winning page type to replace `unknown`. */
export const CONFIDENCE_THRESHOLD = 0.6;

/**
 * Evidence weight at which a candidate is considered *fully* corroborated.
 *
 * Confidence combines two things that must not be confused:
 *   - `share` - how much of the page's evidence the winner captured, and
 *   - `strength` - how much evidence there was to begin with.
 *
 * A single weak signal (one small form, say) scores a 100% share but is still
 * weak evidence, so it must not read as certain. Confidence is therefore
 * `share * min(1, strength / STRENGTH_SATURATION)`.
 */
export const STRENGTH_SATURATION = 0.6;

/** A scored rule contribution. */
interface Rule {
  value: DetectedPageType;
  /** Points added when the rule matches. */
  weight: number;
  /** Whether the evidence is additive or disqualifies the candidate outright. */
  mode: 'add' | 'veto';
  reason: string;
}

function score(rules: Rule[]): PageTypeSignal[] {
  const byType = new Map<DetectedPageType, { strength: number; reasons: string[]; vetoed: string[] }>();

  const entryFor = (value: DetectedPageType) => {
    const existing = byType.get(value);
    if (existing) return existing;
    const created = { strength: 0, reasons: [] as string[], vetoed: [] as string[] };
    byType.set(value, created);
    return created;
  };

  for (const rule of rules) {
    if (rule.mode === 'veto') {
      entryFor(rule.value).vetoed.push(rule.reason);
      continue;
    }
    const entry = entryFor(rule.value);
    entry.strength += rule.weight;
    entry.reasons.push(rule.reason);
  }

  // Only surviving candidates contribute to the total, which keeps both the
  // total and every resulting share inside [0, 1].
  const survivors = [...byType.entries()].filter(
    ([, entry]) => entry.vetoed.length === 0 && entry.strength > 0,
  );
  const total = survivors.reduce((sum, [, entry]) => sum + entry.strength, 0);

  const candidates: PageTypeSignal[] = survivors.map(([value, entry]) => {
    const share = total > 0 ? entry.strength / total : 0;
    const strengthFactor = Math.min(1, entry.strength / STRENGTH_SATURATION);
    return {
      value,
      confidence: round2(share * strengthFactor),
      reason: entry.reasons.join('; '),
    };
  });

  // Vetoed candidates are still reported, so a later planner can see what was
  // ruled out and why rather than finding an unexplained gap.
  for (const [value, entry] of byType) {
    if (entry.vetoed.length === 0 || entry.strength <= 0) continue;
    candidates.push({
      value,
      confidence: 0,
      reason: `disproven: ${entry.vetoed.join('; ')}`,
    });
  }

  candidates.sort((a, b) => b.confidence - a.confidence || a.value.localeCompare(b.value));
  return candidates;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function countMatching(texts: string[], pattern: RegExp): number {
  return texts.filter((text) => pattern.test(text)).length;
}

/**
 * Build the weighted rule set for a page's evidence.
 *
 * Order matters only for readability; `score` is order-independent.
 */
export function buildPageTypeRules(signals: RawPageSignals): Rule[] {
  const rules: Rule[] = [];
  const path = signals.path.toLowerCase();
  const title = signals.title.toLowerCase();
  const text = signals.text.toLowerCase();

  // --- login / signup ----------------------------------------------------
  if (signals.hasPasswordField) {
    rules.push({ value: 'login', weight: 0.6, mode: 'add', reason: 'password field present' });
  }
  const authPath = /\/(sign[-_/]?in|log[-_/]?in|login|auth|sso|session)\b/.test(path);
  const authTitle = /\b(sign in|log in|login|logon|authenticate)\b/.test(title);
  if (authPath) rules.push({ value: 'login', weight: 0.5, mode: 'add', reason: `path matches ${path.split('?')[0]}` });
  if (authTitle) rules.push({ value: 'login', weight: 0.4, mode: 'add', reason: 'title mentions sign in / log in' });
  if (countMatching(signals.buttonTexts, /^(sign in|log ?in|login|continue|submit)$/i) >= 1 && signals.hasPasswordField) {
    rules.push({ value: 'login', weight: 0.2, mode: 'add', reason: 'sign-in submit button' });
  }

  const signupPath = /\/(sign[-_/]?up|register|registration|create[-_/]account|join)\b/.test(path);
  const signupTitle = /\b(sign ?up|register|create (an |your )?account|join)\b/.test(title);
  const signupText = /\b(create (an |your )?account|sign ?up|get started|already have an account)\b/.test(text);
  if (signupPath) rules.push({ value: 'signup', weight: 0.6, mode: 'add', reason: `path matches ${path.split('?')[0]}` });
  if (signupTitle) rules.push({ value: 'signup', weight: 0.5, mode: 'add', reason: 'title mentions sign up / register' });
  if (signupText) rules.push({ value: 'signup', weight: 0.2, mode: 'add', reason: 'body copy mentions account creation' });
  // A password field is expected on a sign-up page, so it is not evidence of a
  // login page once the page has been identified as account creation.
  if (signupPath || signupTitle) {
    rules.push({ value: 'login', weight: 0, mode: 'veto', reason: 'page is account creation, not sign in' });
  }

  // --- checkout ----------------------------------------------------------
  const checkoutPath =
    /\/(checkout|check[-_/]?out|cart|basket|bag|order|payment|pay|place[-_/]?order|confirm[-_/]?order)\b/.test(path);
  const checkoutTitle = /\b(checkout|shopping cart|your order|payment|order summary|basket)\b/.test(title);
  const checkoutText =
    /\b(order summary|shipping address|payment method|place order|proceed to checkout|subtotal|total due|credit card|checkout)\b/.test(text);
  const checkoutButtons = countMatching(signals.buttonTexts, /^(checkout|place order|pay now|buy now|pay|proceed to checkout|complete purchase|order now)$/i);
  if (checkoutPath) rules.push({ value: 'checkout', weight: 0.5, mode: 'add', reason: `path matches ${path.split('?')[0]}` });
  if (checkoutTitle) rules.push({ value: 'checkout', weight: 0.45, mode: 'add', reason: 'title mentions checkout / order' });
  if (checkoutText) rules.push({ value: 'checkout', weight: 0.3, mode: 'add', reason: 'body copy mentions order or payment' });
  if (checkoutButtons >= 1) rules.push({ value: 'checkout', weight: 0.3, mode: 'add', reason: 'checkout submit button' });
  if (signals.formActionPaths.some((action) => /payment|checkout|order|charge/i.test(action))) {
    rules.push({ value: 'checkout', weight: 0.3, mode: 'add', reason: 'form action targets payment or order' });
  }

  // --- search ------------------------------------------------------------
  if (signals.hasSearchInput) {
    rules.push({ value: 'search', weight: 0.5, mode: 'add', reason: 'search or query input present' });
  }
  if (/\bsearch\b/.test(path) || /\b(search|results)\b/.test(title)) {
    rules.push({ value: 'search', weight: 0.4, mode: 'add', reason: 'path or title indicates search' });
  }

  // --- dashboard ---------------------------------------------------------
  const dashboardPath = /\/(dashboard|admin|home|overview|console|manage|analytics)\b/.test(path);
  const dashboardText = /\b(dashboard|overview|recent activity|statistics|metrics|kpi)\b/.test(text);
  if (dashboardPath) rules.push({ value: 'dashboard', weight: 0.5, mode: 'add', reason: `path matches ${path.split('?')[0]}` });
  if (dashboardText) rules.push({ value: 'dashboard', weight: 0.3, mode: 'add', reason: 'body copy mentions dashboard or overview' });
  if (signals.tableCount >= 2) {
    rules.push({ value: 'dashboard', weight: 0.25, mode: 'add', reason: `${signals.tableCount} tables present` });
  }
  if (dashboardPath) {
    rules.push({ value: 'list', weight: 0, mode: 'veto', reason: 'admin area rather than a content list' });
  }

  // --- list --------------------------------------------------------------
  if (signals.tableCount >= 1) {
    rules.push({ value: 'list', weight: 0.3, mode: 'add', reason: `${signals.tableCount} table(s) present` });
  }
  if (signals.repeatedBlockCount >= 8) {
    rules.push({ value: 'list', weight: 0.3, mode: 'add', reason: `${signals.repeatedBlockCount} repeated sibling blocks` });
  }
  if (/\/(index|list|browse|catalog|products?|items?|results)\b/.test(path)) {
    rules.push({ value: 'list', weight: 0.3, mode: 'add', reason: `path matches ${path.split('?')[0]}` });
  }
  if (signals.hasFileInput) {
    rules.push({ value: 'list', weight: 0, mode: 'veto', reason: 'file upload, not a result list' });
  }

  // --- settings ----------------------------------------------------------
  const settingsPath = /\/(settings|preferences|profile|account|configuration|config)\b/.test(path);
  const settingsText = /\b(settings|preferences|notification settings|account settings|profile)\b/.test(text);
  if (settingsPath) rules.push({ value: 'settings', weight: 0.5, mode: 'add', reason: `path matches ${path.split('?')[0]}` });
  if (settingsText) rules.push({ value: 'settings', weight: 0.3, mode: 'add', reason: 'body copy mentions settings or preferences' });

  // --- form (the fallback for any real form) -----------------------------
  if (signals.formCount >= 1 && signals.visibleFieldCount >= 2) {
    rules.push({
      value: 'form',
      weight: signals.formCount >= 2 || signals.visibleFieldCount >= 4 ? 0.45 : 0.3,
      mode: 'add',
      reason: `${signals.formCount} form(s) with ${signals.visibleFieldCount} visible field(s)`,
    });
  }

  // A page with no forms cannot be a form page.
  if (signals.formCount === 0) {
    rules.push({ value: 'form', weight: 0, mode: 'veto', reason: 'no forms on the page' });
  }

  return rules;
}

/**
 * Infer the page type from raw page evidence.
 *
 * @returns the winning type, its confidence (0 when `unknown`), why, and every
 * candidate considered - so a report consumer can see what was near-missed.
 */
export function detectPageType(signals: RawPageSignals): {
  detectedPageType: DetectedPageType;
  pageTypeConfidence: number;
  pageTypeReason: string;
  pageTypeCandidates: PageTypeSignal[];
} {
  const candidates = score(buildPageTypeRules(signals));

  if (candidates.length === 0) {
    return {
      detectedPageType: 'unknown',
      pageTypeConfidence: 0,
      pageTypeReason: 'no distinguishing page signals',
      pageTypeCandidates: [],
    };
  }

  const winner = candidates[0];
  if (!winner) {
    return {
      detectedPageType: 'unknown',
      pageTypeConfidence: 0,
      pageTypeReason: 'no distinguishing page signals',
      pageTypeCandidates: [],
    };
  }

  if (winner.confidence < CONFIDENCE_THRESHOLD) {
    return {
      detectedPageType: 'unknown',
      pageTypeConfidence: winner.confidence,
      pageTypeReason: `ambiguous: ${winner.reason} (below ${CONFIDENCE_THRESHOLD} confidence)`,
      pageTypeCandidates: candidates,
    };
  }

  return {
    detectedPageType: winner.value,
    pageTypeConfidence: winner.confidence,
    pageTypeReason: winner.reason,
    pageTypeCandidates: candidates,
  };
}
