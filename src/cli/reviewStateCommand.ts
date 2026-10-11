/**
 * The `review-state` command (Build 8).
 *
 * Records durable human review decisions separately from automated evidence,
 * observations, and candidate classifications.
 *
 * Exits:
 *   0  success (state updated, listed, shown, or rebuilt)
 *   1  domain error (invalid transition, inconsistent store, invalid note/reviewer)
 *   2  bad arguments
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { flagValue, scanArgs } from './args.js';
import { validateCandidateId } from '../review/identity.js';
import {
  DEFAULT_REVIEW_STATE_DIR,
  ReviewStateError,
  ReviewStateInputError,
  ReviewStateIntegrityError,
  ReviewStateTransitionError,
} from '../review/reviewStateTypes.js';
import type { CandidateReviewState, ReviewStateStatus, SourceCandidateReference } from '../review/reviewStateTypes.js';
import { isReviewStateStatus } from '../review/transitions.js';
import { loadReviewState, rebuildReviewState, recordReviewEvent } from '../review/reviewStateStore.js';
import { DEFAULT_CANDIDATE_OUTPUT_PATH } from '../review/types.js';
import type { Candidate, CandidateReport } from '../review/types.js';
import { TOOL_NAME, TOOL_VERSION } from '../version.js';

/** Flags recognized by `review-state`. */
export const REVIEW_STATE_FLAGS = [
  '--state',
  '--candidates',
  '--candidate',
  '--status',
  '--reviewer',
  '--note',
  '--duplicate-of',
  '--reason',
  '--list',
  '--show',
  '--rebuild',
  '--help',
  '-h',
] as const;

export const REVIEW_STATE_USAGE = `${TOOL_NAME} v${TOOL_VERSION} - Review State

Usage:
  npm run review-state -- [options]

Options:
  --state <dir>           Review state directory          [default: ${DEFAULT_REVIEW_STATE_DIR}]
  --candidates <path>     Candidate report path           [default: ${DEFAULT_CANDIDATE_OUTPUT_PATH}]
  --candidate <id>        Target candidate ID to update or review
  --status <status>       New review status (open, investigating, accepted, dismissed, duplicate, resolved)
  --reviewer <name>       Operator/reviewer identifier
  --note <text>           Human review note (max 1000 chars)
  --duplicate-of <id>     Target candidate ID when status is "duplicate"
  --reason <text>         Optional explanation for the status update
  --list                  List candidates and current review states
  --show <id>             Show event history for a candidate
  --rebuild               Rebuild projection state.json from events.jsonl
  -h, --help              Show this message

Statuses:
  open                    Candidate is open for review or reopened
  investigating           Candidate is actively being investigated
  accepted                Candidate is acknowledged as a valid issue (never confirms a bug)
  dismissed               Candidate was reviewed and dismissed (must reopen to transition)
  duplicate               Candidate duplicates another candidate (--duplicate-of required)
  resolved                Candidate has been resolved/handled (must reopen to transition)

A human review state never modifies evidence, never confirms bugs, and never alters severity.`;

/** Parsed `review-state` arguments. */
export interface ParsedReviewStateArgs {
  stateDir: string;
  candidatesPath: string;
  candidateId: string | null;
  status: ReviewStateStatus | null;
  reviewer: string | null;
  note: string | null;
  duplicateOf: string | null;
  reason: string | null;
  list: boolean;
  showId: string | null;
  rebuild: boolean;
  valid: boolean;
  error: string | null;
  unknown: string[];
}

/** Parse arguments for `review-state`. */
export function parseReviewStateArgs(argv: readonly string[]): ParsedReviewStateArgs {
  const scan = scanArgs(argv);
  const parsed: ParsedReviewStateArgs = {
    stateDir: process.env.CRASHLAB_REVIEW_STATE_DIR?.trim() || DEFAULT_REVIEW_STATE_DIR,
    candidatesPath: process.env.CRASHLAB_CANDIDATE_OUTPUT?.trim() || DEFAULT_CANDIDATE_OUTPUT_PATH,
    candidateId: null,
    status: null,
    reviewer: null,
    note: null,
    duplicateOf: null,
    reason: null,
    list: scan.flags.has('--list'),
    showId: null,
    rebuild: scan.flags.has('--rebuild'),
    valid: true,
    error: null,
    unknown: [...scan.flags.keys()].filter((flag) => !(REVIEW_STATE_FLAGS as readonly string[]).includes(flag)),
  };

  if (parsed.unknown.length > 0) {
    parsed.error = `Unknown option: ${parsed.unknown[0]}. Run with --help to see supported options.`;
    parsed.valid = false;
    return parsed;
  }

  const requireValue = (names: readonly string[]): string | null => {
    const found = flagValue(scan, names);
    if (!found.present) return null;
    if (found.missingValue) {
      parsed.error = `Option ${names[0]} requires a value.`;
      parsed.valid = false;
      return null;
    }
    return found.value;
  };

  const stateDir = requireValue(['--state']);
  if (stateDir) parsed.stateDir = stateDir;

  const candidatesPath = requireValue(['--candidates']);
  if (candidatesPath) parsed.candidatesPath = candidatesPath;

  const candidateId = requireValue(['--candidate']);
  if (candidateId) parsed.candidateId = candidateId;

  const statusRaw = requireValue(['--status']);
  if (statusRaw) {
    if (!isReviewStateStatus(statusRaw)) {
      parsed.error = `Invalid status "${statusRaw}". Valid statuses: open, investigating, accepted, dismissed, duplicate, resolved.`;
      parsed.valid = false;
      return parsed;
    }
    parsed.status = statusRaw;
  }

  const reviewer = requireValue(['--reviewer']);
  if (reviewer) parsed.reviewer = reviewer;

  const note = requireValue(['--note']);
  if (note) parsed.note = note;

  const duplicateOf = requireValue(['--duplicate-of']);
  if (duplicateOf) parsed.duplicateOf = duplicateOf;

  const reason = requireValue(['--reason']);
  if (reason) parsed.reason = reason;

  const showId = requireValue(['--show']);
  if (showId) parsed.showId = showId;

  // Validation: must have an action
  if (!parsed.list && !parsed.rebuild && !parsed.showId && !parsed.candidateId) {
    parsed.error = 'No action specified. Provide --candidate, --list, --show, or --rebuild.';
    parsed.valid = false;
    return parsed;
  }

  return parsed;
}

/** Helper to load CandidateReport if available. */
async function tryLoadCandidates(candidatesPath: string): Promise<CandidateReport | null> {
  if (!existsSync(candidatesPath)) return null;
  try {
    const raw = await readFile(candidatesPath, 'utf8');
    return JSON.parse(raw) as CandidateReport;
  } catch {
    return null;
  }
}

/** Resolve target candidate ID and reference from candidates report if possible. */
function resolveCandidateInfo(
  inputCandidateId: string,
  candidatesReport: CandidateReport | null,
  candidatesPath: string,
): { resolvedId: string; sourceCandidate: SourceCandidateReference | null; automaticClassification: string } {
  if (!candidatesReport) {
    return {
      resolvedId: inputCandidateId,
      sourceCandidate: null,
      automaticClassification: 'unknown',
    };
  }

  // Check matching by candidateId (canonical) or id (alias like candidate-001)
  const match = candidatesReport.candidates.find(
    (c) => (c.candidateId && c.candidateId === inputCandidateId) || c.id === inputCandidateId,
  );

  if (match) {
    const canonicalId = match.candidateId ?? match.id;
    return {
      resolvedId: canonicalId,
      sourceCandidate: {
        report: candidatesPath,
        candidateId: canonicalId,
        signalKeyHash: match.signalKeyHash,
        ruleId: match.ruleId,
        kind: match.kind,
        classification: match.classification,
      },
      automaticClassification: match.classification,
    };
  }

  return {
    resolvedId: inputCandidateId,
    sourceCandidate: null,
    automaticClassification: 'unknown',
  };
}

/** Format a single candidate line for terminal listing. */
function formatCandidateRow(candId: string, state: CandidateReviewState | null, autoClass = 'unknown'): string {
  const statusStr = state ? state.currentStatus.padEnd(14) : '(unreviewed)'.padEnd(14);
  const reviewerStr = (state?.reviewer ?? '-').padEnd(12);
  const revStr = state ? `rev ${state.revision}`.padEnd(8) : '-'.padEnd(8);
  const autoStr = (state?.automaticClassification ?? autoClass).padEnd(14);
  const noteSnippet = state?.latestNote ? ` "${state.latestNote.slice(0, 30)}${state.latestNote.length > 30 ? '...' : ''}"` : '';
  return `  ${candId.padEnd(24)} ${statusStr} ${autoStr} ${reviewerStr} ${revStr}${noteSnippet}`;
}

/** Run the `review-state` command. Returns process exit code. */
export async function runReviewStateCommand(argv: readonly string[]): Promise<number> {
  const args = parseReviewStateArgs(argv);

  if (!args.valid) {
    console.error(args.error ?? 'Invalid arguments.');
    console.error('');
    console.error(REVIEW_STATE_USAGE);
    return 2;
  }

  console.log(`CRASHLAB SCOUT - REVIEW STATE v${TOOL_VERSION}`);
  console.log(`  Directory: ${args.stateDir}`);

  // Mode: Rebuild projection
  if (args.rebuild) {
    try {
      const doc = await rebuildReviewState(args.stateDir);
      console.log('');
      console.log(`Successfully rebuilt projection for ${doc.candidateCount} candidate(s).`);
      console.log(`Updated at: ${doc.updatedAt}`);
      return 0;
    } catch (error) {
      console.error('');
      console.error(`Rebuild failed: ${(error as Error).message}`);
      return 1;
    }
  }

  const loadedState = await loadReviewState(args.stateDir);
  if (loadedState.inconsistent) {
    console.error('');
    console.error(`Review state integrity check failed: ${loadedState.error ?? 'Inconsistent store'}`);
    console.error('Use --rebuild to re-project state.json from events.jsonl.');
    return 1;
  }

  // Mode: Show single candidate history
  if (args.showId) {
    const candidatesReport = await tryLoadCandidates(args.candidatesPath);
    const resolved = resolveCandidateInfo(args.showId, candidatesReport, args.candidatesPath);
    const candState = loadedState.state?.candidates[resolved.resolvedId];

    if (!candState) {
      console.log('');
      console.log(`No review state recorded for candidate "${resolved.resolvedId}".`);
      return 0;
    }

    console.log('');
    console.log(`CANDIDATE: ${candState.candidateId}`);
    console.log(`  Current Status:           ${candState.currentStatus}`);
    console.log(`  Automatic Classification: ${candState.automaticClassification}`);
    console.log(`  Revision:                 ${candState.revision}`);
    console.log(`  First Seen:               ${candState.firstSeenAt}`);
    console.log(`  Last Updated:             ${candState.lastUpdatedAt}`);
    console.log(`  Reviewer:                 ${candState.reviewer ?? '(none)'}`);
    console.log(`  Latest Note:              ${candState.latestNote ?? '(none)'}`);
    if (candState.duplicateOf) {
      console.log(`  Duplicate Of:             ${candState.duplicateOf}`);
    }
    console.log(`  Confirmed Bug:            ${String(candState.confirmed)} (invariant)`);
    console.log('');
    console.log('EVENT HISTORY:');
    const candEvents = loadedState.events.filter((e) => e.candidateId === resolved.resolvedId);
    for (const e of candEvents) {
      const prev = e.previousStatus ?? 'none';
      console.log(`  [rev ${e.revision}] ${e.timestamp} | ${prev} -> ${e.newStatus} by ${e.reviewer ?? 'anonymous'} (${e.eventId})`);
      if (e.note) console.log(`         Note: "${e.note}"`);
      if (e.duplicateOf) console.log(`         DuplicateOf: ${e.duplicateOf}`);
    }
    return 0;
  }

  // Mode: List
  if (args.list) {
    const candidatesReport = await tryLoadCandidates(args.candidatesPath);
    console.log('');
    console.log('  Candidate ID             Status         Classification Reviewer     Revision Note');
    console.log('  ------------------------ -------------- -------------- ------------ -------- -----------------');

    const listedIds = new Set<string>();

    // If candidate report exists, list all candidates from report and their review state
    if (candidatesReport && candidatesReport.candidates.length > 0) {
      for (const c of candidatesReport.candidates) {
        const canonicalId = c.candidateId ?? c.id;
        listedIds.add(canonicalId);
        const state = loadedState.state?.candidates[canonicalId] ?? null;
        console.log(formatCandidateRow(canonicalId, state, c.classification));
      }
    }

    // List any additional candidates present in review state not in candidates report
    if (loadedState.state) {
      for (const [cId, state] of Object.entries(loadedState.state.candidates)) {
        if (!listedIds.has(cId)) {
          listedIds.add(cId);
          console.log(formatCandidateRow(cId, state));
        }
      }
    }

    if (listedIds.size === 0) {
      console.log('  (no candidates found in candidate report or review state)');
    }
    return 0;
  }

  // Mode: Record update on --candidate
  if (args.candidateId) {
    const candidatesReport = await tryLoadCandidates(args.candidatesPath);
    const resolved = resolveCandidateInfo(args.candidateId, candidatesReport, args.candidatesPath);

    // Resolve duplicate target if provided
    let duplicateOfTarget = args.duplicateOf;
    if (duplicateOfTarget && candidatesReport) {
      const resolvedDup = resolveCandidateInfo(duplicateOfTarget, candidatesReport, args.candidatesPath);
      duplicateOfTarget = resolvedDup.resolvedId;
    }

    try {
      const { event, state } = await recordReviewEvent(args.stateDir, {
        candidateId: resolved.resolvedId,
        status: args.status ?? undefined,
        reviewer: args.reviewer,
        note: args.note,
        duplicateOf: duplicateOfTarget,
        reason: args.reason,
        sourceCandidate: resolved.sourceCandidate,
        automaticClassification: resolved.automaticClassification,
      });

      console.log('');
      console.log(`RECORDED REVIEW EVENT: ${event.eventId}`);
      console.log(`  Candidate ID:             ${event.candidateId}`);
      console.log(`  Previous Status:          ${event.previousStatus ?? '(none)'}`);
      console.log(`  New Status:               ${event.newStatus}`);
      console.log(`  Revision:                 ${event.revision}`);
      console.log(`  Reviewer:                 ${event.reviewer ?? '(none)'}`);
      if (event.note) {
        console.log(`  Note:                     "${event.note}"`);
      }
      if (event.duplicateOf) {
        console.log(`  Duplicate Of:             ${event.duplicateOf}`);
      }
      console.log(`  Automatic Classification: ${event.automaticClassification}`);
      console.log(`  Confirmed Bug:            ${String(event.confirmed)} (invariant)`);
      console.log('');
      console.log(`Updated state for ${state.candidateCount} candidate(s) in ${args.stateDir}.`);
      return 0;
    } catch (error) {
      console.error('');
      if (
        error instanceof ReviewStateTransitionError ||
        error instanceof ReviewStateInputError ||
        error instanceof ReviewStateIntegrityError ||
        error instanceof ReviewStateError
      ) {
        console.error(`Review state update rejected: ${error.message}`);
      } else {
        console.error(`Unexpected review state error: ${(error as Error).message}`);
      }
      return 1;
    }
  }

  return 0;
}
