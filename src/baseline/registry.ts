/**
 * Baseline registry listing, querying, and selection logic.
 *
 * File-based and deterministic. Build 7 adds continuous baseline lineage
 * tracking, listing with filters, and deliberate baseline selection
 * (explicit or latest-compatible).
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { readBaseline, readRegistry } from './writer.js';
import { BaselineError, DEFAULT_BASELINE_DIR, MAX_LINEAGE_DEPTH } from './types.js';
import type { Baseline, BaselineIdentity, BaselineRegistryEntry } from './types.js';
import { validateBaselineId } from './validator.js';
import { checkCompatibility } from '../review/compatibility.js';
import type { CandidateBaselineDecision } from '../review/types.js';

/** Options for filtering baselines in list mode. */
export interface BaselineListFilters {
  targetOrigin?: string | null;
  journeyHash?: string | null;
  applicationBuildId?: string | null;
  status?: string | null;
  verificationCoverage?: string | null;
}

/** Options for querying the baseline registry. */
export interface ListBaselinesOptions {
  baselineDir?: string;
  filters?: BaselineListFilters;
  cwd?: string;
}

/**
 * Resolve a baseline reference (which may be a path or a baseline ID) to an absolute path.
 */
export function resolveBaselinePath(
  idOrPath: string,
  baselineDir: string = DEFAULT_BASELINE_DIR,
  cwd: string = process.cwd(),
): string {
  if (!idOrPath || typeof idOrPath !== 'string' || idOrPath.trim() === '') {
    throw new BaselineError('Baseline identifier or path must not be empty.');
  }
  const trimmed = idOrPath.trim();
  if (/[\x00-\x1f\x7f]/.test(trimmed)) {
    throw new BaselineError('Baseline identifier or path must not contain control characters.');
  }
  if (trimmed.endsWith('.json')) {
    return resolve(cwd, trimmed);
  }
  // It is treated as an explicit baseline ID
  validateBaselineId(trimmed);
  return resolve(cwd, baselineDir, `${trimmed}.json`);
}

/**
 * Filter and deterministically sort baseline registry entries.
 *
 * Sort order:
 *  1. `createdAt` descending (newest first)
 *  2. `baselineId` ascending (alphabetical tie-breaker)
 */
export function filterAndSortBaselines(
  entries: readonly BaselineRegistryEntry[],
  filters: BaselineListFilters = {},
): BaselineRegistryEntry[] {
  let filtered = [...entries];

  if (filters.targetOrigin) {
    filtered = filtered.filter((entry) => entry.targetOrigin === filters.targetOrigin);
  }
  if (filters.journeyHash) {
    filtered = filtered.filter((entry) => entry.journeyHash === filters.journeyHash);
  }
  if (filters.applicationBuildId) {
    filtered = filtered.filter((entry) => entry.applicationBuildId === filters.applicationBuildId);
  }
  if (filters.status) {
    filtered = filtered.filter((entry) => entry.status === filters.status);
  }
  if (filters.verificationCoverage) {
    filtered = filtered.filter((entry) => entry.verificationCoverage === filters.verificationCoverage);
  }

  return filtered.sort((a, b) => {
    const timeDiff = b.createdAt.localeCompare(a.createdAt);
    if (timeDiff !== 0) return timeDiff;
    return a.baselineId.localeCompare(b.baselineId);
  });
}

/**
 * List baselines from the registry with optional filters.
 */
export async function listBaselines(options: ListBaselinesOptions = {}): Promise<BaselineRegistryEntry[]> {
  const baselineDir = options.baselineDir ?? DEFAULT_BASELINE_DIR;
  const cwd = options.cwd ?? process.cwd();
  const registry = await readRegistry(baselineDir, cwd);
  return filterAndSortBaselines(registry.baselines, options.filters);
}

/** Result of resolving the latest compatible baseline. */
export interface LatestCompatibleResult {
  selectedBaseline: Baseline | null;
  candidateDecisions: CandidateBaselineDecision[];
}

/**
 * Find the latest compatible baseline for a given run identity.
 *
 * Steps:
 *  1. Enumerate candidate baselines from registry.
 *  2. Load and validate each candidate baseline document.
 *  3. Check compatibility against current identity using `checkCompatibility`.
 *  4. Record every decision (compatible / incompatible reason).
 *  5. Pick newest compatible baseline deterministically (createdAt desc, baselineId asc).
 */
export async function findLatestCompatibleBaseline(
  currentIdentity: BaselineIdentity,
  baselineDir: string = DEFAULT_BASELINE_DIR,
  cwd: string = process.cwd(),
): Promise<LatestCompatibleResult> {
  const registry = await readRegistry(baselineDir, cwd);
  const candidateDecisions: CandidateBaselineDecision[] = [];
  const compatibleList: { baseline: Baseline; report: string; createdAt: string }[] = [];

  // Enumerate in deterministic order
  const sortedEntries = [...registry.baselines].sort((a, b) => a.baselineId.localeCompare(b.baselineId));

  for (const entry of sortedEntries) {
    const path = resolveBaselinePath(entry.baselineId, baselineDir, cwd);
    let baseline: Baseline;
    try {
      baseline = await readBaseline(path);
    } catch (error) {
      candidateDecisions.push({
        baselineId: entry.baselineId,
        report: entry.report,
        compatible: false,
        reason: `Failed to load baseline: ${(error as Error).message}`,
        createdAt: entry.createdAt,
      });
      continue;
    }

    const comp = checkCompatibility(currentIdentity, baseline);
    const isCompatible = comp.comparable;
    candidateDecisions.push({
      baselineId: baseline.baselineId,
      report: entry.report,
      compatible: isCompatible,
      reason: isCompatible ? null : comp.reason,
      createdAt: baseline.createdAt,
    });

    if (isCompatible) {
      compatibleList.push({
        baseline,
        report: entry.report,
        createdAt: baseline.createdAt,
      });
    }
  }

  if (compatibleList.length === 0) {
    return { selectedBaseline: null, candidateDecisions };
  }

  // Pick newest compatible baseline; tie-break with lineage depth, then baselineId
  compatibleList.sort((a, b) => {
    const timeDiff = b.createdAt.localeCompare(a.createdAt);
    if (timeDiff !== 0) return timeDiff;
    const depthDiff = (b.baseline.lineage?.depth ?? 0) - (a.baseline.lineage?.depth ?? 0);
    if (depthDiff !== 0) return depthDiff;
    return a.baseline.baselineId.localeCompare(b.baseline.baselineId);
  });

  return {
    selectedBaseline: compatibleList[0]?.baseline ?? null,
    candidateDecisions,
  };
}

/**
 * Safely load ancestor baselines for a given baseline, traversing parent pointers.
 *
 * Protects against cycles and bounds traversal depth to MAX_LINEAGE_DEPTH.
 */
export async function loadBaselineAncestry(
  baseline: Baseline,
  baselineDir: string = DEFAULT_BASELINE_DIR,
  maxDepth: number = MAX_LINEAGE_DEPTH,
  cwd: string = process.cwd(),
): Promise<Baseline[]> {
  const ancestors: Baseline[] = [];
  const seen = new Set<string>([baseline.baselineId]);
  let currentParentId = baseline.parentBaselineId;

  while (currentParentId !== null && ancestors.length < maxDepth) {
    if (seen.has(currentParentId)) break;
    seen.add(currentParentId);

    const parentPath = resolveBaselinePath(currentParentId, baselineDir, cwd);
    try {
      const parentBaseline = await readBaseline(parentPath);
      ancestors.push(parentBaseline);
      currentParentId = parentBaseline.parentBaselineId;
    } catch {
      break;
    }
  }

  return ancestors;
}
