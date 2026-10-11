/**
 * Review state transition rules and cycle protection.
 *
 * Enforces valid state transitions:
 *  - Open, investigating, and accepted may transition among active statuses or terminal statuses.
 *  - Dismissed, duplicate, and resolved candidates must be explicitly reopened to "open"
 *    before any other transition is allowed.
 *  - Duplicate chains cannot point to themselves, form cycles, or point to other duplicates.
 *
 * Pure. No I/O.
 */

import type { CandidateReviewState, ReviewStateStatus } from './reviewStateTypes.js';
import { ReviewStateTransitionError } from './reviewStateTypes.js';

/** Valid status transitions when moving from an existing status. */
export const VALID_STATUS_TRANSITIONS: Record<ReviewStateStatus, ReadonlySet<ReviewStateStatus>> = {
  open: new Set(['open', 'investigating', 'accepted', 'dismissed', 'duplicate', 'resolved']),
  investigating: new Set(['open', 'investigating', 'accepted', 'dismissed', 'duplicate', 'resolved']),
  accepted: new Set(['open', 'investigating', 'accepted', 'dismissed', 'duplicate', 'resolved']),
  dismissed: new Set(['open']),
  duplicate: new Set(['open']),
  resolved: new Set(['open']),
};

/** All valid review state statuses. */
export const ALL_REVIEW_STATUSES: readonly ReviewStateStatus[] = [
  'open',
  'investigating',
  'accepted',
  'dismissed',
  'duplicate',
  'resolved',
];

/** Check if a string is a valid review state status. */
export function isReviewStateStatus(status: unknown): status is ReviewStateStatus {
  return typeof status === 'string' && ALL_REVIEW_STATUSES.includes(status as ReviewStateStatus);
}

/**
 * Validate a candidate review state transition.
 *
 * @param currentStatus The existing status of the candidate, or null if entering review state.
 * @param nextStatus The desired next status.
 * @param candidateId The candidate ID being updated.
 * @param duplicateOf Target duplicate candidate ID if status is 'duplicate'.
 * @param existingStates All known candidate states, for chain/cycle detection.
 */
export function validateStateTransition(
  currentStatus: ReviewStateStatus | null,
  nextStatus: ReviewStateStatus,
  candidateId: string,
  duplicateOf: string | null = null,
  existingStates?: Readonly<Record<string, CandidateReviewState>>,
): void {
  if (!isReviewStateStatus(nextStatus)) {
    throw new ReviewStateTransitionError(
      `Unknown review status "${String(nextStatus)}". Valid statuses: ${ALL_REVIEW_STATUSES.join(', ')}.`,
      currentStatus,
      nextStatus,
    );
  }

  // If entering review state for the first time
  if (currentStatus === null) {
    // Any status is valid as the initial recorded state
    if (nextStatus === 'duplicate') {
      validateDuplicateChain(candidateId, duplicateOf, existingStates);
    }
    return;
  }

  const allowed = VALID_STATUS_TRANSITIONS[currentStatus];
  if (!allowed.has(nextStatus)) {
    if (currentStatus === 'dismissed' || currentStatus === 'duplicate' || currentStatus === 'resolved') {
      throw new ReviewStateTransitionError(
        `Cannot transition candidate "${candidateId}" from "${currentStatus}" directly to "${nextStatus}". ` +
          `A ${currentStatus} candidate must first be reopened to "open".`,
        currentStatus,
        nextStatus,
      );
    }

    throw new ReviewStateTransitionError(
      `Invalid review transition from "${currentStatus}" to "${nextStatus}" for candidate "${candidateId}".`,
      currentStatus,
      nextStatus,
    );
  }

  if (nextStatus === 'duplicate') {
    validateDuplicateChain(candidateId, duplicateOf, existingStates);
  }
}

/**
 * Validate that a duplicate linking target is valid and does not form a chain or cycle.
 */
export function validateDuplicateChain(
  candidateId: string,
  duplicateOf: string | null,
  existingStates?: Readonly<Record<string, CandidateReviewState>>,
): void {
  if (!duplicateOf || duplicateOf.trim() === '') {
    throw new ReviewStateTransitionError(
      `Candidate "${candidateId}" cannot be set to "duplicate" without specifying a target candidate ID.`,
      null,
      'duplicate',
    );
  }

  const targetId = duplicateOf.trim();
  if (targetId === candidateId) {
    throw new ReviewStateTransitionError(
      `Candidate "${candidateId}" cannot be marked as a duplicate of itself.`,
      null,
      'duplicate',
    );
  }

  if (!existingStates) return;

  const targetState = existingStates[targetId];
  if (targetState) {
    // Direct link to another duplicate candidate is disallowed (no chained duplicates)
    if (targetState.currentStatus === 'duplicate') {
      throw new ReviewStateTransitionError(
        `Invalid duplicate target: candidate "${targetId}" is already marked as duplicate of "${targetState.duplicateOf ?? 'unknown'}". ` +
          'Transitive duplicate chains are not permitted.',
        null,
        'duplicate',
      );
    }

    // Cycle detection: trace target's duplicate chain
    const visited = new Set<string>([candidateId]);
    let curr: CandidateReviewState | undefined = targetState;
    while (curr && curr.duplicateOf) {
      if (visited.has(curr.duplicateOf)) {
        throw new ReviewStateTransitionError(
          `Cycle detected in duplicate chain: "${candidateId}" -> "${targetId}" links back to "${curr.duplicateOf}".`,
          null,
          'duplicate',
        );
      }
      visited.add(curr.duplicateOf);
      curr = existingStates[curr.duplicateOf];
    }
  }
}
