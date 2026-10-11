/**
 * Review state input validation and sanitization.
 *
 * Enforces safety on operator-supplied review content:
 *  - Reviewer identities must be safe identifiers, rejecting control characters,
 *    path separators, tokens, and passwords.
 *  - Notes must be bounded in length and free from control characters, secrets,
 *    or tokens.
 *  - Duplicate linking is strictly checked for self-reference and valid ID shapes.
 *
 * Pure. No I/O, no network.
 */

import { sanitizeIdentifier } from '../provenance/redaction.js';
import { validateCandidateId } from './identity.js';
import { MAX_REVIEW_NOTE_LENGTH, ReviewStateInputError } from './reviewStateTypes.js';

/** Regex detecting potential secrets or tokens in review notes. */
const NOTE_SECRET_PATTERNS: readonly { pattern: RegExp; description: string }[] = [
  { pattern: /bearer\s+[a-z0-9._-]{10,}/i, description: 'a bearer token' },
  { pattern: /basic\s+[a-z0-9+/=]{10,}/i, description: 'basic auth credentials' },
  { pattern: /\beyJ[A-Za-z0-9._-]{10,}/, description: 'a JWT token' },
  { pattern: /\b(?:\d[ -]?){13,19}\b/, description: 'a payment card number' },
  { pattern: /(?:password|passwd|api_key|secret)\s*[:=]\s*[^\s]{4,}/i, description: 'a credential assignment' },
];

/** Maximum character length for reviewer identifier. */
export const MAX_REVIEWER_LENGTH = 64;

/** Validate and sanitize an operator reviewer identity. */
export function validateReviewerIdentity(reviewer: string | null | undefined): string | null {
  if (reviewer === null || reviewer === undefined) return null;
  const trimmed = reviewer.trim();
  if (trimmed === '') return null;

  if (trimmed.length > MAX_REVIEWER_LENGTH) {
    throw new ReviewStateInputError(
      `Reviewer identity is ${trimmed.length} characters, which exceeds the ${MAX_REVIEWER_LENGTH} character limit.`,
    );
  }

  try {
    return sanitizeIdentifier(trimmed, 'Reviewer identity');
  } catch (error) {
    throw new ReviewStateInputError((error as Error).message);
  }
}

/** Validate and sanitize a human review note. */
export function validateReviewNote(note: string | null | undefined): string | null {
  if (note === null || note === undefined) return null;
  const trimmed = note.trim();
  if (trimmed === '') return null;

  if (trimmed.length > MAX_REVIEW_NOTE_LENGTH) {
    throw new ReviewStateInputError(
      `Review note is ${trimmed.length} characters, which exceeds the ${MAX_REVIEW_NOTE_LENGTH} character limit.`,
    );
  }

  // Reject control characters (allow tab, newline, CR: \t \n \r)
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(trimmed)) {
    throw new ReviewStateInputError('Review note contains unsupported control characters.');
  }

  // Reject obvious secrets
  for (const { pattern, description } of NOTE_SECRET_PATTERNS) {
    if (pattern.test(trimmed)) {
      throw new ReviewStateInputError(
        `Review note contains ${description}. Secrets must never be stored in persistent review notes.`,
      );
    }
  }

  return trimmed;
}

/** Validate duplicate target candidate ID. */
export function validateDuplicateTarget(
  candidateId: string,
  duplicateOf: string | null | undefined,
  status: string,
): string | null {
  if (status === 'duplicate') {
    if (!duplicateOf || duplicateOf.trim() === '') {
      throw new ReviewStateInputError('A duplicate candidate status requires an explicit --duplicate-of target candidate ID.');
    }
    const target = duplicateOf.trim();
    if (target === candidateId) {
      throw new ReviewStateInputError(`Candidate "${candidateId}" cannot be marked as a duplicate of itself.`);
    }
    const check = validateCandidateId(target);
    if (!check.valid) {
      throw new ReviewStateInputError(`Duplicate target candidate ID "${target}" is invalid: ${check.error ?? ''}`);
    }
    return target;
  }

  if (duplicateOf && duplicateOf.trim() !== '') {
    throw new ReviewStateInputError(
      `--duplicate-of was provided for status "${status}". Duplicate target can only be specified when status is "duplicate".`,
    );
  }

  return null;
}
