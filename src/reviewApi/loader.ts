/**
 * Read-only artifact loader for Review API (Build 9.1).
 *
 * Safely reads CrashLab reports, review-state history, and baseline documents
 * into memory without mutating any files on disk.
 */

import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { CandidateReport } from '../review/types.js';
import type { ReviewStateDocument, ReviewStateEvent } from '../review/reviewStateTypes.js';
import { REVIEW_STATE_EVENTS_FILE, REVIEW_STATE_PROJECTION_FILE } from '../review/reviewStateTypes.js';
import { loadEventsFile, projectReviewState } from '../review/reviewStateStore.js';
import type { Baseline, BaselineRegistryEntry } from '../baseline/types.js';
import { listBaselines } from '../baseline/registry.js';
import { readBaseline } from '../baseline/writer.js';
import type { JourneyPlan } from '../journey/types.js';
import type { ExecutionReport } from '../executor/types.js';
import type { AnomalyReport } from '../anomaly/report.js';
import type { ReproductionReport } from '../reproducer/types.js';
import type { ReviewApiPaths } from './types.js';
import type { ReviewApiData } from './queries.js';

export class ArtifactLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactLoadError';
  }
}

/** Safely read and parse a JSON file without side effects. */
async function readJsonFile<T>(path: string, label: string): Promise<T> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new ArtifactLoadError(`${label} file not found: ${path}`);
    }
    throw new ArtifactLoadError(`Could not read ${label} at "${path}": ${(error as Error).message}`);
  }

  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new ArtifactLoadError(`${label} is not valid JSON at "${path}": ${(error as Error).message}`);
  }
}

/**
 * Load all backing data artifacts into a pure ReviewApiData container.
 * Performs zero filesystem writes.
 */
export async function loadReviewApiData(paths: ReviewApiPaths, cwd: string = process.cwd()): Promise<ReviewApiData> {
  const candidatesAbs = resolve(cwd, paths.candidatesPath);
  if (!existsSync(candidatesAbs)) {
    throw new ArtifactLoadError(`Candidates report does not exist at "${candidatesAbs}".`);
  }

  const candidateReport = await readJsonFile<CandidateReport>(candidatesAbs, 'Candidates report');
  if (!candidateReport || typeof candidateReport !== 'object' || !Array.isArray(candidateReport.candidates)) {
    throw new ArtifactLoadError(`Candidates report at "${candidatesAbs}" is missing expected 'candidates' array.`);
  }

  // Review state
  const stateDirAbs = resolve(cwd, paths.reviewStateDir);
  let reviewEvents: ReviewStateEvent[] = [];
  let reviewStateDoc: ReviewStateDocument | null = null;

  if (existsSync(stateDirAbs)) {
    const eventsPath = join(stateDirAbs, REVIEW_STATE_EVENTS_FILE);
    const statePath = join(stateDirAbs, REVIEW_STATE_PROJECTION_FILE);

    if (existsSync(eventsPath)) {
      reviewEvents = await loadEventsFile(eventsPath);
    }

    if (existsSync(statePath)) {
      reviewStateDoc = await readJsonFile<ReviewStateDocument>(statePath, 'Review state projection');
    } else if (reviewEvents.length > 0) {
      // In-memory projection if events exist but state.json is absent (no file write!)
      reviewStateDoc = projectReviewState(reviewEvents);
    }
  }

  // Baselines
  const baselinesDirAbs = resolve(cwd, paths.baselinesDir);
  let baselines: BaselineRegistryEntry[] = [];
  const baselineMap = new Map<string, Baseline>();

  if (existsSync(baselinesDirAbs)) {
    try {
      baselines = await listBaselines({ baselineDir: paths.baselinesDir, cwd });
    } catch {
      baselines = [];
    }

    // Also scan all .json files in baselines dir to populate baselineMap
    try {
      const files = readdirSync(baselinesDirAbs).filter(
        (f) => f.endsWith('.json') && f !== 'registry.json',
      );
      for (const file of files) {
        try {
          const b = await readBaseline(join(baselinesDirAbs, file));
          baselineMap.set(b.baselineId, b);
        } catch {
          // Ignore invalid baseline files
        }
      }
    } catch {
      // Directory read error
    }
  }

  // Optional contextual reports
  let journey: JourneyPlan | null = null;
  if (paths.journeyPath && existsSync(resolve(cwd, paths.journeyPath))) {
    try {
      journey = await readJsonFile<JourneyPlan>(resolve(cwd, paths.journeyPath), 'Journey plan');
    } catch {
      journey = null;
    }
  }

  let execution: ExecutionReport | null = null;
  if (paths.executionPath && existsSync(resolve(cwd, paths.executionPath))) {
    try {
      execution = await readJsonFile<ExecutionReport>(resolve(cwd, paths.executionPath), 'Execution report');
    } catch {
      execution = null;
    }
  }

  let anomalies: AnomalyReport | null = null;
  if (paths.anomaliesPath && existsSync(resolve(cwd, paths.anomaliesPath))) {
    try {
      anomalies = await readJsonFile<AnomalyReport>(resolve(cwd, paths.anomaliesPath), 'Anomaly report');
    } catch {
      anomalies = null;
    }
  }

  let reproduction: ReproductionReport | null = null;
  if (paths.reproductionPath && existsSync(resolve(cwd, paths.reproductionPath))) {
    try {
      reproduction = await readJsonFile<ReproductionReport>(resolve(cwd, paths.reproductionPath), 'Reproduction report');
    } catch {
      reproduction = null;
    }
  }

  return {
    candidateReport,
    reviewStateDoc,
    reviewEvents,
    baselines,
    baselineMap,
    journey,
    execution,
    anomalies,
    reproduction,
  };
}
