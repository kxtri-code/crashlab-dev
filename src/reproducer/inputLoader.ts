/**
 * Reproduction input loading and validation.
 *
 * Everything is validated *before* a browser is opened, so an unusable input
 * can never start a rerun. The anomaly report is validated against the shape
 * Build 4 actually writes, and the journey against Build 2's.
 */

import { readFile } from 'node:fs/promises';
import type { Anomaly } from '../anomaly/types.js';
import type { AnomalyReport } from '../anomaly/report.js';
import type { JourneyPlan } from '../journey/types.js';
import {
  MAX_ATTEMPTS,
  MIN_ATTEMPTS,
  ReproductionInputError,
  SUPPORTED_ANOMALY_SCHEMA_VERSIONS,
  SUPPORTED_REPRODUCER_JOURNEY_SCHEMA_VERSIONS,
} from './types.js';

/** True for a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read and parse JSON, with a readable error. */
async function readJson(path: string, label: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new ReproductionInputError(path, `${label} report not found: ${path}.`);
    if (code === 'EISDIR') throw new ReproductionInputError(path, `${label} report path is a directory: ${path}.`);
    throw new ReproductionInputError(path, `${label} report could not be read: ${(error as Error).message}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ReproductionInputError(path, `${label} report is not valid JSON: ${(error as Error).message}`);
  }
}

/**
 * Validate an anomaly report.
 *
 * Requires the fields the reproducer reads: the schema version, the signal
 * list, and enough of each signal to build a matching key.
 */
export function validateAnomalyReport(value: unknown, path: string): AnomalyReport {
  if (!isRecord(value)) {
    throw new ReproductionInputError(path, 'Anomaly report root must be a JSON object.');
  }

  const schemaVersion = value['schemaVersion'];
  if (typeof schemaVersion !== 'string') {
    throw new ReproductionInputError(path, 'Anomaly report is missing a string schemaVersion.');
  }
  if (!(SUPPORTED_ANOMALY_SCHEMA_VERSIONS as readonly string[]).includes(schemaVersion)) {
    throw new ReproductionInputError(
      path,
      `Unsupported anomaly report schemaVersion "${schemaVersion}". ` +
        `The reproducer supports ${SUPPORTED_ANOMALY_SCHEMA_VERSIONS.join(', ')}.`,
    );
  }

  const anomalies = value['anomalies'];
  if (!Array.isArray(anomalies)) {
    throw new ReproductionInputError(path, 'Anomaly report is missing an anomalies array.');
  }

  const seen = new Set<string>();
  for (const [index, anomaly] of anomalies.entries()) {
    if (!isRecord(anomaly)) {
      throw new ReproductionInputError(path, `Anomaly at position ${index} is not an object.`);
    }
    if (typeof anomaly['id'] !== 'string' || anomaly['id'].trim() === '') {
      throw new ReproductionInputError(path, `Anomaly at position ${index} has no id.`);
    }
    if (seen.has(anomaly['id'])) {
      throw new ReproductionInputError(path, `Anomaly report contains duplicate anomaly id "${anomaly['id']}".`);
    }
    seen.add(anomaly['id']);
    if (typeof anomaly['ruleId'] !== 'string') {
      throw new ReproductionInputError(path, `Anomaly "${anomaly['id']}" has no ruleId.`);
    }
  }

  return value as unknown as AnomalyReport;
}

/** Validate the journey plan the attempts will run. */
export function validateJourneyReport(value: unknown, path: string): JourneyPlan {
  if (!isRecord(value)) {
    throw new ReproductionInputError(path, 'Journey report root must be a JSON object.');
  }
  const schemaVersion = value['schemaVersion'];
  if (typeof schemaVersion !== 'string') {
    throw new ReproductionInputError(path, 'Journey report is missing a string schemaVersion.');
  }
  if (!(SUPPORTED_REPRODUCER_JOURNEY_SCHEMA_VERSIONS as readonly string[]).includes(schemaVersion)) {
    throw new ReproductionInputError(
      path,
      `Unsupported journey report schemaVersion "${schemaVersion}". ` +
        `The reproducer supports ${SUPPORTED_REPRODUCER_JOURNEY_SCHEMA_VERSIONS.join(', ')}.`,
    );
  }
  if (typeof value['goal'] !== 'string' || value['goal'].trim() === '') {
    throw new ReproductionInputError(path, 'Journey report is missing a goal.');
  }
  if (!isRecord(value['target']) || typeof (value['target'] as Record<string, unknown>)['url'] !== 'string') {
    throw new ReproductionInputError(path, 'Journey report is missing target.url.');
  }
  if (!Array.isArray(value['steps'])) {
    throw new ReproductionInputError(path, 'Journey report is missing a steps array.');
  }
  return value as unknown as JourneyPlan;
}

/**
 * Validate a requested attempt count.
 *
 * Rejects out-of-range values rather than clamping them, so a caller who asks
 * for 50 finds out rather than silently running 5.
 */
export function validateAttempts(value: number): number {
  if (!Number.isInteger(value)) {
    throw new ReproductionInputError('attempts', `Attempt count must be a whole number, got ${value}.`);
  }
  if (value < MIN_ATTEMPTS) {
    throw new ReproductionInputError('attempts', `Attempt count must be at least ${MIN_ATTEMPTS}, got ${value}.`);
  }
  if (value > MAX_ATTEMPTS) {
    throw new ReproductionInputError(
      'attempts',
      `Attempt count must be at most ${MAX_ATTEMPTS}, got ${value}. Reproduction is deliberately bounded.`,
    );
  }
  return value;
}

/** Load and validate the anomaly report and the journey plan. */
export async function loadReproductionInputs(
  anomalyPath: string,
  journeyPath: string,
): Promise<{ anomalies: AnomalyReport; journey: JourneyPlan }> {
  const anomalies = validateAnomalyReport(await readJson(anomalyPath, 'Anomaly'), anomalyPath);
  const journey = validateJourneyReport(await readJson(journeyPath, 'Journey'), journeyPath);
  return { anomalies, journey };
}

/** The signals in an anomaly report, in the order they were written. */
export function signalsOf(report: AnomalyReport): Anomaly[] {
  return Array.isArray(report.anomalies) ? report.anomalies : [];
}
