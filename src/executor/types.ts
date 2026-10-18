/**
 * The Journey Execution report contract.
 *
 * `execution.json` is a **separate artifact** from `journey.json`. The journey
 * plan is an immutable input; this report is the record of attempting it. Build
 * 3 never writes back into the plan.
 *
 * Scope boundary: this report records *what happened*. It does not classify
 * anomalies, confirm bugs, or reproduce failures. Those belong to Builds 4+,
 * and a `failed` status here means "the step did not succeed", not "the product
 * is broken".
 */

import type { JourneyAction, JourneyPlan, JourneyType } from '../journey/types.js';
import type { EnvironmentProvenance, ProvenanceInput } from '../provenance/types.js';
import type { NetworkEventProvenance } from '../scout/types.js';
import type { ExpectationsFile, ExpectationOutcome } from './expectations.js';

export type { NetworkEventProvenance };

/** Execution report schema version. */
export const EXECUTION_SCHEMA_VERSION = '1.0';

/** The only journey-plan schema version this executor accepts. */
export const SUPPORTED_JOURNEY_SCHEMA_VERSIONS = ['1.0'] as const;

/**
 * Per-step and overall outcome. Deliberately no "bug" terminology.
 *
 * `partial` and `aborted` are overall-only: they describe a run where some steps
 * ran and others did not. A single step is always one of the first four.
 */
/**
 * Overall execution outcome.
 *
 * `completed` and `passed` are deliberately distinct. `passed` means every
 * required executable action *and* every deterministic assertion was evaluated
 * and succeeded. `completed` means the plan finished processing, but at least
 * one expectation was left unverified - a natural-language assertion with no
 * machine-readable target.
 *
 * Completion is not success. A run that clicked everything it could and could
 * not evaluate its final prose assertion has `completed`, and its
 * `verification.status` is `partial`.
 */
export type ExecutionStatus =
  | 'passed'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'skipped'
  | 'partial'
  | 'aborted';

/**
 * How much of the plan the run actually evaluated.
 *
 * - `complete`            - every required action and deterministic assertion
 *                           was evaluated
 * - `partial`             - the run finished, but some assertions are
 *                           unverified
 * - `incomplete`          - the run was interrupted, blocked or failed before
 *                           sufficient execution
 * - `unavailable`         - a legacy report that predates this metadata
 */
export type VerificationStatus = 'complete' | 'partial' | 'incomplete' | 'unavailable';

/**
 * How far the verification reaches.
 *
 * - `full-plan`           - the whole plan was evaluated
 * - `executed-steps-only` - only steps with a deterministic target were
 *                           evaluated; the rest are unverified
 * - `partial-plan`        - some required steps did not run at all
 * - `operator-declared`   - all expectations passed, including operator-declared
 *                           ones; never `full-plan` because the verification
 *                           came from operator declaration, not Scout evidence
 * - `unavailable`         - no verification metadata
 */
export type VerificationCoverage = 'full-plan' | 'executed-steps-only' | 'partial-plan' | 'operator-declared' | 'unavailable';

/**
 * Top-level verification record.
 *
 * This exists so a reader can tell a fully verified run from one that merely
 * finished. It never claims `complete` while an unverified assertion remains:
 * a run that skipped its final prose expectation is `partial`, always.
 */
export interface ExecutionVerification {
  status: VerificationStatus;
  /** Convenience mirror of `status !== 'complete'`. */
  complete: boolean;
  executedSteps: number;
  passedSteps: number;
  failedSteps: number;
  blockedSteps: number;
  skippedSteps: number;
  /** How many skipped steps were unverified assertions rather than no-ops. */
  unverifiedAssertions: number;
  /** Ids of the unverified assertion steps, in order. */
  unverifiedStepIds: string[];
  coverage: VerificationCoverage;
}

/** Per-step verification note, for a step whose expectation could not be checked. */
export interface StepVerification {
  status: 'unverified';
  reason: string;
}

/** Why a step was skipped, when skipping is the honest outcome. */
export type SkipReason =
  | 'unsupported-prose-assertion'
  | 'no-target'
  | 'unsupported-action'
  | 'skipped-step'
  | 'stopped-after-failure';

/** Why a step could not proceed. */
export type BlockReason =
  | 'no-locator-provided'
  | 'locator-not-found'
  | 'locator-ambiguous'
  | 'locator-unsupported'
  | 'element-hidden'
  | 'element-disabled'
  | 'missing-test-data'
  | 'no-navigation-target'
  | 'unsupported-assertion'
  | 'external-origin-blocked'
  | 'payment-blocked'
  | 'unsafe-test-file'
  | 'action-failed'
  | 'timed-out';

/**
 * What an action handler returns.
 *
 * `skipped` is distinct from `blocked`: a step that had nothing to act on
 * because the planner found no target is a legitimate observation, not a
 * refusal, and must not stop the run.
 */
export interface ActionOutcome {
  status: 'passed' | 'failed' | 'blocked' | 'skipped';
  reason?: BlockReason;
  message?: string;
  observations?: StepObservations | null;
  /** The plan string that was actually used, when a target was resolved. */
  selectedLocator?: string | null;
  /** Extra detail recorded alongside the step, always redacted. */
  notes?: string[];
  skipReason?: SkipReason | null;
  verification?: StepVerification | null;
  assertion?: import('./structuredAssertionRunner.js').AssertionOutcome | null;
  postconditions?: import('./postconditionRunner.js').PostconditionOutcome[] | null;
}

/** What was observed about a resolved element. Never a verdict. */
export interface StepObservations {
  exists: boolean;
  visible: boolean;
  enabled: boolean;
  /** Element tag name, when resolvable. */
  tag: string | null;
  /** Number of elements a locator matched, before any uniqueness filter. */
  matchCount: number | null;
}

/** Evidence captured for a single step. */
export interface StepEvidence {
  screenshot: string | null;
  /** True when no screenshot was taken, and `screenshotOmittedReason` says why. */
  screenshotOmitted: boolean;
  screenshotOmittedReason: string | null;
  /** Console messages emitted during this step. */
  consoleEvents: EvidenceConsoleEvent[];
  /** Uncaught page errors during this step. */
  pageErrors: EvidencePageError[];
  /** Network exchanges during this step. */
  networkEvents: EvidenceNetworkEvent[];
  /** True when a native dialog opened during the step. */
  dialogObserved: boolean;
  /** True when the URL changed during the step. */
  pageChanged: boolean;
}

/** Console message, redacted and capped. */
export interface EvidenceConsoleEvent {
  type: string;
  text: string;
  url: string | null;
  line: number | null;
}

/** Uncaught page error, redacted and capped. */
export interface EvidencePageError {
  message: string;
  stack: string | null;
}

/** One network exchange, redacted. No headers, no bodies. */
export interface EvidenceNetworkEvent {
  method: string;
  url: string;
  path: string;
  status: number | null;
  resourceType: string | null;
  durationMs: number | null;
  thirdParty: boolean;
  failure: string | null;
  /**
   * Build 12G.2: Provenance identifying whether this exchange was harness navigation
   * versus target-triggered navigation.
   */
  provenance?: NetworkEventProvenance | null;
}

/** A single step's outcome. Overall-only statuses are excluded. */
export type StepStatus = 'passed' | 'failed' | 'blocked' | 'skipped';

/** The result of attempting one step. */
export interface StepExecutionResult {
  id: string;
  order: number;
  intent: string;
  action: JourneyAction;
  status: StepStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** The locator that was actually used, when one was resolved. */
  selectedLocator: string | null;
  targetElementIds: string[];
  urlBefore: string | null;
  urlAfter: string | null;
  observations: StepObservations | null;
  evidence: StepEvidence;
  /** Populated when status is `failed` or `blocked`. */
  error: StepError | null;
  /**
   * Why the step was skipped, when it was. A skipped step with no error is a
   * deliberate, non-failing outcome, not a suppressed failure.
   */
  skipReason: SkipReason | null;
  /**
   * Present when the step's expectation could not be evaluated. An unverified
   * assertion is neither passed nor failed: nobody checked it.
   */
  verification: StepVerification | null;
  /**
   * Build 6.2: the outcome of a structured assertion. Null when the step had
   * none, or when it was never evaluated. A `not-matched` result is a real
   * observation, never a defect verdict.
   */
  assertion: import('./structuredAssertionRunner.js').AssertionOutcome | null;
  /**
   * Build 6.3: the outcome of each postcondition this step declared. Null when
   * the step declared none, or when they were never evaluated.
   */
  postconditions: import('./postconditionRunner.js').PostconditionOutcome[] | null;
  /**
   * Build 6.5: the outcome of each operator-declared expectation bound to this
   * step. Null when none were declared or evaluated.
   */
  expectationResults?: ExpectationOutcome[] | null;
  /** Step description, echoed from the immutable plan. */
  description: string;
  /** Step confidence, echoed from the immutable plan. Not a pass/fail signal. */
  planConfidence: number;
}

/** A structured failure or block reason. */
export interface StepError {
  reason: BlockReason;
  message: string;
  /** All locator candidates that were attempted, in order. */
  attemptedLocators: string[];
  /** The key that was looked up in test data, for missing-data blocks. */
  missingDataKey: string | null;
}

/** Aggregated evidence for the whole run. */
export interface RawEvidence {
  consoleEvents: EvidenceConsoleEvent[];
  pageErrors: EvidencePageError[];
  networkEvents: EvidenceNetworkEvent[];
  screenshots: string[];
}

/** Confirmation of what the executor deliberately withheld. */
export interface RedactionSummary {
  sensitiveValuesRedacted: boolean;
  /** Number of step values replaced rather than recorded. */
  redactedValueCount: number;
  /** Keys whose values were supplied by the test-data file. */
  dataProvidedKeys: string[];
  /** True when the test-data file was loaded at all. */
  dataProvided: boolean;
  /**
   * True when at least one screenshot was withheld because sensitive data had
   * entered the page. A bitmap cannot be redacted, so CrashLab omits rather
   * than claiming a screenshot is safe.
   */
  screenshotsOmittedAfterSensitiveData: boolean;
}

/** How the run was performed. */
export interface ExecutorMeta {
  mode: 'deterministic';
  version: string;
  /** Always 0. Build 3 performs no retries and no reproduction. */
  retries: 0;
  /** True when a required step failed and execution stopped. */
  stoppedOnFailure: boolean;
  /** True when `--continue-on-failure` was in effect. */
  continueOnFailure: boolean;
  /** True when a payment-adjacent submit was permitted by safe test mode. */
  safeTestMode: boolean;
}

/** The report written to `reports/execution.json`. */
export interface ExecutionReport {
  schemaVersion: string;
  /** Schema version of the journey plan this execution consumed. */
  journeyPlanSchemaVersion: string;
  /** Path to the journey plan, echoed exactly as supplied. */
  journeyReport: string;
  goal: string;
  journeyType: JourneyType;
  target: { url: string; finalUrl: string | null; title: string };
  status: ExecutionStatus;
  /**
   * How much of the plan was actually verified. Null only for a report written
   * before this existed, which readers treat as `unavailable`.
   */
  verification: ExecutionVerification | null;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  stepCounts: {
    total: number;
    passed: number;
    failed: number;
    blocked: number;
    skipped: number;
  };
  steps: StepExecutionResult[];
  rawEvidence: RawEvidence;
  warnings: string[];
  blockedSteps: string[];
  redaction: RedactionSummary;
  executor: ExecutorMeta;
  /**
   * Build 5.1 provenance: where and how this run happened. Safe by
   * construction - a version, a boolean, a number, a null, or a caller-supplied
   * identifier that passed sanitization. Null only for a caller that opted out.
   */
  environment: EnvironmentProvenance | null;
  /**
   * Build 6.5: SHA-256 of the operator-declared expectations file, for
   * provenance and reproduction consistency. Null when no expectations file
   * was used.
   */
  expectationFileHash?: string | null;
}

/** Options controlling one execution run. */
export interface ExecutionOptions {
  /** The journey plan to attempt. Must be schema version 1.0. */
  plan: JourneyPlan;
  /** Path to the plan, echoed into the report. */
  planPath: string;
  /** Resolved test data, keyed by element id or semantic field name. */
  testData?: Record<string, string>;
  /** Per-step timeout in milliseconds. */
  timeoutMs?: number;
  /** Run with a visible browser window. */
  headed?: boolean;
  /** Continue past a required-step failure instead of stopping. */
  continueOnFailure?: boolean;
  /**
   * Permit a payment-adjacent submit. Off by default: a real charge must never
   * happen by accident, and Build 3 has no way to know a target is a sandbox.
   */
  safeTestMode?: boolean;
  /** Directory for screenshots, relative to the output path. */
  evidenceDir?: string;
  /** Capture screenshots at all. */
  screenshots?: boolean;
  /**
   * Build 5.1 provenance: optional, caller-supplied environment identity.
   * A legacy caller that omits it still gets a fingerprint over the fields
   * CrashLab can observe on its own.
   */
  provenance?: ProvenanceInput;
  /**
   * Bytes of the test-data fixture, hashed only when `provenance.hashTestData`
   * is set. The bytes are never written to a report; only their digest is, and
   * the caller must opt in.
   */
  testDataFixtureHashSource?: Uint8Array;
  /**
   * Build 6.5: operator-declared expectations for SPA/JS-driven flows.
   * Validated against the journey plan before any browser launches.
   */
  expectations?: ExpectationsFile;
}

/** A validation failure that must stop the run before any browser launches. */
export class JourneyPlanError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.name = 'JourneyPlanError';
    this.path = path;
  }
}

/** A refusal to execute, raised before the browser launches. */
export class ExecutionRefused extends Error {
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = 'ExecutionRefused';
    this.reason = reason;
  }
}
