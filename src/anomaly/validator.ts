/**
 * Input loading and validation.
 *
 * Build 4 reads two local JSON artifacts and validates both before analysing
 * anything. The rule is that invalid input must produce a clear error rather
 * than misleading output: an anomaly report built on a half-parsed execution
 * report is worse than no report.
 *
 * Validation is structural, reusing Build 3's execution types and Build 2's
 * journey types rather than redeclaring them. A report that is valid but has
 * no evidence is *not* an error - it produces an empty, valid anomaly report
 * with a warning.
 */

import { readFile } from 'node:fs/promises';
import type { ExecutionReport, StepExecutionResult } from '../executor/types.js';
import type { JourneyPlan } from '../journey/types.js';
import type { AnomalyReport } from './report.js';
import { ANOMALY_SCHEMA_VERSION } from './types.js';
import {
  AnomalyInputError,
  SUPPORTED_ANOMALY_JOURNEY_SCHEMA_VERSIONS,
  SUPPORTED_EXECUTION_SCHEMA_VERSIONS,
} from './types.js';

/** True for a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read and parse a JSON file, with a readable error on failure. */
async function readJson(path: string, label: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new AnomalyInputError(path, `${label} report not found: ${path}.`);
    }
    if (code === 'EISDIR') {
      throw new AnomalyInputError(path, `${label} report path is a directory: ${path}.`);
    }
    throw new AnomalyInputError(path, `${label} report could not be read: ${(error as Error).message}`);
  }

  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new AnomalyInputError(path, `${label} report is not valid JSON: ${(error as Error).message}`);
  }
}

/**
 * Load and validate a single execution report.
 *
 * Added for Build 6, which needs one report at a time. It reuses the existing
 * validation rather than restating it, so the two cannot drift apart.
 */
export async function loadExecutionInput(path: string): Promise<ExecutionReport> {
  return validateExecutionReport(await readJson(path, 'Execution'), path);
}

/**
 * Load and validate a single anomaly report.
 *
 * Build 6's baseline and review commands both need this, and a report that
 * cannot be read is a refusal rather than an empty result.
 */
export async function loadAnomalyInput(path: string): Promise<AnomalyReport> {
  const value = await readJson(path, 'Anomaly');
  if (!isRecord(value)) {
    throw new AnomalyInputError(path, 'Anomaly report root must be a JSON object.');
  }
  if (value['schemaVersion'] !== ANOMALY_SCHEMA_VERSION) {
    throw new AnomalyInputError(
      path,
      `Unsupported anomaly report schemaVersion "${String(value['schemaVersion'])}".`,
    );
  }
  if (!Array.isArray(value['anomalies'])) {
    throw new AnomalyInputError(path, 'Anomaly report is missing an anomalies array.');
  }
  return value as unknown as AnomalyReport;
}

/**
 * Validate an execution report for analysis.
 *
 * Only the fields the rules actually read are required. A report missing
 * optional evidence arrays is valid; the analyzer records a warning instead.
 */
export function validateExecutionReport(value: unknown, path: string): ExecutionReport {
  if (!isRecord(value)) {
    throw new AnomalyInputError(path, 'Execution report root must be a JSON object.');
  }

  const schemaVersion = value['schemaVersion'];
  if (typeof schemaVersion !== 'string') {
    throw new AnomalyInputError(path, 'Execution report is missing a string schemaVersion.');
  }
  if (!(SUPPORTED_EXECUTION_SCHEMA_VERSIONS as readonly string[]).includes(schemaVersion)) {
    throw new AnomalyInputError(
      path,
      `Unsupported execution report schemaVersion "${schemaVersion}". ` +
        `The anomaly engine supports ${SUPPORTED_EXECUTION_SCHEMA_VERSIONS.join(', ')}.`,
    );
  }

  if (typeof value['goal'] !== 'string') {
    throw new AnomalyInputError(path, 'Execution report is missing a goal.');
  }
  if (typeof value['journeyType'] !== 'string') {
    throw new AnomalyInputError(path, 'Execution report is missing a journeyType.');
  }
  if (typeof value['status'] !== 'string') {
    throw new AnomalyInputError(path, 'Execution report is missing a status.');
  }

  const target = value['target'];
  if (!isRecord(target) || typeof target['url'] !== 'string') {
    throw new AnomalyInputError(path, 'Execution report is missing target.url.');
  }

  const steps = value['steps'];
  if (!Array.isArray(steps)) {
    throw new AnomalyInputError(path, 'Execution report is missing a steps array.');
  }

  const seenStepIds = new Set<string>();
  for (const step of steps) {
    if (!isRecord(step) || typeof step['id'] !== 'string' || step['id'].trim() === '') {
      throw new AnomalyInputError(path, 'Execution report contains a step with no id.');
    }
    if (seenStepIds.has(step['id'])) {
      throw new AnomalyInputError(path, `Execution report contains duplicate step id "${step['id']}".`);
    }
    seenStepIds.add(step['id']);
  }

  // Raw evidence is optional. When present it must still be shaped correctly,
  // so a malformed array is reported rather than silently ignored.
  const rawEvidence = value['rawEvidence'];
  if (rawEvidence !== undefined) {
    if (!isRecord(rawEvidence)) {
      throw new AnomalyInputError(path, 'Execution report rawEvidence must be an object when present.');
    }
    for (const key of ['consoleEvents', 'pageErrors', 'networkEvents', 'screenshots']) {
      const list = rawEvidence[key];
      if (list !== undefined && !Array.isArray(list)) {
        throw new AnomalyInputError(path, `Execution report rawEvidence.${key} must be an array when present.`);
      }
    }
  }

  return value as unknown as ExecutionReport;
}

/** Validate a journey plan, for origin and step context only. */
export function validateJourneyReport(value: unknown, path: string): JourneyPlan {
  if (!isRecord(value)) {
    throw new AnomalyInputError(path, 'Journey report root must be a JSON object.');
  }

  const schemaVersion = value['schemaVersion'];
  if (typeof schemaVersion !== 'string') {
    throw new AnomalyInputError(path, 'Journey report is missing a string schemaVersion.');
  }
  if (!(SUPPORTED_ANOMALY_JOURNEY_SCHEMA_VERSIONS as readonly string[]).includes(schemaVersion)) {
    throw new AnomalyInputError(
      path,
      `Unsupported journey report schemaVersion "${schemaVersion}". ` +
        `The anomaly engine supports ${SUPPORTED_ANOMALY_JOURNEY_SCHEMA_VERSIONS.join(', ')}.`,
    );
  }

  if (typeof value['goal'] !== 'string' || value['goal'].trim() === '') {
    throw new AnomalyInputError(path, 'Journey report is missing a goal.');
  }
  if (typeof value['journeyType'] !== 'string') {
    throw new AnomalyInputError(path, 'Journey report is missing a journeyType.');
  }
  if (!isRecord(value['target']) || typeof (value['target'] as Record<string, unknown>)['url'] !== 'string') {
    throw new AnomalyInputError(path, 'Journey report is missing target.url.');
  }
  if (!Array.isArray(value['steps'])) {
    throw new AnomalyInputError(path, 'Journey report is missing a steps array.');
  }

  return value as unknown as JourneyPlan;
}

/** Load and validate both input artifacts. */
export async function loadAnalysisInputs(
  executionPath: string,
  journeyPath: string,
): Promise<{ execution: ExecutionReport; journey: JourneyPlan }> {
  const execution = validateExecutionReport(await readJson(executionPath, 'Execution'), executionPath);
  const journey = validateJourneyReport(await readJson(journeyPath, 'Journey'), journeyPath);
  return { execution, journey };
}

/** Steps, sorted by order, for deterministic rule evaluation. */
export function orderedSteps(execution: ExecutionReport): StepExecutionResult[] {
  if (!Array.isArray(execution.steps)) return [];
  return [...execution.steps].sort((a, b) => {
    const orderA = typeof a.order === 'number' ? a.order : 0;
    const orderB = typeof b.order === 'number' ? b.order : 0;
    return orderA - orderB || a.id.localeCompare(b.id);
  });
}
