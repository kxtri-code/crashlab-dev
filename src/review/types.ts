/**
 * Candidate-defect review contract.
 *
 * Build 6 answers "is this new relative to a known-good baseline?" and stops
 * there. It does not decide whether anything is a bug, assign severity, or
 * suggest a fix.
 *
 * The vocabulary is deliberately blunt about that. `novel` means *not present in
 * the baseline*, not *defective*. A novel signal is a lead for a human; it may
 * be entirely expected behaviour the baseline simply predates.
 */

import type { BaselineLineage } from '../baseline/types.js';

/** Candidate review schema version. */
export const REVIEW_SCHEMA_VERSION = '1.0';

/**
 * How a current run relates to the baseline as a whole.
 *
 * - `same-environment`     - comparable, environment fingerprint matches
 * - `different-environment` - comparable target and journey, different environment
 * - `unknown-environment`  - required provenance is missing
 * - `different-build`      - application build ids differ
 * - `incompatible-journey` - journey hash or type differs; sets are not compared
 * - `no-baseline`          - nothing to compare against
 */
export type ReviewComparison =
  | 'same-environment'
  | 'different-environment'
  | 'unknown-environment'
  | 'different-build'
  | 'incompatible-journey'
  | 'no-baseline';

/** What the comparison concluded about one signal. */
export type CandidateClassification =
  /** Reproduced, and absent from a compatible baseline. */
  | 'novel'
  /** Build 7: present in an ancestor baseline, absent in an intermediate baseline, and reappeared now. */
  | 'reintroduced'
  /** Present in both. Already present in the known-good state. */
  | 'persistent'
  /** Present in the baseline, absent now, in a valid comparison. */
  | 'resolved'
  /** A related signal exists in both but a safe detail differs. */
  | 'changed'
  /** Reproduced, but the environment differs from the baseline. */
  | 'cross-environment'
  /** Application build ids differ. */
  | 'different-build'
  /** No baseline, unknown environment, incompatible journey, or not reproduced. */
  | 'unknown';

/** Where a candidate sits in human review. */
export type ReviewStatus = 'needs-review' | 'known-existing' | 'not-present' | 'inconclusive';

/** Evidence references for one candidate. Never inlined raw evidence. */
export interface CandidateEvidence {
  currentAnomalyIds: string[];
  reproductionResultIds: string[];
  baselineSignalKeys: string[];
  /** The baseline signal this one was found "changed" from, when applicable. */
  relatedBaselineSignalKey: string | null;
}

/** One reviewed signal. */
export interface Candidate {
  /** Deterministic: `candidate-001`, `candidate-002`, ... */
  id: string;
  /** Hashed stable key, so the report stays readable and redaction-safe. */
  signalKeyHash: string;
  ruleId: string;
  kind: string;
  classification: CandidateClassification;
  reviewStatus: ReviewStatus;
  /** Always false. Build 6 confirms nothing. */
  confirmed: false;
  /** True only when Build 5 classified the signal as `reproduced`. */
  reproduced: boolean;
  baselinePresent: boolean;
  currentPresent: boolean;
  environmentComparison: ReviewComparison;
  evidence: CandidateEvidence;
  /** Factual, non-claiming wording. */
  message: string;
  requiresInvestigation: boolean;
  /** Build 5's reproduction classification, for traceability. */
  reproductionClassification: string | null;
  /** Ordering hint: the step the signal belongs to, when known. */
  stepOrder: number | null;
}

/** Counts per classification. */
export interface CandidateSummary {
  totalSignals: number;
  novel: number;
  reintroduced: number;
  persistent: number;
  resolved: number;
  changed: number;
  unknown: number;
  crossEnvironment: number;
  differentBuild: number;
  /** Reproduced signals, which are the only ones that can be candidates. */
  reproducedSignals: number;
}

/** How a baseline was selected for candidate review (Build 7). */
export type CandidateSelectionMode = 'explicit' | 'latest-compatible' | 'none';

/** Candidate baseline evaluated during baseline selection (Build 7). */
export interface CandidateBaselineDecision {
  baselineId: string;
  report: string;
  compatible: boolean;
  reason: string | null;
  createdAt?: string;
}

/** History/lineage entry in the review report (Build 7). */
export interface BaselineHistoryEntry {
  baselineId: string;
  name?: string;
  targetOrigin: string | null;
  journeyHash: string;
  applicationBuildId: string | null;
  status: string;
  coverage: string;
  createdAt: string;
  parentBaselineId: string | null;
  relationship: 'selected' | 'ancestor' | 'incompatible';
}

/**
 * How far the baseline's own creation run was verified.
 *
 * A `known-good-partial` baseline reached only its executed steps, so a
 * comparison against it cannot support a full-plan claim. Recorded so a reader
 * knows the limit of what "novel" means here.
 */
export interface BaselineVerificationSummary {
  status: 'complete' | 'partial' | 'unavailable';
  coverage: 'full-plan' | 'executed-steps-only' | 'partial-plan' | 'operator-declared' | 'unavailable';
  unverifiedAssertions: number;
}

/** The report written to `reports/candidates.json`. */
export interface CandidateReport {
  schemaVersion: string;
  baseline: { baselineId: string; report: string } | null;
  current: {
    executionReport: string;
    anomalyReport: string;
    reproductionReport: string | null;
    journeyReport: string;
  };
  comparison: {
    classification: ReviewComparison;
    targetOrigin: string | null;
    journeyHash: string | null;
    environmentFingerprint: string | null;
    /** Named differences, when the fingerprints differ. */
    differences: string[];
    /** Why comparison was impossible, when unknown. */
    reason: string | null;
  };
  /**
   * How far the baseline was verified. Null when no baseline was supplied.
   */
  baselineVerification: BaselineVerificationSummary | null;
  /**
   * Stated limits on what this comparison can claim. A partial baseline makes
   * every verdict here narrower, and saying so is the point.
   */
  comparisonLimitations: string[];
  summary: CandidateSummary;
  candidates: Candidate[];
  interpretation: {
    confirmedBug: false;
    automaticSeverity: false;
    candidatesRequireReview: true;
    note: string;
  };
  /** Build 7: baseline selection mode. */
  selectionMode?: CandidateSelectionMode;
  /** Build 7: selected baseline ID. */
  selectedBaselineId?: string | null;
  /** Build 7: parent baseline ID of the selected baseline. */
  parentBaselineId?: string | null;
  /** Build 7: lineage metadata of the selected baseline. */
  lineage?: BaselineLineage | null;
  /** Build 7: candidate baselines evaluated during selection. */
  candidatesConsidered?: CandidateBaselineDecision[];
  /** Build 7: history representation of baseline lineage. */
  history?: BaselineHistoryEntry[];
}

/** Default candidate report path. */
export const DEFAULT_CANDIDATE_OUTPUT_PATH = 'reports/candidates.json';
