/**
 * The Baseline contract.
 *
 * A baseline is a **known-good** record of what a run looked like when a human
 * said it was fine. It exists so a later run can be called *novel* rather than
 * merely *present*.
 *
 * Two rules govern everything here:
 *
 *  1. **A baseline is never inferred.** It is created only when an operator
 *     passes `--confirm-known-good`. A green exit code, or a run that happened
 *     to produce no signals, is not consent - it is an observation, and the
 *     difference is the whole point.
 *
 *  2. **A baseline is immutable.** A new state gets a new baseline id. Mutating
 *     an old one would destroy the very record that makes "changed" detectable.
 *
 * Pure types; the logic lives in `validator.ts`, `identity.ts` and `writer.ts`.
 */

/** Baseline schema version. */
export const BASELINE_SCHEMA_VERSION = '1.0';

/** A baseline is always a known-good claim, never a defect claim. */
export type BaselineStatus = 'known-good';

/** Where the baseline's inputs came from. References, never inlined reports. */
export interface BaselineSource {
  executionReport: string;
  anomalyReport: string;
  journeyReport: string;
}

/**
 * What this baseline *is*, independent of any particular run.
 *
 * Two runs are comparable only when these agree. The journey hash is what makes
 * "the plan changed" detectable, and the build id what makes "the application
 * changed" detectable.
 */
export interface BaselineIdentity {
  targetOrigin: string | null;
  /** SHA-256 over the canonical journey content. */
  journeyHash: string;
  journeySchemaVersion: string;
  journeyType: string;
  /** Null when the source run carried no provenance. */
  environmentFingerprint: string | null;
  environmentId: string | null;
  applicationBuildId: string | null;
  plannerVersion: string | null;
  executorVersion: string | null;
}

/** The operator's explicit statement behind this baseline. */
export interface BaselineConfirmation {
  /** Always true. A baseline cannot exist without it. */
  explicit: true;
  /** Free-text attribution; the operator supplies it, it is never inferred. */
  confirmedBy: string | null;
  /** Signal ids the operator knowingly accepted rather than fixed. */
  acceptedSignalIds: string[];
}

/**
 * A signal present in the baseline.
 *
 * Stored as a normalized key plus the safe identifying fields, not as a copy of
 * the anomaly. That keeps the baseline comparable without embedding evidence
 * that could carry a secret.
 */
export interface BaselineSignal {
  /** The stable key produced by the shared Build 5 normalizer. */
  signalKey: string;
  ruleId: string;
  kind: string;
  signalLevel: string;
  /** HTTP status for http signals, so a 404 -> 500 change is detectable. */
  statusCode: number | null;
  method: string | null;
  /** Sanitized URL. Never a path, query or fragment. */
  url: string | null;
  resourceType: string | null;
  stepId: string | null;
  /** True when the operator accepted this signal rather than fixing it. */
  accepted: boolean;
  /** Evidence references into the source reports. */
  anomalyId: string;
}

/** The safety state the baseline was created under. */
export interface BaselineSafety {
  safeTestMode: boolean;
  livePaymentAllowed: boolean;
  /** True when the source execution had at least one failed step. */
  executionHadFailures: boolean;
  /** True when the source execution was aborted or partially run. */
  executionIncomplete: boolean;
}

/** The stored baseline document. */
export interface Baseline {
  schemaVersion: string;
  baselineId: string;
  name: string;
  status: BaselineStatus;
  /**
   * The one non-deterministic field, and it is stored deliberately: a baseline
   * is a record of when a human made a claim. Nothing compares against it.
   */
  createdAt: string;
  confirmation: BaselineConfirmation;
  source: BaselineSource;
  identity: BaselineIdentity;
  knownSignals: BaselineSignal[];
  safety: BaselineSafety;
  /** Why this baseline was considered known-good, and what it does not claim. */
  rationale: string;
  interpretation: {
    confirmedBug: false;
    automaticSeverity: false;
    note: string;
  };
}

/** The index file listing available baselines. */
export interface BaselineRegistry {
  schemaVersion: string;
  baselines: {
    baselineId: string;
    name: string;
    report: string;
    createdAt: string;
    targetOrigin: string | null;
    environmentFingerprint: string | null;
  }[];
}

/** A refusal to create or use a baseline. */
export class BaselineError extends Error {
  readonly path: string;

  constructor(message: string, path = '') {
    super(message);
    this.name = 'BaselineError';
    this.path = path;
  }
}

/** Default directory for stored baselines. */
export const DEFAULT_BASELINE_DIR = 'reports/baselines';

/** Registry file name within the baseline directory. */
export const BASELINE_REGISTRY_FILE = 'index.json';
