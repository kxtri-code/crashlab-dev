/**
 * The Controlled Reproducer contract.
 *
 * Build 5 answers one question: **did this observed signal occur again under
 * controlled repeat execution?**
 *
 * It deliberately does not answer "is this a bug". A signal that recurs is
 * evidence of *reproducibility*, which makes it a candidate for investigation.
 * Deciding whether a reproducible signal is a defect is a human or a later
 * investigative step, so every result here carries `confirmed: false` and the
 * report carries `interpretation.confirmedBug: false`.
 *
 * The distinction that matters most: **reproduced is not the same as broken.**
 * A page that reliably returns 500 on a health-check probe reproduces perfectly
 * and is not a defect at all.
 */

import type { ExecutionReport } from '../executor/types.js';
import type { JourneyPlan } from '../journey/types.js';
import type { Anomaly } from '../anomaly/types.js';
import type { AnomalyReport } from '../anomaly/report.js';

/** Reproduction report schema version. */
export const REPRODUCTION_SCHEMA_VERSION = '1.0';

/** Anomaly report schema versions the reproducer understands. */
export const SUPPORTED_ANOMALY_SCHEMA_VERSIONS = ['1.0'] as const;

/** Journey plan schema versions the reproducer understands. */
export const SUPPORTED_REPRODUCER_JOURNEY_SCHEMA_VERSIONS = ['1.0'] as const;

/** Default number of controlled attempts. */
export const DEFAULT_ATTEMPTS = 3;

/** Attempts must be at least this many. */
export const MIN_ATTEMPTS = 1;

/** Attempts may never exceed this. Reproduction is bounded on purpose. */
export const MAX_ATTEMPTS = 5;

/**
 * Attempts needed before a signal counts as reproduced.
 *
 * One hit out of three is a coincidence far more often than a fault, so a
 * single occurrence is `inconclusive` rather than reproduced.
 */
export const REPRODUCTION_THRESHOLD = 2;

/**
 * What became of one original signal.
 *
 * - `reproduced`     - seen in at least `REPRODUCTION_THRESHOLD` completed attempts
 * - `not-reproduced` - absent from every completed attempt
 * - `inconclusive`   - the attempts cannot settle it (mixed, interrupted, no stable key)
 * - `blocked`        - safety policy or missing input prevented the rerun
 * - `ineligible`     - excluded by policy before any attempt was made
 */
export type ReproductionClassification = 'reproduced' | 'not-reproduced' | 'inconclusive' | 'blocked' | 'ineligible';

/** Why a signal was excluded before any attempt ran. */
export interface IneligibilityReason {
  code: 'rule-excluded' | 'skipped-step' | 'blocked-step' | 'no-evidence' | 'no-stable-key';
  detail: string;
}

/** How a single controlled attempt went. */
export type AttemptStatus = 'completed' | 'blocked' | 'failed';

/** One controlled rerun of the journey. */
export interface ReproductionRun {
  attempt: number;
  /** Stable directory name, e.g. `attempt-001`. Never a random id. */
  name: string;
  executionReport: string;
  anomalyReport: string;
  status: AttemptStatus;
  /** Why the attempt was blocked or failed, when it was. */
  detail: string | null;
  /** The execution report, in memory, for matching. Not serialized into the report. */
  execution: ExecutionReport;
  /** The anomaly report for this attempt, in memory, for matching. */
  anomalies: AnomalyReport;
}

/** Evidence linking a result back to a specific attempt. */
export interface ReproductionEvidence {
  attempt: number;
  executionReport: string;
  anomalyReport: string;
  /** The anomaly id within that attempt's own report. */
  anomalyId: string | null;
}

/** The verdict for one original signal. */
export interface ReproductionResult {
  /** Deterministic id: `reproduction-001`, ... */
  id: string;
  /** The original anomaly this concerns. */
  anomalyId: string;
  ruleId: string;
  classification: ReproductionClassification;
  /** Always false. Build 5 confirms nothing. */
  confirmed: false;
  /** How many completed attempts contained a matching signal. */
  matchingAttempts: number;
  completedAttempts: number;
  /** How many attempts ran but could not be compared. */
  inconclusiveAttempts: number;
  /**
   * A count, never a probability. `2/3` means two of three attempts matched;
   * it says nothing about likelihood.
   */
  reproductionRatio: string;
  /** The stable key used for matching, so a result can be audited. */
  matchingKey: string | null;
  evidence: ReproductionEvidence[];
  /** Deterministic, factual wording. No claim of certainty, no root cause. */
  reason: string;
  /** Why it was skipped before any attempt, when applicable. */
  ineligibleBecause: IneligibilityReason | null;
  /** True for a reproducible signal, which is a candidate, not a bug. */
  requiresInvestigation: boolean;
}

/** Counts per classification. */
export interface ReproductionSummary {
  totalSignals: number;
  eligibleSignals: number;
  reproduced: number;
  notReproduced: number;
  inconclusive: number;
  blocked: number;
  ineligible: number;
  /** Signals worth a human's attention. Never "bugs". */
  candidatesRequiringInvestigation: number;
}

/** What the reproducer guaranteed during the run. */
export interface SafetySummary {
  authorizedConfirmationRequired: true;
  safeTestMode: true;
  livePaymentAllowed: false;
  sensitiveValuesRedacted: true;
  /** How many attempts the payment or another safety guard refused. */
  attemptsBlockedBySafety: number;
}

/** How the run was performed. */
export interface ReproducerMeta {
  mode: 'controlled-deterministic';
  version: string;
  /**
   * Always false. The attempts here are *declared reproduction attempts* under
   * an explicit budget, not hidden retry logic: every attempt is written to its
   * own report and counted in the output.
   */
  automaticRetries: false;
  attemptsRequested: number;
  attemptsCompleted: number;
  attemptsBlocked: number;
  attemptsFailed: number;
}

/** The standing limits of this report. */
export interface ReproductionInterpretation {
  confirmedBug: false;
  /** A recurring signal is a lead, not a verdict. */
  reproducedSignalsAreCandidatesOnly: true;
  note: string;
}

/** The report written to `reports/reproduction.json`. */
export interface ReproductionReport {
  schemaVersion: string;
  journeyReport: string;
  anomalyReport: string;
  executionReport: string | null;
  goal: string;
  summary: ReproductionSummary;
  runs: Array<Omit<ReproductionRun, 'execution' | 'anomalies'>>;
  results: ReproductionResult[];
  safety: SafetySummary;
  reproducer: ReproducerMeta;
  interpretation: ReproductionInterpretation;
}

/** Everything the reproducer needs, already validated. */
export interface ReproductionInput {
  anomalies: AnomalyReport;
  journey: JourneyPlan;
  /** Resolved test data, used unchanged for every attempt. */
  testData?: Record<string, string>;
  /** Explicitly requested attempts, already bounds-checked. */
  attempts: number;
  /**
   * Whether the operator confirmed authorization for the target.
   *
   * Required. A false value refuses the run before any browser opens, and it
   * is never persisted into the report - the report records that confirmation
   * was *required*, not that it was granted.
   */
  authorized: boolean;
  /** Paths echoed into the report, exactly as supplied. */
  anomalyPath: string;
  journeyPath: string;
  executionPath: string | null;
  /** Allow signals excluded by default. */
  includePossiblyExpected: boolean;
  /** Per-step executor timeout. */
  timeoutMs?: number;
  /** Run the browser with a window. */
  headed?: boolean;
  /** Directory the rerun artifacts are written under. */
  outputDir: string;
}

/** A validation failure that must stop before any browser opens. */
export class ReproductionInputError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.name = 'ReproductionInputError';
    this.path = path;
  }
}

export type { Anomaly, AnomalyReport, ExecutionReport, JourneyPlan };
