/**
 * Staging Pilot Preflight Configuration Types — Build 10.2.
 *
 * Strongly typed contracts for protected pilot configuration, approved journeys,
 * safety checks, and deterministic preflight reports.
 *
 * This module contains zero browser, network, or AI dependencies.
 */

export type PilotEnvironment = 'local' | 'demo' | 'qa' | 'staging';

export const VALID_PILOT_ENVIRONMENTS: readonly PilotEnvironment[] = [
  'local',
  'demo',
  'qa',
  'staging',
] as const;

/** An approved user journey within the pilot configuration. */
export interface ApprovedJourney {
  /** Stable unique identifier (e.g. `j-catalog-01`). */
  readonly id: string;
  /** Human-readable journey goal (e.g. `browse catalog and filter products`). */
  readonly goal: string;
  /** Target origin for this journey (must belong to allowedOrigins). */
  readonly origin: string;
  /** Explicitly permitted actions (e.g. `navigate`, `click`, `fill`, `view`). */
  readonly allowedActions: readonly string[];
  /** Explicitly forbidden actions for this journey. */
  readonly forbiddenActions: readonly string[];
  /** Whether the journey requires a dedicated test account. */
  readonly requiresCredentials?: boolean;
  /** Whether the journey requires input test-data fixtures. */
  readonly requiresTestData?: boolean;
}

/** Complete pilot configuration loaded from protected local storage. */
export interface PilotConfiguration {
  /** Target URL to test (must be HTTPS for non-local, or loopback for local). */
  readonly targetUrl: string;
  /** Human-readable application name. */
  readonly targetName: string;
  /** Target environment: local, demo, qa, or staging. Production is prohibited. */
  readonly targetEnvironment: PilotEnvironment;
  /** Optional application build or release identifier. */
  readonly appBuildId?: string;
  /** Explicit list of authorized origin URLs (e.g. `['https://staging.example.com']`). */
  readonly allowedOrigins: readonly string[];
  /** Approved journeys: 2–4 for staging/qa/demo, 1–4 for local. */
  readonly allowedJourneys: readonly ApprovedJourney[];
  /** Global list of forbidden actions (e.g. payment, checkout, account deletion). */
  readonly forbiddenActions: readonly string[];
  /** Optional local path to protected test-data file (must exist, never logged). */
  readonly testDataFile?: string;
  /** Non-secret reference to written authorization (required for non-local). */
  readonly authorizationReference?: string;
  /** Description or reference to target reset / cleanup procedure. */
  readonly resetProcedure?: string;
  /** Optional approved testing window (e.g. `Off-peak 02:00-06:00 UTC`). */
  readonly testingWindow?: string;
}

/** Preflight safety gate status. */
export type SafetyGateStatus = 'ready' | 'blocked' | 'invalid';

/** Individual safety rule evaluation result. */
export interface SafetyCheck {
  readonly id: string;
  readonly name: string;
  readonly category:
    | 'target'
    | 'origin'
    | 'environment'
    | 'journeys'
    | 'forbidden-actions'
    | 'credentials'
    | 'authorization';
  readonly passed: boolean;
  readonly reason?: string;
}

/** Specific validation error. */
export interface ValidationError {
  readonly code: string;
  readonly message: string;
  readonly field?: string;
}

/** Preflight validation result produced by `validatePilotConfiguration`. */
export interface PreflightResult {
  /** Overall safety gate status: ready (0), blocked (1), or invalid (1). */
  readonly status: SafetyGateStatus;
  /** True if and only if status is 'ready'. */
  readonly valid: boolean;
  /** Resolved target origin (e.g. `https://staging.example.com`). */
  readonly targetOrigin: string | null;
  /** Resolved target environment. */
  readonly targetEnvironment: PilotEnvironment | 'unknown';
  /** List of all evaluated safety checks. */
  readonly checks: readonly SafetyCheck[];
  /** Errors encountered during evaluation. */
  readonly errors: readonly ValidationError[];
  /** Summary reasons for failed checks. */
  readonly failureReasons: readonly string[];
  /** Safe non-secret metadata summary. */
  readonly metadata: {
    readonly targetName: string;
    readonly appBuildId: string | null;
    readonly allowedOrigins: readonly string[];
    readonly journeyCount: number;
    readonly journeyIds: readonly string[];
    readonly forbiddenActionCategories: readonly string[];
    readonly testDataConfigured: boolean;
    readonly authorizationConfigured: boolean;
  };
}

/** Serialized JSON preflight report format. */
export interface PreflightReport {
  readonly schemaVersion: '1.0';
  readonly status: SafetyGateStatus;
  readonly statement: string;
  readonly target: {
    readonly url: string;
    readonly origin: string;
    readonly name: string;
    readonly environment: PilotEnvironment | 'unknown';
    readonly appBuildId: string | null;
  };
  readonly allowedOrigins: readonly string[];
  readonly journeys: readonly {
    readonly id: string;
    readonly goal: string;
    readonly origin: string;
    readonly allowedActions: readonly string[];
    readonly requiresCredentials: boolean;
    readonly requiresTestData: boolean;
  }[];
  readonly forbiddenActionCategories: readonly string[];
  readonly testDataConfigured: boolean;
  readonly authorizationConfigured: boolean;
  readonly safetyChecks: readonly SafetyCheck[];
  readonly failureReasons: readonly string[];
}
