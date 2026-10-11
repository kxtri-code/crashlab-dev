/**
 * Pure Query Layer for Review API (Build 9.1).
 *
 * Guarantees:
 *  - Pure, deterministic in-memory queries over loaded data models.
 *  - No Playwright imports.
 *  - No node:http imports.
 *  - No network calls.
 *  - No file writes or mutations.
 *  - Preserves strict distinction between automatic classification and human review state.
 *  - Non-negotiable invariant: `confirmedBug: false` and `confirmed: false` across all projections.
 */

import type { Candidate, CandidateClassification, CandidateReport, ReviewComparison } from '../review/types.js';
import type { ReviewStateDocument, ReviewStateEvent, ReviewStateStatus } from '../review/reviewStateTypes.js';
import type { Baseline, BaselineRegistryEntry, BaselineStatus } from '../baseline/types.js';
import type { JourneyPlan } from '../journey/types.js';
import type { ExecutionReport } from '../executor/types.js';
import type { AnomalyReport } from '../anomaly/report.js';
import type { ReproductionReport } from '../reproducer/types.js';
import { safeTargetOrigin } from '../provenance/redaction.js';
import { candidateNotFoundError, baselineNotFoundError } from './errors.js';
import {
  REVIEW_API_SCHEMA_VERSION,
  type ApiSummaryResponse,
  type ApiCandidatesListResponse,
  type ApiCandidateListItem,
  type ApiCandidateDetailResponse,
  type ApiCandidateHistoryResponse,
  type ApiReviewHistoryEvent,
  type ApiBaselinesListResponse,
  type ApiBaselineListItem,
  type ApiBaselineDetailResponse,
  type ApiRunContextResponse,
  type CandidateQueryFilters,
  type BaselineQueryFilters,
} from './types.js';

/** In-memory data store for the pure query layer. */
export interface ReviewApiData {
  candidateReport: CandidateReport;
  reviewStateDoc: ReviewStateDocument | null;
  reviewEvents: ReviewStateEvent[];
  baselines: BaselineRegistryEntry[];
  baselineMap: Map<string, Baseline>;
  journey: JourneyPlan | null;
  execution: ExecutionReport | null;
  anomalies: AnomalyReport | null;
  reproduction: ReproductionReport | null;
}

/** Automatic classification sort priority (lower number = higher priority). */
const CLASSIFICATION_PRIORITY: Record<string, number> = {
  novel: 1,
  reintroduced: 2,
  regression: 3,
  unexpected: 4,
  divergent_reproduction: 5,
  persistent: 6,
  changed: 7,
  'cross-environment': 8,
  'different-build': 9,
  stable: 10,
  intentional_change: 11,
  environmental_difference: 12,
  resolved: 13,
  unknown: 14,
  unclassified: 15,
};

/** Human review status sort priority (lower number = higher priority). */
const REVIEW_STATUS_PRIORITY: Record<string, number> = {
  open: 1,
  investigating: 2,
  accepted: 3,
  unreviewed: 4,
  duplicate: 5,
  dismissed: 6,
  resolved: 7,
};

/**
 * Deterministically sort candidates:
 * 1. Automatic classification priority
 * 2. Human review status priority
 * 3. Canonical candidate ID (or positional ID)
 */
export function sortCandidates(items: ApiCandidateListItem[]): ApiCandidateListItem[] {
  return [...items].sort((a, b) => {
    const prioA = CLASSIFICATION_PRIORITY[a.classification] ?? 99;
    const prioB = CLASSIFICATION_PRIORITY[b.classification] ?? 99;
    if (prioA !== prioB) return prioA - prioB;

    const statA = REVIEW_STATUS_PRIORITY[a.reviewStatus] ?? 99;
    const statB = REVIEW_STATUS_PRIORITY[b.reviewStatus] ?? 99;
    if (statA !== statB) return statA - statB;

    return a.candidateId.localeCompare(b.candidateId);
  });
}

/**
 * Deterministically sort baselines:
 * 1. createdAt descending
 * 2. baselineId ascending
 */
export function sortBaselines(items: ApiBaselineListItem[]): ApiBaselineListItem[] {
  return [...items].sort((a, b) => {
    const timeDiff = b.createdAt.localeCompare(a.createdAt);
    if (timeDiff !== 0) return timeDiff;
    return a.baselineId.localeCompare(b.baselineId);
  });
}

/**
 * Deterministically sort review events:
 * 1. revision ascending
 * 2. timestamp ascending
 * 3. eventId ascending
 */
export function sortReviewEvents(events: ReviewStateEvent[]): ReviewStateEvent[] {
  return [...events].sort((a, b) => {
    if (a.revision !== b.revision) return a.revision - b.revision;
    const timeDiff = a.timestamp.localeCompare(b.timestamp);
    if (timeDiff !== 0) return timeDiff;
    return a.eventId.localeCompare(b.eventId);
  });
}

/**
 * Resolve candidate ID or positional alias (e.g. `candidate-001`) from candidate report.
 */
export function findCandidate(candidates: readonly Candidate[], candidateId: string): Candidate | null {
  const trimmed = candidateId.trim();
  for (const c of candidates) {
    if (c.candidateId === trimmed || c.id === trimmed) {
      return c;
    }
  }
  return null;
}

/**
 * Get human review state for a candidate from state.json if present.
 */
function getHumanReviewStatus(
  reviewStateDoc: ReviewStateDocument | null,
  canonicalId: string,
): ReviewStateStatus | 'unreviewed' {
  if (!reviewStateDoc) return 'unreviewed';
  const entry = reviewStateDoc.candidates[canonicalId];
  return entry ? entry.currentStatus : 'unreviewed';
}

/**
 * Project candidate into ApiCandidateListItem.
 */
function toCandidateListItem(
  c: Candidate,
  reviewStateDoc: ReviewStateDocument | null,
  limitations: readonly string[] = [],
): ApiCandidateListItem {
  const canonicalId = c.candidateId ?? c.id;
  const humanStatus = getHumanReviewStatus(reviewStateDoc, canonicalId);

  return {
    candidateId: canonicalId,
    id: c.id,
    ruleId: c.ruleId,
    kind: c.kind,
    classification: c.classification,
    reviewStatus: humanStatus,
    reproduced: c.reproduced,
    baselinePresent: c.baselinePresent,
    currentPresent: c.currentPresent,
    environmentComparison: c.environmentComparison,
    requiresInvestigation: c.requiresInvestigation,
    reproductionClassification: c.reproductionClassification,
    stepOrder: c.stepOrder,
    evidence: {
      currentAnomalyIds: [...c.evidence.currentAnomalyIds].sort(),
      reproductionResultIds: [...c.evidence.reproductionResultIds].sort(),
      baselineSignalKeys: [...c.evidence.baselineSignalKeys].sort(),
      relatedBaselineSignalKey: c.evidence.relatedBaselineSignalKey,
    },
    message: c.message,
    knownLimitations: [...limitations],
    confirmed: false,
  };
}

/**
 * GET /api/summary
 */
export function querySummary(data: ReviewApiData): ApiSummaryResponse {
  const report = data.candidateReport;
  const candidates = report.candidates ?? [];
  const byClassification: Record<string, number> = {};
  const byReviewStatus: Record<string, number> = {};

  let requiringInvestigation = 0;
  let reproducedCount = 0;
  let unknownCount = 0;
  let withLimitationsCount = 0;

  const limitations = report.comparisonLimitations ?? [];

  for (const c of candidates) {
    byClassification[c.classification] = (byClassification[c.classification] ?? 0) + 1;
    const humanStatus = getHumanReviewStatus(data.reviewStateDoc, c.candidateId ?? c.id);
    byReviewStatus[humanStatus] = (byReviewStatus[humanStatus] ?? 0) + 1;

    if (c.requiresInvestigation) requiringInvestigation++;
    if (c.reproduced) reproducedCount++;
    if (c.classification === 'unknown') unknownCount++;
    if (limitations.length > 0) withLimitationsCount++;
  }

  const origin = report.comparison?.targetOrigin ? safeTargetOrigin(report.comparison.targetOrigin).origin : null;

  return {
    schemaVersion: REVIEW_API_SCHEMA_VERSION,
    totalCandidates: candidates.length,
    byClassification,
    byReviewStatus,
    requiringInvestigation,
    reproducedCount,
    unknownCount,
    withLimitationsCount,
    baseline: report.baseline || report.selectedBaselineId
      ? {
          selectedBaselineId: report.selectedBaselineId ?? report.baseline?.baselineId ?? null,
          selectionMode: report.selectionMode ?? (report.baseline ? 'explicit' : 'none'),
          parentBaselineId: report.parentBaselineId ?? null,
          comparisonClassification: report.comparison?.classification ?? 'no-baseline',
          limitations,
        }
      : null,
    reviewState: {
      candidateCount: data.reviewStateDoc?.candidateCount ?? Object.keys(data.reviewStateDoc?.candidates ?? {}).length,
      updatedAt: data.reviewStateDoc?.updatedAt ?? null,
    },
    provenance: {
      targetOrigin: origin,
      journeyHash: report.comparison?.journeyHash ?? null,
      applicationBuildId: data.execution?.environment?.application?.buildId ?? null,
      environmentFingerprint: report.comparison?.environmentFingerprint ?? null,
    },
    interpretation: {
      confirmedBug: false,
      automaticSeverity: false,
      note: 'CrashLab does not confirm bugs automatically. All candidates require human review.',
    },
  };
}

/**
 * GET /api/candidates
 */
export function queryCandidates(data: ReviewApiData, filters: CandidateQueryFilters): ApiCandidatesListResponse {
  const limitations = data.candidateReport.comparisonLimitations ?? [];
  let list = (data.candidateReport.candidates ?? []).map((c) =>
    toCandidateListItem(c, data.reviewStateDoc, limitations),
  );

  // Apply filters
  if (filters.classification !== undefined) {
    list = list.filter((item) => item.classification === filters.classification);
  }
  if (filters.reviewStatus !== undefined) {
    list = list.filter((item) => item.reviewStatus === filters.reviewStatus);
  }
  if (filters.ruleId !== undefined) {
    list = list.filter((item) => item.ruleId === filters.ruleId);
  }
  if (filters.kind !== undefined) {
    list = list.filter((item) => item.kind === filters.kind);
  }
  if (filters.reproduced !== undefined) {
    list = list.filter((item) => item.reproduced === filters.reproduced);
  }
  if (filters.environment !== undefined) {
    list = list.filter((item) => item.environmentComparison === filters.environment);
  }
  if (filters.requiresInvestigation !== undefined) {
    list = list.filter((item) => item.requiresInvestigation === filters.requiresInvestigation);
  }
  if (filters.baselinePresent !== undefined) {
    list = list.filter((item) => item.baselinePresent === filters.baselinePresent);
  }
  if (filters.currentPresent !== undefined) {
    list = list.filter((item) => item.currentPresent === filters.currentPresent);
  }

  const sorted = sortCandidates(list);
  const totalCount = sorted.length;
  const offset = filters.offset ?? 0;
  const limit = filters.limit ?? 50;

  const paginated = sorted.slice(offset, offset + limit);

  return {
    schemaVersion: REVIEW_API_SCHEMA_VERSION,
    totalCount,
    returnedCount: paginated.length,
    offset,
    limit,
    candidates: paginated,
  };
}

/**
 * GET /api/candidates/:candidateId
 */
export function queryCandidateDetail(data: ReviewApiData, candidateId: string): ApiCandidateDetailResponse {
  const candidate = findCandidate(data.candidateReport.candidates ?? [], candidateId);
  if (!candidate) {
    throw candidateNotFoundError(candidateId);
  }

  const canonicalId = candidate.candidateId ?? candidate.id;
  const humanEntry = data.reviewStateDoc?.candidates[canonicalId];
  const origin = data.candidateReport.comparison?.targetOrigin
    ? safeTargetOrigin(data.candidateReport.comparison.targetOrigin).origin
    : null;

  const limitations = data.candidateReport.comparisonLimitations ?? [];

  return {
    schemaVersion: REVIEW_API_SCHEMA_VERSION,
    candidateId: canonicalId,
    id: candidate.id,
    ruleId: candidate.ruleId,
    kind: candidate.kind,
    classification: candidate.classification,
    reviewStatus: humanEntry ? humanEntry.currentStatus : 'unreviewed',
    reproduced: candidate.reproduced,
    baselinePresent: candidate.baselinePresent,
    currentPresent: candidate.currentPresent,
    environmentComparison: candidate.environmentComparison,
    requiresInvestigation: candidate.requiresInvestigation,
    reproductionClassification: candidate.reproductionClassification,
    stepOrder: candidate.stepOrder,
    evidence: {
      currentAnomalyIds: [...candidate.evidence.currentAnomalyIds].sort(),
      reproductionResultIds: [...candidate.evidence.reproductionResultIds].sort(),
      baselineSignalKeys: [...candidate.evidence.baselineSignalKeys].sort(),
      relatedBaselineSignalKey: candidate.evidence.relatedBaselineSignalKey,
    },
    message: candidate.message,
    knownLimitations: [...limitations],
    humanReviewState: {
      currentStatus: humanEntry ? humanEntry.currentStatus : 'unreviewed',
      revision: humanEntry ? humanEntry.revision : 0,
      firstSeenAt: humanEntry ? humanEntry.firstSeenAt : null,
      lastUpdatedAt: humanEntry ? humanEntry.lastUpdatedAt : null,
      reviewer: humanEntry ? humanEntry.reviewer : null,
      latestNote: humanEntry ? humanEntry.latestNote : null,
      duplicateOf: humanEntry ? humanEntry.duplicateOf : null,
      eventCount: humanEntry ? humanEntry.eventCount : 0,
    },
    provenance: {
      targetOrigin: origin,
      journeyHash: data.candidateReport.comparison?.journeyHash ?? null,
      applicationBuildId: data.execution?.environment?.application?.buildId ?? null,
    },
    interpretation: {
      confirmedBug: false,
      automaticSeverity: false,
      note: 'CrashLab candidate defect reports do not automatically confirm bugs.',
    },
    confirmed: false,
  };
}

/**
 * GET /api/candidates/:candidateId/history
 */
export function queryCandidateHistory(data: ReviewApiData, candidateId: string): ApiCandidateHistoryResponse {
  const candidate = findCandidate(data.candidateReport.candidates ?? [], candidateId);
  const canonicalId = candidate ? (candidate.candidateId ?? candidate.id) : candidateId;

  // Check if candidate exists either in report or has events
  const candidateEvents = data.reviewEvents.filter((e) => e.candidateId === canonicalId);

  if (!candidate && candidateEvents.length === 0) {
    throw candidateNotFoundError(candidateId);
  }

  const sortedEvents = sortReviewEvents(candidateEvents);
  const humanEntry = data.reviewStateDoc?.candidates[canonicalId];
  const currentStatus = humanEntry ? humanEntry.currentStatus : 'unreviewed';

  const mappedEvents: ApiReviewHistoryEvent[] = sortedEvents.map((e) => ({
    eventId: e.eventId,
    revision: e.revision,
    previousRevision: e.previousRevision,
    previousStatus: e.previousStatus,
    newStatus: e.newStatus,
    reviewer: e.reviewer,
    note: e.note,
    duplicateOf: e.duplicateOf,
    reason: e.reason,
    timestamp: e.timestamp,
    automaticClassification: e.automaticClassification,
    confirmed: false,
  }));

  return {
    schemaVersion: REVIEW_API_SCHEMA_VERSION,
    candidateId: canonicalId,
    currentStatus,
    unreviewed: candidateEvents.length === 0,
    eventCount: mappedEvents.length,
    events: mappedEvents,
    confirmed: false,
  };
}

/**
 * GET /api/baselines
 */
export function queryBaselines(data: ReviewApiData, filters: BaselineQueryFilters): ApiBaselinesListResponse {
  let list = data.baselines.map((b): ApiBaselineListItem => {
    const baselineDoc = data.baselineMap.get(b.baselineId);
    return {
      baselineId: b.baselineId,
      name: b.name,
      targetOrigin: b.targetOrigin ? safeTargetOrigin(b.targetOrigin).origin : null,
      journeyHash: b.journeyHash ?? baselineDoc?.identity?.journeyHash ?? '',
      applicationBuildId: b.applicationBuildId ?? baselineDoc?.identity?.applicationBuildId ?? null,
      status: b.status ?? baselineDoc?.status ?? 'known-good',
      verificationCoverage: b.verificationCoverage ?? baselineDoc?.verification?.coverage ?? 'unavailable',
      parentBaselineId: b.parentBaselineId ?? baselineDoc?.parentBaselineId ?? null,
      lineageDepth: baselineDoc?.lineage?.depth ?? 0,
      createdAt: b.createdAt,
      knownSignalCount: baselineDoc?.knownSignals?.length ?? 0,
    };
  });

  if (filters.origin !== undefined) {
    list = list.filter((b) => b.targetOrigin === filters.origin);
  }
  if (filters.journey !== undefined) {
    list = list.filter((b) => b.journeyHash === filters.journey);
  }
  if (filters.build !== undefined) {
    list = list.filter((b) => b.applicationBuildId === filters.build);
  }
  if (filters.status !== undefined) {
    list = list.filter((b) => b.status === filters.status);
  }
  if (filters.coverage !== undefined) {
    list = list.filter((b) => b.verificationCoverage === filters.coverage);
  }

  const sorted = sortBaselines(list);
  const totalCount = sorted.length;
  const offset = filters.offset ?? 0;
  const limit = filters.limit ?? 50;

  const paginated = sorted.slice(offset, offset + limit);

  return {
    schemaVersion: REVIEW_API_SCHEMA_VERSION,
    totalCount,
    returnedCount: paginated.length,
    offset,
    limit,
    baselines: paginated,
  };
}

/**
 * GET /api/baselines/:baselineId
 */
export function queryBaselineDetail(data: ReviewApiData, baselineId: string): ApiBaselineDetailResponse {
  const trimmed = baselineId.trim();
  const baseline = data.baselineMap.get(trimmed);
  if (!baseline) {
    throw baselineNotFoundError(baselineId);
  }

  const rules = [...new Set((baseline.knownSignals ?? []).map((s) => s.ruleId))].sort();
  const origin = baseline.identity?.targetOrigin ? safeTargetOrigin(baseline.identity.targetOrigin).origin : null;

  return {
    schemaVersion: REVIEW_API_SCHEMA_VERSION,
    baselineId: baseline.baselineId,
    name: baseline.name,
    status: baseline.status,
    createdAt: baseline.createdAt,
    targetOrigin: origin,
    journeyHash: baseline.identity.journeyHash,
    journeyType: baseline.identity.journeyType,
    applicationBuildId: baseline.identity.applicationBuildId,
    environmentFingerprint: baseline.identity.environmentFingerprint,
    verification: {
      complete: baseline.verification?.complete ?? false,
      coverage: baseline.verification?.coverage ?? 'unavailable',
      unverifiedAssertions: baseline.verification?.unverifiedAssertions ?? 0,
    },
    lineage: {
      parentBaselineId: baseline.lineage?.parentBaselineId ?? null,
      rootBaselineId: baseline.lineage?.rootBaselineId ?? baseline.baselineId,
      depth: baseline.lineage?.depth ?? 0,
      ancestors: baseline.lineage?.ancestors ? [...baseline.lineage.ancestors] : [],
      truncated: baseline.lineage?.truncated ?? false,
    },
    signalsSummary: {
      totalKnownSignals: baseline.knownSignals?.length ?? 0,
      acceptedCount: baseline.knownSignals?.filter((s) => s.accepted)?.length ?? 0,
      rules,
    },
    rationale: baseline.rationale ?? '',
    interpretation: {
      confirmedBug: false,
      automaticSeverity: false,
      note: 'Baselines describe verified or accepted states; they do not confirm bugs.',
    },
  };
}

/**
 * GET /api/runs/current
 */
export function queryCurrentRunContext(data: ReviewApiData): ApiRunContextResponse {
  const ex = data.execution;
  const steps = ex?.steps ?? [];
  const origin = ex?.target?.url ? safeTargetOrigin(ex.target.url).origin : null;

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let blocked = 0;

  for (const s of steps) {
    if (s.status === 'passed') passed++;
    else if (s.status === 'failed') failed++;
    else if (s.status === 'skipped') skipped++;
    else if (s.status === 'blocked') blocked++;
  }

  return {
    schemaVersion: REVIEW_API_SCHEMA_VERSION,
    status: ex?.status ?? 'unknown',
    targetUrlOrigin: origin,
    stepCounts: {
      total: steps.length,
      passed,
      failed,
      skipped,
      blocked,
    },
    verification: ex?.verification
      ? {
          complete: ex.verification.complete,
          coverage: ex.verification.coverage,
          unverifiedAssertions: ex.verification.unverifiedAssertions,
        }
      : null,
    anomalyCount: data.anomalies?.anomalies?.length ?? 0,
    reproductionSummary: null,
    provenance: {
      targetOrigin: origin,
      journeyHash: data.journey ? data.candidateReport.comparison?.journeyHash ?? null : null,
      applicationBuildId: ex?.environment?.application?.buildId ?? null,
      environmentFingerprint: ex?.environment?.fingerprint ?? null,
    },
  };
}

/**
 * GET /api/runs/reproduction
 */
export function queryReproductionRunContext(data: ReviewApiData): ApiRunContextResponse {
  const repro = data.reproduction;
  const results = repro?.results ?? [];
  const origin = data.candidateReport.comparison?.targetOrigin
    ? safeTargetOrigin(data.candidateReport.comparison.targetOrigin).origin
    : data.execution?.target?.url
      ? safeTargetOrigin(data.execution.target.url).origin
      : null;

  let reproduced = 0;
  let notReproduced = 0;
  let inconclusive = 0;
  let blocked = 0;

  for (const r of results) {
    if (r.classification === 'reproduced') reproduced++;
    else if (r.classification === 'not-reproduced') notReproduced++;
    else if (r.classification === 'inconclusive') inconclusive++;
    else if (r.classification === 'blocked') blocked++;
  }

  const firstRun = repro?.runs?.[0];
  const appBuildId =
    firstRun?.environment?.applicationBuildId ?? data.execution?.environment?.application?.buildId ?? null;
  const envFingerprint =
    firstRun?.environment?.fingerprint ?? data.candidateReport.comparison?.environmentFingerprint ?? null;

  return {
    schemaVersion: REVIEW_API_SCHEMA_VERSION,
    status: results.length > 0 ? 'completed' : 'unknown',
    targetUrlOrigin: origin,
    stepCounts: {
      total: results.length,
      passed: reproduced,
      failed: 0,
      skipped: 0,
      blocked,
    },
    verification: null,
    anomalyCount: data.anomalies?.anomalies?.length ?? 0,
    reproductionSummary: {
      totalAttempted: results.length,
      reproduced,
      notReproduced,
      inconclusive,
      blocked,
    },
    provenance: {
      targetOrigin: origin,
      journeyHash: data.candidateReport.comparison?.journeyHash ?? null,
      applicationBuildId: appBuildId,
      environmentFingerprint: envFingerprint,
    },
  };
}
