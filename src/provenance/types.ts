/**
 * Environment provenance.
 *
 * Build 5 could say a signal recurred, but not *where*. That gap matters: a
 * signal that reproduces against production-like data and one that reproduces
 * only against a local fixture are very different leads, and the report gave
 * no way to tell them apart.
 *
 * This module records *where and how* a run happened, using only safe values.
 *
 * Two ideas carry the whole design:
 *
 * 1. **Provenance is not identity.** A matching fingerprint means the recorded
 *    safe fields agree. It does not prove two systems are the same system, and
 *    it is not a security credential - it is an identity aid for comparison.
 *
 * 2. **Absent is not invented.** A legacy report with no provenance reads as
 *    `unknown`, never as a fabricated fingerprint. Guessing provenance would
 *    corrupt exactly the comparison it exists to support.
 *
 * Pure and Playwright-free, so it is fully testable without a browser.
 */

/** Provenance schema version. */
export const PROVENANCE_SCHEMA_VERSION = '1.0';

/** Longest accepted caller-supplied identifier. */
export const MAX_IDENTIFIER_LENGTH = 100;

/** Where the target was, reduced to its origin. */
export interface TargetProvenance {
  /** Protocol, host and non-default port. Never a path, query or fragment. */
  origin: string | null;
  /** True when the target was not a parseable absolute URL. */
  unresolved: boolean;
}

/** The Node process that ran the journey. */
export interface RuntimeProvenance {
  nodeVersion: string;
  platform: string;
  architecture: string;
}

/** The browser that ran the journey. */
export interface BrowserProvenance {
  name: string;
  version: string;
}

/** The run configuration that affects behaviour. */
export interface ConfigurationProvenance {
  headless: boolean;
  safeTestMode: boolean;
  timeoutMs: number;
}

/** Which CrashLab builds produced the artifacts. */
export interface SourceProvenance {
  journeySchemaVersion: string;
  plannerVersion: string;
  executorVersion: string;
}

/** Caller-supplied identity for the application under test. */
export interface ApplicationProvenance {
  buildId: string | null;
  environmentId: string | null;
}

/** Identity of the test-data fixture, never its contents. */
export interface TestDataProvenance {
  fixtureId: string | null;
  /** SHA-256 of the fixture bytes, when the caller opted in. */
  fixtureHash: string | null;
}

/**
 * The full provenance record embedded in an execution report.
 *
 * Every field is either a version, a boolean, a number, a null, or a
 * caller-supplied identifier that passed sanitization. There is no field here
 * that can hold a secret.
 */
export interface EnvironmentProvenance {
  schemaVersion: string;
  /** `sha256:<hex>` over the canonical safe fields. Null when unavailable. */
  fingerprint: string | null;
  /** The exact values hashed, so a mismatch can be explained. */
  fingerprintInputs: Record<string, string | number | boolean | null>;
  target: TargetProvenance;
  runtime: RuntimeProvenance;
  browser: BrowserProvenance;
  configuration: ConfigurationProvenance;
  source: SourceProvenance;
  application: ApplicationProvenance;
  testData: TestDataProvenance;
}

/**
 * The compact form referenced by anomaly and reproduction reports.
 *
 * A reference rather than a copy, so a report can say which environment
 * produced it without restating everything.
 */
export interface EnvironmentReference {
  fingerprint: string | null;
  origin: string | null;
  browserName: string;
  browserVersion: string;
  environmentId: string | null;
  applicationBuildId: string | null;
}

/**
 * How two recorded environments relate.
 *
 * - `same`     - every recorded safe fingerprint input matches
 * - `different`- at least one recorded input differs
 * - `unknown`  - a report lacks provenance, so no comparison is possible
 */
export type EnvironmentComparison = 'same' | 'different' | 'unknown';

/** The result of comparing an original environment against attempt environments. */
export interface EnvironmentComparisonResult {
  classification: EnvironmentComparison;
  /** Field names that differ. Empty when `same` or `unknown`. */
  differences: string[];
  /** True when no comparison could be made. */
  unknownReason: string | null;
}

/** Caller-supplied, optional provenance overrides. */
export interface ProvenanceInput {
  /** Short, safe identifier for the environment, e.g. `local-shop`. */
  environmentId?: string | null;
  /** Short, safe build identifier supplied by the caller. */
  appBuildId?: string | null;
  /** Short, safe identifier for the test-data fixture. */
  dataId?: string | null;
  /** Hash the test-data fixture bytes. Opt-in; a hash is not secret protection. */
  hashTestData?: boolean;
}

/**
 * The raw values a fingerprint is computed from, before canonicalization.
 *
 * Kept separate from the sanitized report shape so the fingerprint inputs can
 * be normalized and hashed without a browser or a report ever existing.
 */
export interface FingerprintInput {
  targetOrigin?: string | null;
  browserName?: string | null;
  browserVersion?: string | null;
  nodeMajorMinor?: string | null;
  platform?: string | null;
  architecture?: string | null;
  headless?: boolean | null;
  safeTestMode?: boolean | null;
  timeoutMs?: number | null;
  journeySchemaVersion?: string | null;
  executorVersion?: string | null;
  plannerVersion?: string | null;
  applicationBuildId?: string | null;
  environmentId?: string | null;
  testDataFixtureId?: string | null;
}

/** Why a caller-supplied identifier was rejected. */
export class UnsafeIdentifierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeIdentifierError';
  }
}
