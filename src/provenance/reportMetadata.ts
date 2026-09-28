/**
 * Provenance assembly.
 *
 * Collects only safe facts about a run and assembles the record embedded in
 * `execution.json`. Nothing here opens a browser, makes a network request, or
 * inspects the target: the browser version is read from the already-launched
 * session by the caller and passed in, and the Playwright version comes from
 * package metadata rather than a dependency.
 *
 * The collection of *values* is here; the assembly is pure given those values,
 * which is what keeps the interesting logic testable without Playwright.
 */

import { readFile } from 'node:fs/promises';
import { computeFingerprint, hashFixture, nodeMajorMinor } from './fingerprint.js';
import { sanitizeAppBuildId, sanitizeDataId, sanitizeEnvironmentId, safeTargetOrigin, safeVersion } from './redaction.js';
import { PROVENANCE_SCHEMA_VERSION } from './types.js';
import type {
  ApplicationProvenance,
  EnvironmentProvenance,
  EnvironmentReference,
  FingerprintInput,
  ProvenanceInput,
  TargetProvenance,
  TestDataProvenance,
} from './types.js';
import { BROWSER_NAME, TOOL_VERSION } from '../version.js';
import { JOURNEY_SCHEMA_VERSION } from '../journey/types.js';

/** Values the caller collects; the assembly below is pure given these. */
export interface ProvenanceFacts {
  /** Target URL, reduced to an origin before it is recorded. */
  targetUrl: string | null;
  /** Browser version string from the live session, when available. */
  browserVersion: string | null;
  /** Whether the run was headless. */
  headless: boolean;
  /** Per-step timeout in effect. */
  timeoutMs: number;
  /** Safe-test mode; always true in this build. */
  safeTestMode: boolean;
  /** Journey plan schema version the run consumed. */
  journeySchemaVersion: string;
  /** Optional SHA-256 of the test-data fixture bytes. */
  testDataFixtureHash?: string | null;
}

/** Node process facts. Safe by construction: no environment dump, no paths. */
export function collectRuntimeProvenance(): { nodeVersion: string; platform: string; architecture: string } {
  return {
    nodeVersion: process.versions.node,
    platform: process.platform,
    architecture: process.arch,
  };
}

/**
 * Read the installed Playwright version from its own package metadata.
 *
 * Deliberately reads `package.json` rather than adding a dependency or
 * importing a version constant that may not exist across releases.
 */
export async function collectPlaywrightVersion(): Promise<string> {
  try {
    // Resolved from node_modules relative to this module, so no new dependency
    // and no network access is required.
    const url = new URL('../../node_modules/playwright/package.json', import.meta.url);
    const parsed = JSON.parse(await readFile(url, 'utf8')) as { version?: string };
    return safeVersion(parsed.version);
  } catch {
    return 'unknown';
  }
}

/**
 * Assemble the full provenance record.
 *
 * Pure given its facts and the caller's optional identifiers, so the whole
 * shape can be asserted without a browser.
 */
export function buildEnvironmentProvenance(
  facts: ProvenanceFacts,
  runtime: { nodeVersion: string; platform: string; architecture: string },
  input: ProvenanceInput = {},
): EnvironmentProvenance {
  const target: TargetProvenance = safeTargetOrigin(facts.targetUrl);

  // Caller identifiers are sanitized, which throws on an unsafe value rather
  // than writing it. A rejected identifier is better than a written secret.
  const environmentId = sanitizeEnvironmentId(input.environmentId);
  const applicationBuildId = sanitizeAppBuildId(input.appBuildId);
  const dataId = sanitizeDataId(input.dataId);

  const application: ApplicationProvenance = {
    buildId: applicationBuildId,
    environmentId,
  };

  const testData: TestDataProvenance = {
    fixtureId: dataId,
    fixtureHash: input.hashTestData === true ? (facts.testDataFixtureHash ?? null) : null,
  };

  const fingerprintInput: FingerprintInput = {
    targetOrigin: target.origin,
    browserName: BROWSER_NAME,
    browserVersion: facts.browserVersion === null ? null : safeVersion(facts.browserVersion),
    nodeMajorMinor: nodeMajorMinor(runtime.nodeVersion),
    platform: runtime.platform,
    architecture: runtime.architecture,
    headless: facts.headless,
    safeTestMode: facts.safeTestMode,
    timeoutMs: facts.timeoutMs,
    journeySchemaVersion: safeVersion(facts.journeySchemaVersion, JOURNEY_SCHEMA_VERSION),
    executorVersion: safeVersion(TOOL_VERSION),
    plannerVersion: safeVersion(TOOL_VERSION),
    applicationBuildId,
    environmentId,
    testDataFixtureId: dataId,
  };

  const fingerprint = computeFingerprint(fingerprintInput);

  return {
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
    fingerprint,
    fingerprintInputs: fingerprintInput as EnvironmentProvenance['fingerprintInputs'],
    target,
    runtime: {
      nodeVersion: safeVersion(runtime.nodeVersion),
      platform: runtime.platform,
      architecture: runtime.architecture,
    },
    browser: {
      name: BROWSER_NAME,
      version: facts.browserVersion === null ? 'unknown' : safeVersion(facts.browserVersion),
    },
    configuration: {
      headless: facts.headless,
      safeTestMode: facts.safeTestMode,
      timeoutMs: facts.timeoutMs,
    },
    source: {
      journeySchemaVersion: safeVersion(facts.journeySchemaVersion, JOURNEY_SCHEMA_VERSION),
      plannerVersion: safeVersion(TOOL_VERSION),
      executorVersion: safeVersion(TOOL_VERSION),
    },
    application,
    testData,
  };
}
/** Hash test-data fixture bytes, for an opt-in identity marker. */
export function hashTestDataFixture(bytes: Uint8Array): string {
  return hashFixture(bytes);
}

/**
 * The compact reference an anomaly or reproduction report carries.
 *
 * A reference rather than a copy, so a report points at an environment without
 * restating it, and two reports stay comparable by fingerprint alone.
 */
export function toEnvironmentReference(
  provenance: EnvironmentProvenance | null | undefined,
): EnvironmentReference {
  if (!provenance) {
    return {
      fingerprint: null,
      origin: null,
      browserName: 'unknown',
      browserVersion: 'unknown',
      environmentId: null,
      applicationBuildId: null,
    };
  }
  return {
    fingerprint: provenance.fingerprint ?? null,
    origin: provenance.target.origin,
    browserName: provenance.browser.name,
    browserVersion: provenance.browser.version,
    environmentId: provenance.application.environmentId,
    applicationBuildId: provenance.application.buildId,
  };
}

/**
 * Read provenance off a report, tolerating absence.
 *
 * A legacy report has no environment object. That reads as `null` here so the
 * caller can record provenance as unknown rather than invent it.
 */
export function provenanceFromReport(value: unknown): EnvironmentProvenance | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as { environment?: unknown };
  if (typeof record.environment !== 'object' || record.environment === null) return null;
  return record.environment as EnvironmentProvenance;
}
