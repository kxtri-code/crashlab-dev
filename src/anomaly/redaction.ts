/**
 * Redaction for anomaly output.
 *
 * Build 3 already redacts before writing `execution.json`, but Build 4 cannot
 * assume that: it may be pointed at a report produced elsewhere, or an older
 * one. So the analyzer re-redacts on the way out.
 *
 * The rule is conservative: when a value cannot be represented safely, it is
 * replaced rather than included. Nothing here reads images, and there is no
 * OCR or model-based redaction.
 */

import { redactUrl, REDACTED } from '../util/url.js';

/** Longest console or error text kept. */
const MAX_TEXT = 300;

/** Longest stack fragment kept. */
const MAX_STACK = 300;

/** Longest path kept. */
const MAX_PATH = 200;

/** Collapse whitespace and cap, collapsing to a placeholder when empty. */
function normalizeText(value: unknown, max = MAX_TEXT): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/\s+/g, ' ').trim();
  if (cleaned.length === 0) return null;
  return cleaned.length > max ? `${cleaned.slice(0, max)}...` : cleaned;
}

/**
 * Patterns for values that must never reach the output, even if a target page
 * echoed them into a console message or an error string.
 *
 * These match the *shape* of a secret rather than a known value, because the
 * analyzer is deliberately given no test data and therefore has no secret list
 * to compare against.
 *
 * Stored as sources rather than live regexes on purpose. A module-level `/g`
 * regex carries `lastIndex` between calls, so reusing one across repeated
 * `replace` calls silently skips matches - which would make redaction
 * unreliable in exactly the situation it matters. Each use builds a fresh
 * regex instead.
 */
const SECRET_SHAPES: readonly string[] = [
  String.raw`\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}`, // Authorization header values
  String.raw`\beyJ[A-Za-z0-9._-]{10,}`, // JWT
  String.raw`\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{16,}`, // Provider tokens
  String.raw`\bsk_(?:live|test)_[A-Za-z0-9]{12,}`, // Stripe-style keys
  String.raw`\bAKIA[0-9A-Z]{12,}\b`, // AWS access key ids
  String.raw`\b(?:\d[ -]?){13,19}\b`, // Card-number shaped digit runs
  String.raw`\b(?:password|passwd|pwd|token|secret|api[_-]?key|apikey|authorization|auth|cookie|set-cookie|cvv|cvc|ssn)\s*[:=]\s*\S+`, // key=value pairs
];

/** Replace anything secret-shaped in a string. Deterministic and repeatable. */
export function scrubText(value: string): string {
  let output = value;
  for (const source of SECRET_SHAPES) {
    // A fresh regex per pattern per call, so no match is ever skipped.
    output = output.replace(new RegExp(source, 'gi'), REDACTED);
  }
  return output;
}

/**
 * Redact a console or error message.
 *
 * @returns the scrubbed text, or a placeholder when nothing safe remains. A
 * message that is *entirely* secret yields a bare `REDACTED`, which is not
 * informative, so it is reported as omitted instead - the caller still records
 * the event type and index, which is what a reader actually needs.
 */
export function redactMessage(value: unknown, fallback = 'Message omitted: could not be represented safely'): string {
  const normalized = normalizeText(value);
  if (normalized === null) return fallback;
  const scrubbed = scrubText(normalized);
  if (scrubbed.trim() === '' || scrubbed.trim() === REDACTED) return fallback;
  return scrubbed;
}

/** Redact a stack fragment, keeping only the first line. */
export function redactStack(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const firstLine = value.split('\n')[0] ?? '';
  return redactMessage(firstLine);
}

/** Sanitize a URL for output. Reuses the executor's query-value redaction. */
export function sanitizeUrl(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') return '(unknown url)';
  const redacted = scrubText(redactUrl(value) ?? '');
  return redacted.length > 500 ? `${redacted.slice(0, 500)}...` : redacted;
}

/** Sanitize a path, keeping it short and free of query values. */
export function sanitizePath(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const scrubbed = scrubText(redactUrl(value) ?? '');
  return scrubbed.length > MAX_PATH ? `${scrubbed.slice(0, MAX_PATH)}...` : scrubbed;
}

/** Sanitize a failure string, which can contain an internal reason. */
export function sanitizeFailure(value: unknown): string | null {
  const normalized = normalizeText(value, 200);
  // Scrubbed, because a transport error can echo a request URL with a token.
  return normalized === null ? null : scrubText(normalized);
}

export { REDACTED };
