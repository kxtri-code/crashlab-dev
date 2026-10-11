/**
 * Candidate defect identity and canonical hashing.
 *
 * Review state depends on durable, stable candidate identity. A candidate's
 * identity must not depend on:
 *  - array position
 *  - report ordering
 *  - filesystem ordering
 *  - timestamp or duration
 *  - random IDs
 *  - temporary paths
 *  - attempt number
 *  - output filename
 *
 * Candidate identity is derived deterministically from:
 *  - target origin (sanitized)
 *  - journey hash (canonical plan hash)
 *  - application build identity (when present)
 *  - anomaly rule ID
 *  - normalized signal key (or fallback anomaly ID when untracked)
 *  - step ID (when step-scoped)
 *
 * Pure. No I/O, no network, no browser.
 */

import { createHash } from 'node:crypto';
import { safeTargetOrigin, sanitizeAppBuildId } from '../provenance/redaction.js';

/** Inputs required to compute a canonical candidate identity. */
export interface CandidateIdentityInput {
  targetOrigin: string | null;
  journeyHash: string | null;
  applicationBuildId?: string | null;
  ruleId: string;
  signalKey: string;
  stepId?: string | null;
}

/**
 * Serialize canonical candidate identity content into a deterministic JSON string.
 *
 * Field order is fixed and sensitive query params / paths are excluded.
 */
export function canonicalCandidatePayload(input: CandidateIdentityInput): string {
  const origin = input.targetOrigin ? safeTargetOrigin(input.targetOrigin).origin : null;
  const buildId = input.applicationBuildId ? sanitizeAppBuildId(input.applicationBuildId) : null;
  const jHash = typeof input.journeyHash === 'string' ? input.journeyHash.trim() : '';
  const sId = typeof input.stepId === 'string' ? input.stepId.trim() : '';

  return JSON.stringify({
    targetOrigin: origin ?? '',
    journeyHash: jHash,
    applicationBuildId: buildId ?? '',
    ruleId: input.ruleId.trim(),
    signalKey: input.signalKey.trim(),
    stepId: sId,
  });
}

/**
 * Generate a deterministic candidate ID: `cand-<16 hex chars>`.
 *
 * 16 hex chars (64 bits) derived from the SHA-256 hash of the canonical payload
 * provides virtually zero collision risk while remaining safe for filesystems
 * and terminal displays.
 */
export function canonicalCandidateId(input: CandidateIdentityInput): string {
  const payload = canonicalCandidatePayload(input);
  const hash = createHash('sha256').update(payload, 'utf8').digest('hex');
  return `cand-${hash.slice(0, 16)}`;
}

/**
 * Validate that a candidate ID has a safe and expected identifier format.
 */
export function validateCandidateId(id: unknown): { valid: boolean; error?: string } {
  if (typeof id !== 'string') {
    return { valid: false, error: 'Candidate ID must be a string.' };
  }
  const trimmed = id.trim();
  if (trimmed === '') {
    return { valid: false, error: 'Candidate ID must not be empty.' };
  }
  if (trimmed.length > 64) {
    return { valid: false, error: `Candidate ID exceeds 64 characters (${trimmed.length}).` };
  }
  // Rejects control characters, path separators, traversal
  if (/[\x00-\x1f\x7f\\/]/.test(trimmed) || trimmed.includes('..')) {
    return { valid: false, error: 'Candidate ID contains invalid characters or path separators.' };
  }
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    return { valid: false, error: 'Candidate ID contains unsupported characters. Use letters, digits, dot, underscore, or hyphen.' };
  }
  return { valid: true };
}
