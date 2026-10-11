/**
 * Review State Contract (Build 8).
 *
 * Records durable human review decisions separately from automated evidence,
 * observations, and candidate classifications.
 *
 * Core Guarantees:
 *  1. `execution.json`, `journey.json`, `anomalies.json`, `reproduction.json`,
 *     `candidates.json`, and baseline files remain strictly immutable.
 *  2. Review state never modifies or upgrades automatic classifications.
 *  3. Review state never sets `confirmedBug: true` or `confirmed: true`.
 *  4. Review state never alters automatic severity or signal level.
 *  5. Pure file-based event-sourced store with append-only history and
 *     deterministic rebuildable projection.
 */

/** Schema version for review state events and documents. */
export const REVIEW_STATE_SCHEMA_VERSION = '1.0';

/** Default directory for review state files. */
export const DEFAULT_REVIEW_STATE_DIR = 'reports/review-state';

/** Append-only JSONL events log filename. */
export const REVIEW_STATE_EVENTS_FILE = 'events.jsonl';

/** Deterministic projection filename. */
export const REVIEW_STATE_PROJECTION_FILE = 'state.json';

/** Maximum character length for human review notes. */
export const MAX_REVIEW_NOTE_LENGTH = 1000;

/** Supported human review statuses. */
export type ReviewStateStatus =
  | 'open'
  | 'investigating'
  | 'accepted'
  | 'dismissed'
  | 'duplicate'
  | 'resolved';

/** Reference to the source candidate in a candidate report. */
export interface SourceCandidateReference {
  report: string;
  candidateId: string;
  signalKeyHash: string;
  ruleId: string;
  kind?: string;
  classification?: string;
}

/** One append-only event recorded in events.jsonl. */
export interface ReviewStateEvent {
  schemaVersion: string;
  eventId: string;
  candidateId: string;
  previousStatus: ReviewStateStatus | null;
  newStatus: ReviewStateStatus;
  reviewer: string | null;
  note: string | null;
  duplicateOf: string | null;
  reason: string | null;
  timestamp: string;
  previousRevision: number;
  revision: number;
  sourceCandidate: SourceCandidateReference | null;
  automaticClassification: string;
  /** Always false. Human review state never confirms a bug. */
  confirmed: false;
}

/** Projected current review state for a single candidate. */
export interface CandidateReviewState {
  schemaVersion: string;
  candidateId: string;
  currentStatus: ReviewStateStatus;
  firstSeenAt: string;
  lastUpdatedAt: string;
  reviewer: string | null;
  latestNote: string | null;
  duplicateOf: string | null;
  sourceCandidate: SourceCandidateReference | null;
  revision: number;
  eventCount: number;
  lastEventId: string;
  eventIds: string[];
  automaticClassification: string;
  /** Explicit statement that human state does not modify automatic classification. */
  confirmed: false;
  disclaimer: string;
}

/** Top-level projected review state document stored in state.json. */
export interface ReviewStateDocument {
  schemaVersion: string;
  updatedAt: string;
  candidateCount: number;
  candidates: Record<string, CandidateReviewState>;
  interpretation: {
    confirmedBug: false;
    automaticSeverity: false;
    note: string;
  };
}

/** General review-state error. */
export class ReviewStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewStateError';
  }
}

/** Thrown when an invalid status transition is attempted. */
export class ReviewStateTransitionError extends ReviewStateError {
  readonly fromStatus: ReviewStateStatus | null;
  readonly toStatus: ReviewStateStatus;

  constructor(message: string, fromStatus: ReviewStateStatus | null, toStatus: ReviewStateStatus) {
    super(message);
    this.name = 'ReviewStateTransitionError';
    this.fromStatus = fromStatus;
    this.toStatus = toStatus;
  }
}

/** Thrown when projection and event history disagree or data is corrupted. */
export class ReviewStateIntegrityError extends ReviewStateError {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewStateIntegrityError';
  }
}

/** Thrown when input arguments (notes, reviewer, duplicate-of, candidate ID) are invalid. */
export class ReviewStateInputError extends ReviewStateError {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewStateInputError';
  }
}
