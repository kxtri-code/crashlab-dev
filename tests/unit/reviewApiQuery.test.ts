/**
 * Pure Query Layer Unit Tests for Review API (Build 9.1).
 *
 * Validates in-memory queries, deterministic sorting, filtering,
 * pagination, redaction, and trust invariants without launching an HTTP server.
 */

import { describe, it, expect } from 'vitest';
import type { CandidateReport, Candidate } from '../../src/review/types.js';
import type { ReviewStateDocument, ReviewStateEvent } from '../../src/review/reviewStateTypes.js';
import type { Baseline, BaselineRegistryEntry } from '../../src/baseline/types.js';
import type { ReviewApiData } from '../../src/reviewApi/queries.js';
import {
  querySummary,
  queryCandidates,
  queryCandidateDetail,
  queryCandidateHistory,
  queryBaselines,
  queryBaselineDetail,
  queryCurrentRunContext,
  queryReproductionRunContext,
  sortCandidates,
  sortBaselines,
  sortReviewEvents,
  findCandidate,
} from '../../src/reviewApi/queries.js';
import {
  validateCandidateFilters,
  validateBaselineFilters,
  validateCandidateIdRoute,
  validateBaselineIdRoute,
  validatePagination,
} from '../../src/reviewApi/validator.js';
import { ApiError } from '../../src/reviewApi/errors.js';

function createFixtureData(): ReviewApiData {
  const candidate1: Candidate = {
    id: 'candidate-001',
    candidateId: 'cand-0000000000000001',
    signalKeyHash: 'hash-001',
    ruleId: 'http-status-404',
    kind: 'http',
    classification: 'novel',
    reviewStatus: 'needs-review',
    confirmed: false,
    reproduced: true,
    baselinePresent: false,
    currentPresent: true,
    environmentComparison: 'same-environment',
    evidence: {
      currentAnomalyIds: ['anom-001'],
      reproductionResultIds: ['repro-001'],
      baselineSignalKeys: [],
      relatedBaselineSignalKey: null,
    },
    message: 'Novel HTTP 404 signal detected.',
    requiresInvestigation: true,
    reproductionClassification: 'reproduced',
    stepOrder: 2,
  };

  const candidate2: Candidate = {
    id: 'candidate-002',
    candidateId: 'cand-0000000000000002',
    signalKeyHash: 'hash-002',
    ruleId: 'console-error',
    kind: 'console',
    classification: 'reintroduced',
    reviewStatus: 'needs-review',
    confirmed: false,
    reproduced: true,
    baselinePresent: false,
    currentPresent: true,
    environmentComparison: 'same-environment',
    evidence: {
      currentAnomalyIds: ['anom-002'],
      reproductionResultIds: ['repro-002'],
      baselineSignalKeys: ['sig-002'],
      relatedBaselineSignalKey: null,
    },
    message: 'Reintroduced console error.',
    requiresInvestigation: true,
    reproductionClassification: 'reproduced',
    stepOrder: 1,
  };

  const candidate3: Candidate = {
    id: 'candidate-003',
    candidateId: 'cand-0000000000000003',
    signalKeyHash: 'hash-003',
    ruleId: 'timeout',
    kind: 'timeout',
    classification: 'unknown',
    reviewStatus: 'inconclusive',
    confirmed: false,
    reproduced: false,
    baselinePresent: false,
    currentPresent: true,
    environmentComparison: 'unknown-environment',
    evidence: {
      currentAnomalyIds: ['anom-003'],
      reproductionResultIds: [],
      baselineSignalKeys: [],
      relatedBaselineSignalKey: null,
    },
    message: 'Timeout signal with unknown classification.',
    requiresInvestigation: false,
    reproductionClassification: null,
    stepOrder: 3,
  };

  const candidateReport: CandidateReport = {
    schemaVersion: '1.0',
    baseline: { baselineId: 'base-0000000000000001', report: 'reports/baselines/base-0000000000000001.json' },
    current: {
      executionReport: 'reports/execution.json',
      anomalyReport: 'reports/anomalies.json',
      reproductionReport: 'reports/reproduction.json',
      journeyReport: 'reports/journey.json',
    },
    comparison: {
      classification: 'same-environment',
      targetOrigin: 'https://example.test',
      journeyHash: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
      environmentFingerprint: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
      differences: [],
      reason: null,
    },
    baselineVerification: {
      status: 'complete',
      coverage: 'full-plan',
      unverifiedAssertions: 0,
    },
    comparisonLimitations: ['Tested against synthetic fixture.'],
    summary: {
      totalSignals: 3,
      novel: 1,
      reintroduced: 1,
      persistent: 0,
      resolved: 0,
      changed: 0,
      unknown: 1,
      crossEnvironment: 0,
      differentBuild: 0,
      reproducedSignals: 2,
    },
    candidates: [candidate1, candidate2, candidate3],
    interpretation: {
      confirmedBug: false,
      automaticSeverity: false,
      candidatesRequireReview: true,
      note: 'Novel signals require review.',
    },
    selectionMode: 'explicit',
    selectedBaselineId: 'base-0000000000000001',
    parentBaselineId: null,
  };

  const reviewEvents: ReviewStateEvent[] = [
    {
      schemaVersion: '1.0',
      eventId: 'evt-001',
      candidateId: 'cand-0000000000000001',
      previousStatus: null,
      newStatus: 'investigating',
      reviewer: 'alice',
      note: 'Investigating HTTP 404',
      duplicateOf: null,
      reason: null,
      timestamp: '2026-03-01T10:00:00.000Z',
      previousRevision: 0,
      revision: 1,
      sourceCandidate: null,
      automaticClassification: 'novel',
      confirmed: false,
    },
  ];

  const reviewStateDoc: ReviewStateDocument = {
    schemaVersion: '1.0',
    updatedAt: '2026-03-01T10:00:00.000Z',
    candidateCount: 1,
    candidates: {
      'cand-0000000000000001': {
        schemaVersion: '1.0',
        candidateId: 'cand-0000000000000001',
        currentStatus: 'investigating',
        firstSeenAt: '2026-03-01T10:00:00.000Z',
        lastUpdatedAt: '2026-03-01T10:00:00.000Z',
        reviewer: 'alice',
        latestNote: 'Investigating HTTP 404',
        duplicateOf: null,
        sourceCandidate: null,
        revision: 1,
        eventCount: 1,
        lastEventId: 'evt-001',
        eventIds: ['evt-001'],
        automaticClassification: 'novel',
        confirmed: false,
        disclaimer: 'Human review never confirms bugs.',
      },
    },
    interpretation: {
      confirmedBug: false,
      automaticSeverity: false,
      note: 'Review state never confirms bugs.',
    },
  };

  const baseline1: Baseline = {
    schemaVersion: '1.0',
    baselineId: 'base-0000000000000001',
    name: 'Initial Baseline',
    status: 'known-good',
    createdAt: '2026-02-01T00:00:00.000Z',
    confirmation: {
      explicit: true,
      confirmedBy: 'operator',
      acceptedSignalIds: [],
    },
    source: {
      executionReport: 'reports/execution.json',
      anomalyReport: 'reports/anomalies.json',
      journeyReport: 'reports/journey.json',
    },
    identity: {
      targetOrigin: 'https://example.test',
      journeyHash: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
      journeySchemaVersion: '1.0',
      journeyType: 'linear',
      environmentFingerprint: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
      environmentId: null,
      applicationBuildId: 'build-100',
      plannerVersion: '0.1.0',
      executorVersion: '0.1.0',
    },
    knownSignals: [],
    safety: {
      safeTestMode: true,
      livePaymentAllowed: false,
      executionHadFailures: false,
      executionIncomplete: false,
    },
    verification: {
      complete: true,
      coverage: 'full-plan',
      unverifiedAssertions: 0,
      operatorApproved: false,
    },
    rationale: 'Clean baseline run.',
    interpretation: {
      confirmedBug: false,
      automaticSeverity: false,
      note: 'Baselines do not confirm bugs.',
    },
    parentBaselineId: null,
    lineage: {
      parentBaselineId: null,
      rootBaselineId: 'base-0000000000000001',
      depth: 0,
      ancestors: [],
      truncated: false,
    },
  };

  const registryEntry: BaselineRegistryEntry = {
    baselineId: 'base-0000000000000001',
    name: 'Initial Baseline',
    report: 'reports/baselines/base-0000000000000001.json',
    createdAt: '2026-02-01T00:00:00.000Z',
    targetOrigin: 'https://example.test',
    environmentFingerprint: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
    journeyHash: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    status: 'known-good',
    verificationCoverage: 'full-plan',
    applicationBuildId: 'build-100',
  };

  const baselineMap = new Map<string, Baseline>();
  baselineMap.set(baseline1.baselineId, baseline1);

  return {
    candidateReport,
    reviewStateDoc,
    reviewEvents,
    baselines: [registryEntry],
    baselineMap,
    journey: null,
    execution: null,
    anomalies: null,
    reproduction: null,
  };
}

describe('Pure Review API Query Layer', () => {
  it('Summary: returns accurate counts, baseline summary, and trust invariants', () => {
    const data = createFixtureData();
    const summary = querySummary(data);

    expect(summary.schemaVersion).toBe('1.0');
    expect(summary.totalCandidates).toBe(3);
    expect(summary.byClassification).toEqual({
      novel: 1,
      reintroduced: 1,
      unknown: 1,
    });
    expect(summary.byReviewStatus).toEqual({
      investigating: 1,
      unreviewed: 2,
    });
    expect(summary.requiringInvestigation).toBe(2);
    expect(summary.reproducedCount).toBe(2);
    expect(summary.unknownCount).toBe(1);
    expect(summary.withLimitationsCount).toBe(3);
    expect(summary.interpretation.confirmedBug).toBe(false);
    expect(summary.interpretation.automaticSeverity).toBe(false);
  });

  it('Candidates list: sorts deterministically by classification priority, review status, candidate ID', () => {
    const data = createFixtureData();
    const res = queryCandidates(data, {});

    expect(res.totalCount).toBe(3);
    expect(res.returnedCount).toBe(3);
    expect(res.offset).toBe(0);
    expect(res.limit).toBe(50);

    // Classification priority: novel (1) > reintroduced (2) > unknown (14)
    expect(res.candidates[0]!.candidateId).toBe('cand-0000000000000001');
    expect(res.candidates[0]!.classification).toBe('novel');
    expect(res.candidates[0]!.reviewStatus).toBe('investigating');
    expect(res.candidates[0]!.confirmed).toBe(false);

    expect(res.candidates[1]!.candidateId).toBe('cand-0000000000000002');
    expect(res.candidates[1]!.classification).toBe('reintroduced');
    expect(res.candidates[1]!.reviewStatus).toBe('unreviewed');
    expect(res.candidates[1]!.confirmed).toBe(false);

    expect(res.candidates[2]!.candidateId).toBe('cand-0000000000000003');
    expect(res.candidates[2]!.classification).toBe('unknown');
    expect(res.candidates[2]!.confirmed).toBe(false);
  });

  it('Candidates list: filters by classification', () => {
    const data = createFixtureData();
    const res = queryCandidates(data, { classification: 'novel' });
    expect(res.totalCount).toBe(1);
    expect(res.candidates[0]!.candidateId).toBe('cand-0000000000000001');
  });

  it('Candidates list: filters by reviewStatus', () => {
    const data = createFixtureData();
    const res = queryCandidates(data, { reviewStatus: 'investigating' });
    expect(res.totalCount).toBe(1);
    expect(res.candidates[0]!.candidateId).toBe('cand-0000000000000001');

    const unreviewedRes = queryCandidates(data, { reviewStatus: 'unreviewed' });
    expect(unreviewedRes.totalCount).toBe(2);
  });

  it('Candidates list: filters by reproduced boolean flag', () => {
    const data = createFixtureData();
    const reproRes = queryCandidates(data, { reproduced: true });
    expect(reproRes.totalCount).toBe(2);

    const nonReproRes = queryCandidates(data, { reproduced: false });
    expect(nonReproRes.totalCount).toBe(1);
    expect(nonReproRes.candidates[0]!.candidateId).toBe('cand-0000000000000003');
  });

  it('Candidates list: supports bounded pagination', () => {
    const data = createFixtureData();
    const page1 = queryCandidates(data, { limit: 2, offset: 0 });
    expect(page1.totalCount).toBe(3);
    expect(page1.returnedCount).toBe(2);
    expect(page1.candidates.length).toBe(2);
    expect(page1.offset).toBe(0);

    const page2 = queryCandidates(data, { limit: 2, offset: 2 });
    expect(page2.totalCount).toBe(3);
    expect(page2.returnedCount).toBe(1);
    expect(page2.candidates.length).toBe(1);
    expect(page2.offset).toBe(2);
  });

  it('Candidate detail: resolves canonical candidate ID', () => {
    const data = createFixtureData();
    const detail = queryCandidateDetail(data, 'cand-0000000000000001');
    expect(detail.candidateId).toBe('cand-0000000000000001');
    expect(detail.id).toBe('candidate-001');
    expect(detail.classification).toBe('novel');
    expect(detail.reviewStatus).toBe('investigating');
    expect(detail.humanReviewState.reviewer).toBe('alice');
    expect(detail.humanReviewState.latestNote).toBe('Investigating HTTP 404');
    expect(detail.confirmed).toBe(false);
    expect(detail.interpretation.confirmedBug).toBe(false);
  });

  it('Candidate detail: resolves positional alias candidate-002', () => {
    const data = createFixtureData();
    const detail = queryCandidateDetail(data, 'candidate-002');
    expect(detail.candidateId).toBe('cand-0000000000000002');
    expect(detail.id).toBe('candidate-002');
    expect(detail.classification).toBe('reintroduced');
    expect(detail.reviewStatus).toBe('unreviewed');
    expect(detail.humanReviewState.eventCount).toBe(0);
  });

  it('Candidate detail: throws candidateNotFoundError when not found', () => {
    const data = createFixtureData();
    expect(() => queryCandidateDetail(data, 'cand-nonexistent')).toThrow(ApiError);
    try {
      queryCandidateDetail(data, 'cand-nonexistent');
    } catch (err) {
      const apiErr = err as ApiError;
      expect(apiErr.statusCode).toBe(404);
      expect(apiErr.code).toBe('candidate-not-found');
    }
  });

  it('Candidate history: returns event history for reviewed candidate', () => {
    const data = createFixtureData();
    const history = queryCandidateHistory(data, 'cand-0000000000000001');
    expect(history.candidateId).toBe('cand-0000000000000001');
    expect(history.unreviewed).toBe(false);
    expect(history.eventCount).toBe(1);
    expect(history.events[0]!.eventId).toBe('evt-001');
    expect(history.events[0]!.newStatus).toBe('investigating');
    expect(history.events[0]!.reviewer).toBe('alice');
    expect(history.confirmed).toBe(false);
  });

  it('Candidate history: returns empty history with unreviewed: true for candidate without events', () => {
    const data = createFixtureData();
    const history = queryCandidateHistory(data, 'cand-0000000000000002');
    expect(history.candidateId).toBe('cand-0000000000000002');
    expect(history.unreviewed).toBe(true);
    expect(history.eventCount).toBe(0);
    expect(history.events).toEqual([]);
    expect(history.confirmed).toBe(false);
  });

  it('Candidate history: throws 404 for unknown candidate', () => {
    const data = createFixtureData();
    expect(() => queryCandidateHistory(data, 'cand-9999999999999999')).toThrow(ApiError);
  });

  it('Baselines: lists baselines and supports filters', () => {
    const data = createFixtureData();
    const list = queryBaselines(data, {});
    expect(list.totalCount).toBe(1);
    expect(list.baselines[0]!.baselineId).toBe('base-0000000000000001');
    expect(list.baselines[0]!.status).toBe('known-good');

    const filtered = queryBaselines(data, { status: 'known-good' });
    expect(filtered.totalCount).toBe(1);

    const emptyFilter = queryBaselines(data, { status: 'known-good-partial' });
    expect(emptyFilter.totalCount).toBe(0);
  });

  it('Baseline detail: returns safe baseline projection and 404 on unknown', () => {
    const data = createFixtureData();
    const detail = queryBaselineDetail(data, 'base-0000000000000001');
    expect(detail.baselineId).toBe('base-0000000000000001');
    expect(detail.name).toBe('Initial Baseline');
    expect(detail.interpretation.confirmedBug).toBe(false);

    expect(() => queryBaselineDetail(data, 'base-nonexistent')).toThrow(ApiError);
  });

  it('Validator: rejects unknown query filters with 400 invalid-query', () => {
    const params = new URLSearchParams('classification=novel&unknownFilter=foo');
    expect(() => validateCandidateFilters(params)).toThrow(ApiError);
    try {
      validateCandidateFilters(params);
    } catch (err) {
      const apiErr = err as ApiError;
      expect(apiErr.statusCode).toBe(400);
      expect(apiErr.code).toBe('invalid-query');
    }
  });

  it('Validator: rejects invalid enum values with 400', () => {
    const invalidClass = new URLSearchParams('classification=bogus');
    expect(() => validateCandidateFilters(invalidClass)).toThrow(ApiError);

    const invalidStatus = new URLSearchParams('reviewStatus=bogus');
    expect(() => validateCandidateFilters(invalidStatus)).toThrow(ApiError);
  });

  it('Validator: rejects path traversal and control characters in candidate and baseline IDs', () => {
    expect(() => validateCandidateIdRoute('../../secret')).toThrow(ApiError);
    expect(() => validateCandidateIdRoute('cand\x00null')).toThrow(ApiError);
    expect(() => validateBaselineIdRoute('../../secret')).toThrow(ApiError);
    expect(() => validateBaselineIdRoute('base\x00null')).toThrow(ApiError);
  });

  it('Validator: rejects out-of-range pagination bounds', () => {
    expect(() => validatePagination('0', '0')).toThrow(ApiError);
    expect(() => validatePagination('101', '0')).toThrow(ApiError);
    expect(() => validatePagination('10', '-5')).toThrow(ApiError);
    expect(() => validatePagination('abc', '0')).toThrow(ApiError);
  });
});
