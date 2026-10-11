/**
 * Review API contract types (Build 9.1).
 *
 * Safe, read-only data models for exposing CrashLab candidate review,
 * baseline, and historical review state over HTTP.
 *
 * Core Guarantees:
 *  - Read-only: no mutations, no browser actions, no report writes.
 *  - Strict separation: observations vs automatic classifications vs human review state.
 *  - Non-negotiable invariant: `confirmedBug: false` and `confirmed: false`.
 *  - No raw secrets, absolute paths, or credentials in responses.
 */

import type { CandidateClassification, ReviewComparison } from '../review/types.js';
import type { ReviewStateStatus } from '../review/reviewStateTypes.js';
import type { BaselineStatus } from '../baseline/types.js';

export const REVIEW_API_SCHEMA_VERSION = '1.0';

/** Standard structured API error response format. */
export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

/** Health endpoint response. */
export interface ApiHealthResponse {
  ok: true;
  service: 'crashlab-review-api';
  readOnly: true;
  schemaVersion: string;
}

/** High-level summary endpoint response. */
export interface ApiSummaryResponse {
  schemaVersion: string;
  totalCandidates: number;
  byClassification: Record<string, number>;
  byReviewStatus: Record<string, number>;
  requiringInvestigation: number;
  reproducedCount: number;
  unknownCount: number;
  withLimitationsCount: number;
  baseline: {
    selectedBaselineId: string | null;
    selectionMode: string;
    parentBaselineId: string | null;
    comparisonClassification: string;
    limitations: string[];
  } | null;
  reviewState: {
    candidateCount: number;
    updatedAt: string | null;
  };
  provenance: {
    targetOrigin: string | null;
    journeyHash: string | null;
    applicationBuildId: string | null;
    environmentFingerprint: string | null;
  };
  interpretation: {
    confirmedBug: false;
    automaticSeverity: false;
    note: string;
  };
}

/** Candidate entry in candidate listing. */
export interface ApiCandidateListItem {
  candidateId: string;
  id: string;
  ruleId: string;
  kind: string;
  classification: CandidateClassification;
  reviewStatus: ReviewStateStatus | 'unreviewed';
  reproduced: boolean;
  baselinePresent: boolean;
  currentPresent: boolean;
  environmentComparison: ReviewComparison;
  requiresInvestigation: boolean;
  reproductionClassification: string | null;
  stepOrder: number | null;
  evidence: {
    currentAnomalyIds: string[];
    reproductionResultIds: string[];
    baselineSignalKeys: string[];
    relatedBaselineSignalKey: string | null;
  };
  message: string;
  knownLimitations: string[];
  confirmed: false;
}

/** Filter options for querying candidates. */
export interface CandidateQueryFilters {
  classification?: CandidateClassification;
  reviewStatus?: ReviewStateStatus | 'unreviewed';
  ruleId?: string;
  kind?: string;
  reproduced?: boolean;
  environment?: ReviewComparison;
  requiresInvestigation?: boolean;
  baselinePresent?: boolean;
  currentPresent?: boolean;
  limit?: number;
  offset?: number;
}

/** Paginated list response of candidates. */
export interface ApiCandidatesListResponse {
  schemaVersion: string;
  totalCount: number;
  returnedCount: number;
  offset: number;
  limit: number;
  candidates: ApiCandidateListItem[];
}

/** Detailed candidate response. */
export interface ApiCandidateDetailResponse {
  schemaVersion: string;
  candidateId: string;
  id: string;
  ruleId: string;
  kind: string;
  classification: CandidateClassification;
  reviewStatus: ReviewStateStatus | 'unreviewed';
  reproduced: boolean;
  baselinePresent: boolean;
  currentPresent: boolean;
  environmentComparison: ReviewComparison;
  requiresInvestigation: boolean;
  reproductionClassification: string | null;
  stepOrder: number | null;
  evidence: {
    currentAnomalyIds: string[];
    reproductionResultIds: string[];
    baselineSignalKeys: string[];
    relatedBaselineSignalKey: string | null;
  };
  message: string;
  knownLimitations: string[];
  humanReviewState: {
    currentStatus: ReviewStateStatus | 'unreviewed';
    revision: number;
    firstSeenAt: string | null;
    lastUpdatedAt: string | null;
    reviewer: string | null;
    latestNote: string | null;
    duplicateOf: string | null;
    eventCount: number;
  };
  provenance: {
    targetOrigin: string | null;
    journeyHash: string | null;
    applicationBuildId: string | null;
  };
  interpretation: {
    confirmedBug: false;
    automaticSeverity: false;
    note: string;
  };
  confirmed: false;
}

/** One historical review event item. */
export interface ApiReviewHistoryEvent {
  eventId: string;
  revision: number;
  previousRevision: number;
  previousStatus: ReviewStateStatus | null;
  newStatus: ReviewStateStatus;
  reviewer: string | null;
  note: string | null;
  duplicateOf: string | null;
  reason: string | null;
  timestamp: string;
  automaticClassification: string;
  confirmed: false;
}

/** Review history response for a candidate. */
export interface ApiCandidateHistoryResponse {
  schemaVersion: string;
  candidateId: string;
  currentStatus: ReviewStateStatus | 'unreviewed';
  unreviewed: boolean;
  eventCount: number;
  events: ApiReviewHistoryEvent[];
  confirmed: false;
}

/** Baseline summary item in list. */
export interface ApiBaselineListItem {
  baselineId: string;
  name: string;
  targetOrigin: string | null;
  journeyHash: string;
  applicationBuildId: string | null;
  status: BaselineStatus;
  verificationCoverage: string;
  parentBaselineId: string | null;
  lineageDepth: number;
  createdAt: string;
  knownSignalCount: number;
}

/** Filter options for querying baselines. */
export interface BaselineQueryFilters {
  origin?: string;
  journey?: string;
  build?: string;
  status?: BaselineStatus;
  coverage?: string;
  limit?: number;
  offset?: number;
}

/** List response of baselines. */
export interface ApiBaselinesListResponse {
  schemaVersion: string;
  totalCount: number;
  returnedCount: number;
  offset: number;
  limit: number;
  baselines: ApiBaselineListItem[];
}

/** Detailed baseline response. */
export interface ApiBaselineDetailResponse {
  schemaVersion: string;
  baselineId: string;
  name: string;
  status: BaselineStatus;
  createdAt: string;
  targetOrigin: string | null;
  journeyHash: string;
  journeyType: string;
  applicationBuildId: string | null;
  environmentFingerprint: string | null;
  verification: {
    complete: boolean;
    coverage: string;
    unverifiedAssertions: number;
  };
  lineage: {
    parentBaselineId: string | null;
    rootBaselineId: string;
    depth: number;
    ancestors: string[];
    truncated: boolean;
  };
  signalsSummary: {
    totalKnownSignals: number;
    acceptedCount: number;
    rules: string[];
  };
  rationale: string;
  interpretation: {
    confirmedBug: false;
    automaticSeverity: false;
    note: string;
  };
}

/** Run execution context summary response. */
export interface ApiRunContextResponse {
  schemaVersion: string;
  status: string;
  targetUrlOrigin: string | null;
  stepCounts: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    blocked: number;
  };
  verification: {
    complete: boolean;
    coverage: string;
    unverifiedAssertions: number;
  } | null;
  anomalyCount: number;
  reproductionSummary: {
    totalAttempted: number;
    reproduced: number;
    notReproduced: number;
    inconclusive: number;
    blocked: number;
  } | null;
  provenance: {
    targetOrigin: string | null;
    journeyHash: string | null;
    applicationBuildId: string | null;
    environmentFingerprint: string | null;
  };
}

/** Configuration paths for backing artifacts. */
export interface ReviewApiPaths {
  candidatesPath: string;
  reviewStateDir: string;
  baselinesDir: string;
  journeyPath?: string;
  executionPath?: string;
  anomaliesPath?: string;
  reproductionPath?: string;
}

/** Server startup options. */
export interface ReviewApiServerOptions {
  host?: string;
  port?: number;
  paths: ReviewApiPaths;
}
