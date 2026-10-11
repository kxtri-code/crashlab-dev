/**
 * Review state event store and deterministic projection.
 *
 * Implements an append-only JSONL event log (`events.jsonl`) and a
 * deterministic, rebuildable projection (`state.json`).
 *
 * Safety & Integrity:
 *  - Every event line is strictly validated against `ReviewStateEvent` schema.
 *  - Malformed or truncated lines are detected and rejected.
 *  - Projection `state.json` is verified against `events.jsonl` before writing.
 *  - Unsafe writes are strictly refused if projection and event history disagree.
 *  - `state.json` can be completely rebuilt deterministically from `events.jsonl`.
 *  - Non-negotiable invariant: `confirmed: false` across all events and states.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateCandidateId } from './identity.js';
import { validateReviewNote, validateReviewerIdentity, validateDuplicateTarget } from './reviewStateValidator.js';
import { validateStateTransition } from './transitions.js';
import {
  DEFAULT_REVIEW_STATE_DIR,
  REVIEW_STATE_EVENTS_FILE,
  REVIEW_STATE_PROJECTION_FILE,
  REVIEW_STATE_SCHEMA_VERSION,
  ReviewStateIntegrityError,
  ReviewStateInputError,
} from './reviewStateTypes.js';
import type {
  CandidateReviewState,
  ReviewStateDocument,
  ReviewStateEvent,
  ReviewStateStatus,
  SourceCandidateReference,
} from './reviewStateTypes.js';

/** Options for recording a review state update. */
export interface RecordReviewEventInput {
  candidateId: string;
  status?: ReviewStateStatus;
  reviewer?: string | null;
  note?: string | null;
  duplicateOf?: string | null;
  reason?: string | null;
  timestamp?: string;
  sourceCandidate?: SourceCandidateReference | null;
  automaticClassification?: string;
}

/** Result of loading review state from disk. */
export interface LoadedReviewState {
  events: ReviewStateEvent[];
  state: ReviewStateDocument | null;
  inconsistent: boolean;
  error?: string;
}

/**
 * Deterministically project a list of review events into a `ReviewStateDocument`.
 *
 * Pure. No I/O.
 */
export function projectReviewState(events: readonly ReviewStateEvent[]): ReviewStateDocument {
  const candidates: Record<string, CandidateReviewState> = {};
  let latestTimestamp = '';

  for (const event of events) {
    if (event.confirmed !== false) {
      throw new ReviewStateIntegrityError(
        `Event "${event.eventId}" violates trust invariant: confirmed must be false.`,
      );
    }

    const cId = event.candidateId;
    const existing = candidates[cId];

    if (!existing) {
      // First event for this candidate
      if (event.previousRevision !== 0 || event.revision !== 1) {
        throw new ReviewStateIntegrityError(
          `Initial event for candidate "${cId}" has invalid revision sequence (rev ${event.revision}, prev ${event.previousRevision}).`,
        );
      }
      if (event.previousStatus !== null) {
        throw new ReviewStateIntegrityError(
          `Initial event for candidate "${cId}" has non-null previous status "${String(event.previousStatus)}".`,
        );
      }

      candidates[cId] = {
        schemaVersion: REVIEW_STATE_SCHEMA_VERSION,
        candidateId: cId,
        currentStatus: event.newStatus,
        firstSeenAt: event.timestamp,
        lastUpdatedAt: event.timestamp,
        reviewer: event.reviewer,
        latestNote: event.note,
        duplicateOf: event.duplicateOf,
        sourceCandidate: event.sourceCandidate,
        revision: 1,
        eventCount: 1,
        lastEventId: event.eventId,
        eventIds: [event.eventId],
        automaticClassification: event.automaticClassification,
        confirmed: false,
        disclaimer: 'Human review state does not modify automatic classification, confirm bugs, or alter severity.',
      };
    } else {
      // Subsequent event for this candidate
      if (event.previousRevision !== existing.revision || event.revision !== existing.revision + 1) {
        throw new ReviewStateIntegrityError(
          `Event "${event.eventId}" for candidate "${cId}" has discontinuous revision sequence ` +
            `(expected prev ${existing.revision}, got ${event.previousRevision}; expected rev ${existing.revision + 1}, got ${event.revision}).`,
        );
      }
      if (event.previousStatus !== existing.currentStatus) {
        throw new ReviewStateIntegrityError(
          `Event "${event.eventId}" for candidate "${cId}" has mismatched previous status ` +
            `(expected "${existing.currentStatus}", got "${String(event.previousStatus)}").`,
        );
      }

      existing.currentStatus = event.newStatus;
      existing.lastUpdatedAt = event.timestamp;
      if (event.reviewer !== null && event.reviewer !== undefined) {
        existing.reviewer = event.reviewer;
      }
      if (event.note !== null && event.note !== undefined) {
        existing.latestNote = event.note;
      }
      existing.duplicateOf = event.duplicateOf ?? (event.newStatus === 'duplicate' ? existing.duplicateOf : null);
      if (event.sourceCandidate) {
        existing.sourceCandidate = event.sourceCandidate;
      }
      if (event.automaticClassification) {
        existing.automaticClassification = event.automaticClassification;
      }
      existing.revision = event.revision;
      existing.eventCount += 1;
      existing.lastEventId = event.eventId;
      existing.eventIds.push(event.eventId);
    }

    if (event.timestamp > latestTimestamp) {
      latestTimestamp = event.timestamp;
    }
  }

  // Sort candidate keys alphabetically for deterministic output
  const sortedCandidates: Record<string, CandidateReviewState> = {};
  for (const key of Object.keys(candidates).sort()) {
    const item = candidates[key];
    if (item) sortedCandidates[key] = item;
  }

  return {
    schemaVersion: REVIEW_STATE_SCHEMA_VERSION,
    updatedAt: latestTimestamp || new Date().toISOString(),
    candidateCount: Object.keys(sortedCandidates).length,
    candidates: sortedCandidates,
    interpretation: {
      confirmedBug: false,
      automaticSeverity: false,
      note: 'Human review state records operator decisions separately from automated evidence.',
    },
  };
}

/** Validate one parsed event from JSONL. */
export function validateEventRecord(record: unknown, lineNumber: number): ReviewStateEvent {
  if (typeof record !== 'object' || record === null) {
    throw new ReviewStateIntegrityError(`Malformed event at line ${lineNumber}: must be a JSON object.`);
  }

  const e = record as Partial<ReviewStateEvent>;

  if (e.schemaVersion !== REVIEW_STATE_SCHEMA_VERSION) {
    throw new ReviewStateIntegrityError(
      `Unsupported schema version "${String(e.schemaVersion)}" at line ${lineNumber} (expected "${REVIEW_STATE_SCHEMA_VERSION}").`,
    );
  }
  if (typeof e.eventId !== 'string' || e.eventId.trim() === '') {
    throw new ReviewStateIntegrityError(`Missing or invalid eventId at line ${lineNumber}.`);
  }
  if (typeof e.candidateId !== 'string' || e.candidateId.trim() === '') {
    throw new ReviewStateIntegrityError(`Missing or invalid candidateId at line ${lineNumber}.`);
  }
  if (typeof e.newStatus !== 'string') {
    throw new ReviewStateIntegrityError(`Missing or invalid newStatus at line ${lineNumber}.`);
  }
  if (typeof e.revision !== 'number' || !Number.isInteger(e.revision) || e.revision < 1) {
    throw new ReviewStateIntegrityError(`Invalid revision at line ${lineNumber}.`);
  }
  if (typeof e.previousRevision !== 'number' || !Number.isInteger(e.previousRevision) || e.previousRevision < 0) {
    throw new ReviewStateIntegrityError(`Invalid previousRevision at line ${lineNumber}.`);
  }
  if (typeof e.timestamp !== 'string' || e.timestamp.trim() === '') {
    throw new ReviewStateIntegrityError(`Missing or invalid timestamp at line ${lineNumber}.`);
  }
  if (e.confirmed !== false) {
    throw new ReviewStateIntegrityError(
      `Violation at line ${lineNumber}: review event confirmed field must be false.`,
    );
  }

  return {
    schemaVersion: e.schemaVersion,
    eventId: e.eventId,
    candidateId: e.candidateId,
    previousStatus: e.previousStatus ?? null,
    newStatus: e.newStatus as ReviewStateStatus,
    reviewer: e.reviewer ?? null,
    note: e.note ?? null,
    duplicateOf: e.duplicateOf ?? null,
    reason: e.reason ?? null,
    timestamp: e.timestamp,
    previousRevision: e.previousRevision,
    revision: e.revision,
    sourceCandidate: e.sourceCandidate ?? null,
    automaticClassification: typeof e.automaticClassification === 'string' ? e.automaticClassification : 'unknown',
    confirmed: false,
  };
}

/** Parse an events.jsonl file safely into an array of validated events. */
export async function loadEventsFile(eventsPath: string): Promise<ReviewStateEvent[]> {
  if (!existsSync(eventsPath)) {
    return [];
  }

  const raw = await readFile(eventsPath, 'utf8');
  const lines = raw.split(/\r?\n/);
  const events: ReviewStateEvent[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue; // skip blank lines

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new ReviewStateIntegrityError(
        `Failed to parse JSONL event at line ${i + 1} in "${eventsPath}": ${(error as Error).message}`,
      );
    }

    const event = validateEventRecord(parsed, i + 1);
    events.push(event);
  }

  return events;
}

/**
 * Load review state and verify consistency between events.jsonl and state.json.
 */
export async function loadReviewState(dir: string = DEFAULT_REVIEW_STATE_DIR): Promise<LoadedReviewState> {
  const eventsPath = join(dir, REVIEW_STATE_EVENTS_FILE);
  const statePath = join(dir, REVIEW_STATE_PROJECTION_FILE);

  if (!existsSync(eventsPath) && !existsSync(statePath)) {
    return { events: [], state: null, inconsistent: false };
  }

  let events: ReviewStateEvent[] = [];
  try {
    events = await loadEventsFile(eventsPath);
  } catch (error) {
    return {
      events: [],
      state: null,
      inconsistent: true,
      error: `Corrupt event history: ${(error as Error).message}`,
    };
  }

  let projected: ReviewStateDocument;
  try {
    projected = projectReviewState(events);
  } catch (error) {
    return {
      events,
      state: null,
      inconsistent: true,
      error: `Failed to project state from events: ${(error as Error).message}`,
    };
  }

  if (existsSync(statePath)) {
    try {
      const rawState = await readFile(statePath, 'utf8');
      const loadedDoc = JSON.parse(rawState) as ReviewStateDocument;

      // Check candidate counts and revisions
      if (loadedDoc.candidateCount !== projected.candidateCount) {
        return {
          events,
          state: loadedDoc,
          inconsistent: true,
          error: `Projection mismatch: state.json reports ${loadedDoc.candidateCount} candidate(s), ` +
            `but events.jsonl projects ${projected.candidateCount} candidate(s).`,
        };
      }

      for (const [cId, projCand] of Object.entries(projected.candidates)) {
        const loadedCand = loadedDoc.candidates[cId];
        if (!loadedCand) {
          return {
            events,
            state: loadedDoc,
            inconsistent: true,
            error: `Projection mismatch: candidate "${cId}" exists in events.jsonl but missing from state.json.`,
          };
        }
        if (
          loadedCand.currentStatus !== projCand.currentStatus ||
          loadedCand.revision !== projCand.revision ||
          loadedCand.lastEventId !== projCand.lastEventId
        ) {
          return {
            events,
            state: loadedDoc,
            inconsistent: true,
            error: `Projection mismatch for candidate "${cId}": state.json status/revision ` +
              `("${loadedCand.currentStatus}", rev ${loadedCand.revision}) does not match events.jsonl ` +
              `("${projCand.currentStatus}", rev ${projCand.revision}).`,
          };
        }
      }

      return { events, state: loadedDoc, inconsistent: false };
    } catch (error) {
      return {
        events,
        state: null,
        inconsistent: true,
        error: `Failed to read or parse state.json: ${(error as Error).message}`,
      };
    }
  }

  // events.jsonl exists but state.json is absent: valid rebuildable state
  return { events, state: projected, inconsistent: false };
}

/** Rebuild state.json projection from events.jsonl. */
export async function rebuildReviewState(dir: string = DEFAULT_REVIEW_STATE_DIR): Promise<ReviewStateDocument> {
  const eventsPath = join(dir, REVIEW_STATE_EVENTS_FILE);
  const statePath = join(dir, REVIEW_STATE_PROJECTION_FILE);

  await mkdir(dir, { recursive: true });
  const events = await loadEventsFile(eventsPath);
  const projected = projectReviewState(events);

  await writeFile(statePath, JSON.stringify(projected, null, 2) + '\n', 'utf8');
  return projected;
}

/**
 * Record a review state update event into events.jsonl and update state.json.
 */
export async function recordReviewEvent(
  dir: string = DEFAULT_REVIEW_STATE_DIR,
  input: RecordReviewEventInput,
): Promise<{ event: ReviewStateEvent; state: ReviewStateDocument }> {
  // Validate candidate ID shape
  const candCheck = validateCandidateId(input.candidateId);
  if (!candCheck.valid) {
    throw new ReviewStateInputError(`Invalid candidate ID "${input.candidateId}": ${candCheck.error ?? ''}`);
  }

  // Load existing state and verify consistency
  const loaded = await loadReviewState(dir);
  if (loaded.inconsistent) {
    throw new ReviewStateIntegrityError(
      `Refusing to record review event because review store is inconsistent: ${loaded.error ?? 'unknown error'}. ` +
        'Run with --rebuild to re-project state.json from events.jsonl if appropriate.',
    );
  }

  const existingCand = loaded.state?.candidates[input.candidateId] ?? null;
  const currentStatus = existingCand ? existingCand.currentStatus : null;
  const targetStatus = input.status ?? (currentStatus ?? 'open');

  // Validate duplicate target and sanitized note / reviewer
  const reviewer = validateReviewerIdentity(input.reviewer);
  const note = validateReviewNote(input.note);
  const duplicateOf = validateDuplicateTarget(input.candidateId, input.duplicateOf, targetStatus);

  // Validate transition
  validateStateTransition(currentStatus, targetStatus, input.candidateId, duplicateOf, loaded.state?.candidates);

  const prevRev = existingCand ? existingCand.revision : 0;
  const nextRev = prevRev + 1;
  const timestamp = input.timestamp ?? new Date().toISOString();

  // Create deterministic unique event ID: evt-<12 hex chars>
  const eventPayload = `${input.candidateId}|${nextRev}|${prevRev}|${targetStatus}|${timestamp}|${reviewer ?? ''}|${note ?? ''}`;
  const eventId = `evt-${createHash('sha256').update(eventPayload, 'utf8').digest('hex').slice(0, 12)}`;

  const event: ReviewStateEvent = {
    schemaVersion: REVIEW_STATE_SCHEMA_VERSION,
    eventId,
    candidateId: input.candidateId,
    previousStatus: currentStatus,
    newStatus: targetStatus,
    reviewer,
    note,
    duplicateOf,
    reason: input.reason ?? null,
    timestamp,
    previousRevision: prevRev,
    revision: nextRev,
    sourceCandidate: input.sourceCandidate ?? existingCand?.sourceCandidate ?? null,
    automaticClassification: input.automaticClassification ?? existingCand?.automaticClassification ?? 'unknown',
    confirmed: false,
  };

  await mkdir(dir, { recursive: true });
  const eventsPath = join(dir, REVIEW_STATE_EVENTS_FILE);
  const statePath = join(dir, REVIEW_STATE_PROJECTION_FILE);

  // Append event line to events.jsonl
  await appendFile(eventsPath, JSON.stringify(event) + '\n', 'utf8');

  // Compute updated projected document and write state.json
  const updatedEvents = [...loaded.events, event];
  const newState = projectReviewState(updatedEvents);
  await writeFile(statePath, JSON.stringify(newState, null, 2) + '\n', 'utf8');

  return { event, state: newState };
}
