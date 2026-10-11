/**
 * Baseline storage.
 *
 * File-based and append-only. A baseline is never overwritten: the record of
 * what was known-good at a point in time is the only thing that makes "changed"
 * detectable, so mutating one would destroy the evidence the comparison rests on.
 *
 * A duplicate id is a refusal, not an update. The operator creates a new id.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { writeReport } from '../report/write.js';
import { toEnvironmentReference } from '../provenance/reportMetadata.js';
import type { AnomalyReport } from '../anomaly/report.js';
import type { ExecutionReport } from '../executor/types.js';
import type { JourneyPlan } from '../journey/types.js';
import { buildBaselineIdentity, toBaselineSignal } from './identity.js';
import {
  BASELINE_REGISTRY_FILE,
  BASELINE_SCHEMA_VERSION,
  BaselineError,
  DEFAULT_BASELINE_DIR,
} from './types.js';
import type { Baseline, BaselineRegistry } from './types.js';

/** What the operator supplies to create a baseline. */
export interface BaselineCreationRequest {
  baselineId: string;
  name: string;
  execution: ExecutionReport;
  anomalies: AnomalyReport;
  journey: JourneyPlan;
  /** Signal ids the operator explicitly accepted. */
  acceptedSignalIds: string[];
  /** Optional operator attribution. Never inferred. */
  confirmedBy: string | null;
  /** Report paths, echoed as references. */
  paths: { execution: string; anomalies: string; journey: string };
  /**
   * True when the operator explicitly allowed a partially verified run.
   * Recorded on the baseline so the approval is auditable.
   */
  allowUnverifiedAssertions?: boolean;
  /**
   * Build 6.5: true when the source execution used operator-declared
   * expectations (`reports/expectations.json`). The baseline becomes
   * `known-good-declared` only when both flags were supplied on the baseline
   * command and the source run actually carried an expectations file.
   */
  allowDeclaredExpectations?: boolean;
  /** Where baselines are stored. */
  baselineDir?: string;
  /** Injected in tests; defaults to now. */
  now?: () => Date;
}

/** Absolute path a baseline id maps to. */
export function baselinePathFor(baselineId: string, baselineDir: string = DEFAULT_BASELINE_DIR): string {
  return resolve(baselineDir, `${baselineId}.json`);
}

/**
 * Build the baseline document without writing it.
 *
 * Pure given its inputs, so the whole shape is testable without a filesystem.
 */
export function buildBaseline(request: BaselineCreationRequest): Baseline {
  const accepted = new Set(request.acceptedSignalIds);

  const knownSignals = request.anomalies.anomalies
    .map((anomaly) => toBaselineSignal(anomaly, accepted.has(anomaly.id)))
    // A signal with no stable key cannot be compared later, so it is dropped
    // rather than stored as an unmatchable entry.
    .filter((signal): signal is NonNullable<typeof signal> => signal !== null);

  const identity = buildBaselineIdentity(request.journey, request.execution);
  // Injected in tests so a baseline's createdAt is deterministic under test.
  const clock = request.now ?? ((): Date => new Date());

  // Verification comes from the execution report when it carries it, and is
  // `unavailable` for a legacy report rather than being invented.
  const executionVerification = request.execution.verification ?? null;
  const unverifiedAssertions = executionVerification?.unverifiedAssertions ?? 0;
  const fullyVerified = executionVerification !== null && executionVerification.status === 'complete' && executionVerification.complete;

  // A partially verified run is only recorded as such when the operator said so.
  const partialApproved = !fullyVerified && request.allowUnverifiedAssertions === true;

  // Build 6.5: a run that used operator-declared expectations is fully verified
  // only with explicit operator approval. The coverage stamp stays
  // `operator-declared` rather than collapsing into `full-plan`, so a later
  // reader knows which trust model backed the comparison.
  const usedDeclaredExpectations = request.execution.expectationFileHash !== null && request.execution.expectationFileHash !== undefined;
  const declaredApproved = request.allowDeclaredExpectations === true && usedDeclaredExpectations;

  let status: 'known-good' | 'known-good-partial' | 'known-good-declared';
  if (declaredApproved) {
    status = 'known-good-declared';
  } else if (fullyVerified) {
    status = 'known-good';
  } else if (partialApproved) {
    status = 'known-good-partial';
  } else {
    status = 'known-good';
  }

  let coverage: 'full-plan' | 'executed-steps-only' | 'partial-plan' | 'operator-declared' | 'unavailable';
  if (declaredApproved) {
    coverage = 'operator-declared';
  } else if (fullyVerified) {
    coverage = 'full-plan';
  } else {
    coverage = executionVerification?.coverage ?? 'unavailable';
  }

  return {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    baselineId: request.baselineId,
    name: request.name,
    // A partial baseline is never dressed up as a full one.
    status,
    createdAt: clock().toISOString(),
    confirmation: {
      explicit: true,
      confirmedBy: request.confirmedBy,
      acceptedSignalIds: [...accepted].sort(),
    },
    source: {
      executionReport: request.paths.execution,
      anomalyReport: request.paths.anomalies,
      journeyReport: request.paths.journey,
    },
    identity,
    knownSignals,
    verification: {
      complete: fullyVerified || declaredApproved,
      coverage,
      unverifiedAssertions,
      operatorApproved: partialApproved || declaredApproved,
    },
    safety: {
      safeTestMode: request.execution.executor?.safeTestMode === true,
      // Safe test mode is the only mode that exists, so live payment can never
      // have been permitted. Recorded as false for the reader's benefit.
      livePaymentAllowed: false,
      executionHadFailures: (request.execution.steps ?? []).some((step) => step.status === 'failed'),
      executionIncomplete: !['passed', 'partial'].includes(request.execution.status),
    },
    rationale:
      `Operator-confirmed known-good state for ${request.journey.journeyType} at ${identity.targetOrigin ?? 'unknown origin'}. ` +
      `Recorded with ${knownSignals.length} known signal(s) and ${[...accepted].length} explicitly accepted signal(s). ` +
      'This records what was considered normal at the time; it makes no claim that any other state is defective.',
    interpretation: {
      confirmedBug: false,
      automaticSeverity: false,
      note:
        'A baseline is an operator assertion about a known-good state, not a defect verdict. ' +
        'Nothing in this document confirms or denies any bug.',
    },
  };
}

/**
 * Write a baseline, refusing to overwrite an existing one.
 *
 * @returns the absolute path written.
 * @throws {BaselineError} when the id is already taken.
 */
export async function writeBaseline(
  baseline: Baseline,
  baselineDir: string = DEFAULT_BASELINE_DIR,
  cwd: string = process.cwd(),
): Promise<string> {
  const absolute = baselinePathFor(baseline.baselineId, resolve(cwd, baselineDir));

  // `wx` would be atomic, but the existence check is clearer and the baseline
  // directory is operator-scoped rather than a hot write path.
  if (existsSync(absolute)) {
    throw new BaselineError(
      `A baseline with id "${baseline.baselineId}" already exists at ${absolute}. ` +
        'Baselines are immutable; create a new baseline id rather than overwriting this one.',
      absolute,
    );
  }

  await mkdir(resolve(cwd, baselineDir), { recursive: true });
  const written = await writeReport(baseline, absolute);
  await appendToRegistry(baseline, baselineDir, resolve(cwd, baselineDir), cwd);
  return written;
}

/** Read a baseline from disk, with a readable error. */
export async function readBaseline(path: string): Promise<Baseline> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new BaselineError(`Baseline not found: ${path}.`, path);
    throw new BaselineError(`Baseline could not be read: ${(error as Error).message}`, path);
  }
  try {
    return validateBaselineDocument(JSON.parse(text) as unknown, path);
  } catch (error) {
    if (error instanceof BaselineError) throw error;
    throw new BaselineError(`Baseline is not valid JSON: ${(error as Error).message}`, path);
  }
}

/** Structural validation of a stored baseline. */
export function validateBaselineDocument(value: unknown, path: string): Baseline {
  const fail = (message: string): never => {
    throw new BaselineError(`Baseline is invalid: ${message}`, path);
  };

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail('root must be a JSON object.');
  }
  const record = value as Record<string, unknown>;
  if (record['schemaVersion'] !== BASELINE_SCHEMA_VERSION) {
    return fail(`unsupported schemaVersion "${String(record['schemaVersion'])}".`);
  }
  if (typeof record['baselineId'] !== 'string' || record['baselineId'].trim() === '') {
    return fail('baselineId is missing.');
  }
  if (record['status'] !== 'known-good' && record['status'] !== 'known-good-partial' && record['status'] !== 'known-good-declared') {
    return fail('status must be "known-good", "known-good-partial", or "known-good-declared".');
  }
  if (record['confirmation'] === undefined) {
    return fail('the operator confirmation block is missing.');
  }
  if (record['identity'] === undefined) {
    return fail('the identity block is missing.');
  }
  if (!Array.isArray(record['knownSignals'])) {
    return fail('knownSignals must be an array.');
  }
  return value as unknown as Baseline;
}

/** Read the registry, treating a missing file as an empty registry. */
export async function readRegistry(baselineDir: string, cwd: string = process.cwd()): Promise<BaselineRegistry> {
  const path = join(resolve(cwd, baselineDir), BASELINE_REGISTRY_FILE);
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as BaselineRegistry;
    if (!Array.isArray(parsed.baselines)) return { schemaVersion: BASELINE_SCHEMA_VERSION, baselines: [] };
    return parsed;
  } catch {
    return { schemaVersion: BASELINE_SCHEMA_VERSION, baselines: [] };
  }
}

/**
 * Append a baseline to the registry.
 *
 * The registry is a convenience index, not the source of truth - the baseline
 * files are. It is rebuilt from the existing list rather than mutated in place.
 */
async function appendToRegistry(
  baseline: Baseline,
  baselineDir: string,
  absoluteDir: string,
  cwd: string,
): Promise<void> {
  const registry = await readRegistry(baselineDir, cwd);
  if (registry.baselines.some((entry) => entry.baselineId === baseline.baselineId)) return;

  registry.baselines.push({
    baselineId: baseline.baselineId,
    name: baseline.name,
    report: `${baselineDir}/${baseline.baselineId}.json`,
    createdAt: baseline.createdAt,
    targetOrigin: baseline.identity.targetOrigin,
    environmentFingerprint: baseline.identity.environmentFingerprint,
  });
  // Sorted so the index does not depend on creation order.
  registry.baselines.sort((a, b) => a.baselineId.localeCompare(b.baselineId));
  await writeReport(registry, join(absoluteDir, BASELINE_REGISTRY_FILE), cwd);
}

/** Re-exported so callers need not import two modules for one reference. */
export { toEnvironmentReference };
