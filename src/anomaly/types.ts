/**
 * The Anomaly Engine output contract.
 *
 * An anomaly is an evidence-backed *signal* that something unusual was
 * observed. It is not a confirmed defect. Every signal in this module carries
 * `confirmed: false`, and the report as a whole carries
 * `interpretation.confirmedBug: false`, because confirming a bug requires
 * reproduction - which is Build 5.
 *
 * The vocabulary here is deliberately careful. `signalLevel` describes how
 * direct or urgent an observation is; it is not a product severity, and nothing
 * in Build 4 ranks defects.
 *
 * Build 4 is pure: it reads local JSON artifacts and writes a new one. It opens
 * no browser, makes no network call, and imports no Playwright.
 */

import type { ExecutionStatus } from '../executor/types.js';

/** Anomaly report schema version. */
export const ANOMALY_SCHEMA_VERSION = '1.0';

/** Execution report schema versions this analyzer understands. */
export const SUPPORTED_EXECUTION_SCHEMA_VERSIONS = ['1.0'] as const;

/**
 * Journey plan schema versions this analyzer understands.
 *
 * Named distinctly from the executor's identically-shaped constant, so the
 * public surface does not export two values under one name. The Build 2
 * contract is version 1.0.
 */
export const SUPPORTED_ANOMALY_JOURNEY_SCHEMA_VERSIONS = ['1.0'] as const;

/**
 * Stable rule identifiers.
 *
 * These are part of the output contract: a downstream consumer, and Build 5,
 * will match on them. Never renumber or repurpose one.
 */
export const RULE_IDS = {
  http4xx: 'HTTP_4XX',
  http5xx: 'HTTP_5XX',
  networkRequestFailed: 'NETWORK_REQUEST_FAILED',
  consoleError: 'CONSOLE_ERROR',
  consoleWarning: 'CONSOLE_WARNING',
  pageError: 'PAGE_ERROR',
  stepTimeout: 'STEP_TIMEOUT',
  unexpectedOrigin: 'UNEXPECTED_ORIGIN',
  unexpectedRedirect: 'UNEXPECTED_REDIRECT',
  targetMissingAfterAction: 'TARGET_MISSING_AFTER_ACTION',
  targetDisabledAfterAction: 'TARGET_DISABLED_AFTER_ACTION',
  duplicateRequest: 'DUPLICATE_REQUEST',
  executionActionFailed: 'EXECUTION_ACTION_FAILED',
} as const;

export type RuleId = (typeof RULE_IDS)[keyof typeof RULE_IDS];

/** The evidence family a signal came from. */
export type EvidenceType = 'network' | 'console' | 'pageError' | 'step';

/** Coarse category, useful for grouping without parsing a rule id. */
export type AnomalyKind = 'http-error' | 'network-failure' | 'console' | 'page-error' | 'timeout' | 'navigation' | 'ui-state' | 'duplicate-request' | 'step-failure';

/**
 * How direct the observation is.
 *
 * `info` - recorded for context; `warning` - worth a look, often expected;
 * `error` - a direct failure signal. This is *not* product severity.
 */
export type SignalLevel = 'info' | 'warning' | 'error';

/** Every signal is observed, never confirmed. */
export type AnomalyStatus = 'observed';

/** Where a signal points back to in the execution report. */
export interface AnomalySource {
  executionReport: string;
  evidenceType: EvidenceType;
  /** Index within the evidence array, when the event can be located. */
  eventIndex: number | null;
}

/** One observed signal. */
export interface Anomaly {
  /** Deterministic id: `anomaly-001`, `anomaly-002`, ... */
  id: string;
  ruleId: RuleId;
  kind: AnomalyKind;
  signalLevel: SignalLevel;
  status: AnomalyStatus;
  /** Factual description of what was observed, never a verdict. */
  message: string;
  stepId: string | null;
  stepOrder: number | null;
  source: AnomalySource;
  /** Rule-specific structured facts. Already redacted. */
  details: Record<string, unknown>;
  /**
   * True when the signal may be legitimate depending on application context -
   * a 401, a probe for a resource that does not exist, a polling request.
   */
  possiblyExpected: boolean;
  /** Always false. Build 4 never confirms; Build 5 does. */
  confirmed: false;
  /**
   * How many raw events this signal represents. A duplicate-request signal, or
   * a consolidated repeated HTTP error, carries a count above one.
   */
  occurrences: number;
}

/** Counts per category, for the terminal summary and for tests. */
export interface AnomalySummary {
  totalSignals: number;
  httpErrors: number;
  networkFailures: number;
  consoleErrors: number;
  pageErrors: number;
  timeouts: number;
  navigationSignals: number;
  uiStateSignals: number;
  duplicateRequestSignals: number;
  stepFailureSignals: number;
  /** Rules that fired, sorted, for a quick overview. */
  ruleIds: string[];
}

/** How the analysis was performed. */
export interface AnalyzerMeta {
  mode: 'deterministic';
  version: string;
}

/** The explicit limits of this report. */
export interface Interpretation {
  /** Always false in Build 4. Confirmation is Build 5. */
  confirmedBug: false;
  /** True when at least one signal warrants review. */
  requiresInvestigation: boolean;
  /** The standing disclaimer, stated in the artifact itself. */
  note: string;
}

/** A validation failure that must stop the analysis. */
export class AnomalyInputError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.name = 'AnomalyInputError';
    this.path = path;
  }
}

/** Inputs the analyzer needs, already loaded and validated. */
export interface AnomalyAnalysisInput {
  /** The validated execution report. */
  execution: import('../executor/types.js').ExecutionReport;
  /** Execution report path as supplied, echoed into every signal's source. */
  executionPath: string;
  /** The validated journey plan, used only for origin and step context. */
  journey: import('../journey/types.js').JourneyPlan;
  /** Journey report path as supplied. */
  journeyPath: string;
}

/** Options for one analysis. */
export interface AnomalyAnalysisOptions {
  /**
   * Treat console warnings as signals. Off by default: a warning is frequently
   * expected, and promoting every one would bury the real errors.
   */
  includeConsoleWarnings?: boolean;
}

/** Convenience re-export so rules need not import from the executor. */
export type { ExecutionStatus };
