/**
 * Provenance redaction and identifier validation.
 *
 * Provenance is written into every report, so anything it accepts becomes
 * durable output. Two rules follow:
 *
 *  - A caller-supplied identifier is **rejected**, not silently trimmed, when it
 *    looks like a secret or a path. A quiet trim would let a credential be
 *    half-written into a report; a refusal tells the operator immediately.
 *
 *  - Machine-identifying values (username, home directory, absolute paths) are
 *    never collected in the first place. Provenance records which system a run
 *    happened on, not which person ran it.
 *
 * Pure, so the rules are directly assertable.
 */

import { MAX_IDENTIFIER_LENGTH, UnsafeIdentifierError } from './types.js';

/**
 * Shapes that must never appear in a provenance identifier.
 *
 * A credential, a URL, or a filesystem path are all rejected outright rather
 * than stripped: the operator supplied the wrong kind of value, and coercing it
 * would produce an identifier that looks safe and is not.
 */
const UNSAFE_IDENTIFIER_PATTERNS: readonly { pattern: RegExp; reason: string }[] = [
  // Ordered most-specific first, so a rejected value gets the reason that
  // actually explains it. A URL also contains separators, and reporting
  // "filesystem separators" for one would send the operator the wrong way.
  { pattern: /^[a-z][a-z0-9+.-]*:\/\//i, reason: 'a URL' },
  { pattern: /^(?:bearer|basic)\s/i, reason: 'an authorization value' },
  { pattern: /\beyJ[A-Za-z0-9._-]{10,}/, reason: 'a token' },
  { pattern: /\b(?:\d[ -]?){13,19}\b/, reason: 'a card number' },
  { pattern: /[\\/]/, reason: 'filesystem separators' },
  { pattern: /\s/, reason: 'whitespace' },
  { pattern: /[=~]/, reason: 'credential-like assignment' },
  // Control characters, written as escapes. A literal control byte in source
  // would make this file binary and the range unreadable.
  { pattern: /[\x00-\x1f\x7f]/, reason: 'control characters' },
];

/**
 * Validate and normalize a caller-supplied identifier.
 *
 * @returns the cleaned identifier, or `null` when nothing was supplied.
 * @throws {UnsafeIdentifierError} when the value cannot be used safely.
 */
export function sanitizeIdentifier(value: string | null | undefined, label: string): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  if (trimmed === '') return null;

  if (trimmed.length > MAX_IDENTIFIER_LENGTH) {
    throw new UnsafeIdentifierError(
      `${label} is ${trimmed.length} characters, which exceeds the ${MAX_IDENTIFIER_LENGTH} character limit.`,
    );
  }

  for (const { pattern, reason } of UNSAFE_IDENTIFIER_PATTERNS) {
    if (pattern.test(trimmed)) {
      throw new UnsafeIdentifierError(
        `${label} contains ${reason}, which is not permitted in provenance metadata. ` +
          'Use a short opaque identifier such as "local-shop" or "build-001".',
      );
    }
  }

  // Only characters that cannot form a path, URL, or shell fragment survive.
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    throw new UnsafeIdentifierError(
      `${label} contains unsupported characters. Use letters, digits, dot, underscore or hyphen only.`,
    );
  }

  return trimmed;
}

/** Sanitize the environment ID. */
export function sanitizeEnvironmentId(value: string | null | undefined): string | null {
  return sanitizeIdentifier(value, 'environment ID');
}

/** Sanitize the application build ID. */
export function sanitizeAppBuildId(value: string | null | undefined): string | null {
  return sanitizeIdentifier(value, 'application build ID');
}

/** Sanitize the test-data fixture ID. */
export function sanitizeDataId(value: string | null | undefined): string | null {
  return sanitizeIdentifier(value, 'test data ID');
}

/**
 * Reduce a target URL to its origin.
 *
 * A path can carry a tenant, a user, or a token, and a query almost always
 * carries something sensitive, so neither is recorded. The origin is what
 * actually distinguishes one environment from another.
 */
export function safeTargetOrigin(url: string | null | undefined): { origin: string | null; unresolved: boolean } {
  if (typeof url !== 'string' || url.trim() === '') {
    return { origin: null, unresolved: true };
  }

  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol === 'file:') {
      // A file URL's host is empty and its path is an absolute local path,
      // which must never reach a report.
      return { origin: 'file://', unresolved: false };
    }
    // `origin` already drops path, query and fragment.
    return parsed.origin === 'null' ? { origin: null, unresolved: true } : { origin: parsed.origin, unresolved: false };
  } catch {
    return { origin: null, unresolved: true };
  }
}

/**
 * Coerce a version to a bounded, non-empty string for fingerprinting.
 *
 * @param fallback used when the value is absent or not a string.
 */
export function safeVersion(value: unknown, fallback: string = 'unknown'): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (trimmed === '') return fallback;
  return trimmed.length > 64 ? trimmed.slice(0, 64) : trimmed;
}
