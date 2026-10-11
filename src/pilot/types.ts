/**
 * Pilot Execution Types & Contracts — Build 10.3.
 *
 * Defines strongly typed contracts for the pilot execution safety gate,
 * execution plans, runner options, and dependency injection interfaces.
 *
 * Contains ZERO Playwright, browser, or network imports.
 */

import type {
  ApprovedJourney,
  PilotConfiguration,
  PilotEnvironment,
  PreflightReport,
  PreflightResult,
  SafetyGateStatus,
} from '../preflight/types.js';
import type { ExecutionReport } from '../executor/types.js';

/** Strongly typed, immutable plan created only when preflight validation status is 'ready'. */
export interface PilotExecutionPlan {
  readonly status: 'ready';
  readonly targetUrl: string;
  readonly targetOrigin: string;
  readonly targetEnvironment: PilotEnvironment;
  readonly targetName: string;
  readonly appBuildId: string | null;
  readonly allowedOrigins: readonly string[];
  readonly approvedJourneys: readonly ApprovedJourney[];
  readonly forbiddenActions: readonly string[];
  readonly testDataFile?: string;
  readonly authorizationReference?: string;
  readonly resetProcedure?: string;
  readonly testingWindow?: string;
}

/** Execution options for running a single journey within a pilot run. */
export interface PilotJourneyExecutionOptions {
  readonly journeyPath?: string;
  readonly plan?: unknown;
  readonly testData?: Record<string, string>;
  readonly timeoutMs?: number;
  readonly headed?: boolean;
  readonly screenshots?: boolean;
  readonly evidenceDir?: string;
  readonly safeTestMode?: boolean;
}

/** Injected dependencies for testability and isolation without Playwright coupling. */
export interface PilotRunnerDependencies {
  /** Injected configuration loader. */
  readonly loadConfig?: (path: string) => Promise<PilotConfiguration>;
  /** Injected validator function. Defaults to `validatePilotConfiguration`. */
  readonly validateConfig?: (config: PilotConfiguration) => PreflightResult;
  /** Injected browser factory/launcher. Must never be called unless preflight status is 'ready'. */
  readonly browserLauncher?: (options: unknown) => Promise<unknown>;
  /** Injected journey executor. Defaults to CrashLab executor if not provided. */
  readonly journeyExecutor?: (options: PilotJourneyExecutionOptions) => Promise<ExecutionReport>;
  /** Injected report writer. */
  readonly reportWriter?: (report: unknown, path: string) => Promise<void>;
}

/** Options provided to the pilot runner. */
export interface PilotRunnerOptions {
  /** Path to configuration file (JSON or key-value format), or pre-loaded configuration. */
  readonly config: string | PilotConfiguration;
  /** Optional pre-validated preflight result (if pre-validated). */
  readonly preflightResult?: PreflightResult;
  /** If true, stops immediately after preflight validation without launching a browser. */
  readonly preflightOnly?: boolean;
  /** Path to a journey plan to execute against the target. */
  readonly journeyPath?: string;
  /** Optional directory for execution reports. */
  readonly reportDir?: string;
  /** Optional path to write the preflight JSON report. */
  readonly preflightReportPath?: string;
  /** Confirmation flag required for execution runs. */
  readonly confirmAuthorized?: boolean;
  /** If true, suppresses human-readable terminal output. */
  readonly quiet?: boolean;
}

/** Result emitted by the pilot runner. */
export interface PilotRunResult {
  /** Overall outcome code (0: ready/success, 1: blocked/invalid/refused, 2: syntax error). */
  readonly exitCode: number;
  /** Preflight validation result. */
  readonly preflightResult: PreflightResult;
  /** Preflight report. */
  readonly preflightReport: PreflightReport;
  /** Execution plan if preflight was ready; undefined if blocked or invalid. */
  readonly executionPlan?: PilotExecutionPlan;
  /** True if browser execution was actually attempted; false if dry-run, blocked, or preflight-only. */
  readonly executed: boolean;
  /** Number of browser launch attempts performed. Must be 0 for all blocked/invalid/preflight-only runs. */
  readonly browserLaunchAttempts: number;
  /** Human-readable message explaining the outcome or refusal reason. */
  readonly message: string;
  /** Execution report if execution was performed. */
  readonly executionReport?: ExecutionReport;
}
