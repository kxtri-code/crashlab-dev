/**
 * The `baseline` command.
 *
 * Creates an explicit known-good record. The run is never inferred to be good:
 * `--confirm-known-good` is required, and a run that is incomplete, blocked or
 * carrying unresolved errors is refused with reasons.
 *
 * Opens no browser and makes no network call. It reads three local reports and
 * writes a baseline file.
 *
 * Exits:
 *   0  baseline created
 *   1  refused (no confirmation, unsafe run, duplicate id, invalid input)
 *   2  bad arguments
 */

import { relative } from 'node:path';
import process from 'node:process';
import { flagValue, scanArgs } from './args.js';
import { loadJourneyPlan } from '../executor/planValidator.js';
import { loadAnomalyInput, loadExecutionInput } from '../anomaly/validator.js';
import { buildBaseline, readBaseline, writeBaseline } from '../baseline/writer.js';
import { assertBaselineCandidate, validateBaselineCandidate } from '../baseline/validator.js';
import { sanitizeIdentifier, safeVersion } from '../provenance/redaction.js';
import { BaselineError, DEFAULT_BASELINE_DIR } from '../baseline/types.js';
import type { Baseline } from '../baseline/types.js';
import { listBaselines, resolveBaselinePath } from '../baseline/registry.js';
import { TOOL_NAME, TOOL_VERSION } from '../version.js';

/** Flags this command understands. */
export const BASELINE_FLAGS = [
  '--execution',
  '--anomalies',
  '--journey',
  '--baseline-id',
  '--name',
  '--accept-signal',
  '--confirmed-by',
  '--confirm-known-good',
  '--allow-unverified-assertions',
  '--allow-declared-expectations',
  '--baseline-dir',
  '--parent-baseline',
  '--list',
  '--filter-origin',
  '--filter-journey',
  '--filter-build',
  '--filter-status',
  '--filter-coverage',
] as const;

/** Parsed `baseline` arguments. Pure, so it is unit-testable. */
export interface ParsedBaselineArgs {
  executionPath: string;
  anomaliesPath: string;
  journeyPath: string;
  baselineId: string | null;
  name: string | null;
  acceptedSignalIds: string[];
  confirmedBy: string | null;
  /** The gate. Absent means no baseline is created. */
  confirmKnownGood: boolean;
  /**
   * Build 6.1: allows a partially verified run to become a
   * `known-good-partial` baseline. Never overrides a failed or blocked run.
   */
  allowUnverifiedAssertions: boolean;
  /**
   * Build 6.5: allows a run that used operator-declared expectations to become
   * a `known-good-declared` baseline. Requires --confirm-known-good.
   */
  allowDeclaredExpectations: boolean;
  baselineDir: string;
  parentBaseline: string | null;
  list: boolean;
  filterOrigin: string | null;
  filterJourney: string | null;
  filterBuild: string | null;
  filterStatus: string | null;
  filterCoverage: string | null;
  valid: boolean;
  error: string | null;
  unknown: string[];
}

/** Parse `argv` for the `baseline` command. */
export function parseBaselineArgs(argv: readonly string[]): ParsedBaselineArgs {
  const scan = scanArgs(argv);
  const parsed: ParsedBaselineArgs = {
    executionPath: process.env.CRASHLAB_EXECUTION_INPUT?.trim() || 'reports/execution.json',
    anomaliesPath: process.env.CRASHLAB_ANOMALY_INPUT?.trim() || 'reports/anomalies.json',
    journeyPath: process.env.CRASHLAB_JOURNEY_INPUT?.trim() || 'reports/journey.json',
    baselineId: null,
    name: null,
    acceptedSignalIds: [],
    confirmedBy: null,
    confirmKnownGood: false,
    allowUnverifiedAssertions: false,
    allowDeclaredExpectations: false,
    baselineDir: DEFAULT_BASELINE_DIR,
    parentBaseline: null,
    list: false,
    filterOrigin: null,
    filterJourney: null,
    filterBuild: null,
    filterStatus: null,
    filterCoverage: null,
    valid: true,
    error: null,
    unknown: [...scan.flags.keys()].filter((flag) => !(BASELINE_FLAGS as readonly string[]).includes(flag)),
  };

  if (parsed.unknown.length > 0) {
    parsed.error = `Unknown option: ${parsed.unknown[0]}. Run with --help to see the supported options.`;
    parsed.valid = false;
    return parsed;
  }

  const requireValue = (names: readonly string[]): string | null => {
    const found = flagValue(scan, names);
    if (!found.present) return null;
    if (found.missingValue) {
      parsed.error = `Option ${names[0]} requires a value.`;
      parsed.valid = false;
      return null;
    }
    return found.value;
  };

  const execution = requireValue(['--execution']);
  if (execution !== null) parsed.executionPath = execution;
  const anomalies = requireValue(['--anomalies']);
  if (anomalies !== null) parsed.anomaliesPath = anomalies;
  const journey = requireValue(['--journey']);
  if (journey !== null) parsed.journeyPath = journey;
  parsed.name = requireValue(['--name']);
  parsed.confirmedBy = requireValue(['--confirmed-by']);
  const baselineDir = requireValue(['--baseline-dir']);
  if (baselineDir !== null) parsed.baselineDir = baselineDir;
  parsed.parentBaseline = requireValue(['--parent-baseline']);
  parsed.filterOrigin = requireValue(['--filter-origin']);
  parsed.filterJourney = requireValue(['--filter-journey']);
  parsed.filterBuild = requireValue(['--filter-build']);
  parsed.filterStatus = requireValue(['--filter-status']);
  parsed.filterCoverage = requireValue(['--filter-coverage']);
  parsed.list = scan.flags.has('--list');

  // --accept-signal is repeatable, so every occurrence is collected.
  for (const [flag, value] of scan.flags) {
    if (flag !== '--accept-signal') continue;
    if (value === null) {
      parsed.error = 'Option --accept-signal requires a value.';
      parsed.valid = false;
      return parsed;
    }
    parsed.acceptedSignalIds.push(value);
  }
  parsed.acceptedSignalIds.sort();

  parsed.confirmKnownGood = scan.flags.has('--confirm-known-good');
  parsed.allowUnverifiedAssertions = scan.flags.has('--allow-unverified-assertions');
  parsed.allowDeclaredExpectations = scan.flags.has('--allow-declared-expectations');

  // The allowance is not a confirmation: allowing a partial run still requires
  // a human to say the state is known-good.
  if (parsed.allowUnverifiedAssertions && !parsed.confirmKnownGood) {
    parsed.error =
      'Refusing to create a baseline: --allow-unverified-assertions requires --confirm-known-good. ' +
      'Allowing a partially verified run is not the same as approving it.';
    parsed.valid = false;
    return parsed;
  }

  // Build 6.5: declared expectations are a separate trust model and require
  // the same explicit approval.
  if (parsed.allowDeclaredExpectations && !parsed.confirmKnownGood) {
    parsed.error =
      'Refusing to create a baseline: --allow-declared-expectations requires --confirm-known-good. ' +
      'Allowing operator-declared expectations is not the same as approving the baseline.';
    parsed.valid = false;
    return parsed;
  }

  // The baseline id is sanitized, so an unsafe one is refused rather than
  // written. It is a filename, so a path or a credential must never become one.
  try {
    parsed.baselineId = sanitizeIdentifier(flagValue(scan, ['--baseline-id']).value, 'baseline ID');
  } catch (error) {
    parsed.error = (error as Error).message;
    parsed.valid = false;
  }

  return parsed;
}

/** Prefer a repo-relative path in terminal output. */
function toDisplayPath(absolutePath: string): string {
  const rel = relative(process.cwd(), absolutePath);
  return rel && !rel.startsWith('..') ? rel : absolutePath;
}

export const BASELINE_USAGE = `${TOOL_NAME} v${TOOL_VERSION}

Usage:
  npm run baseline -- \\
    --execution reports/execution.json \\
    --anomalies reports/anomalies.json \\
    --journey reports/journey.json \\
    --baseline-id <id> \\
    --name "<name>" \\
    --confirm-known-good

Records an explicit known-good state that later runs are compared against.

Options:
  --execution <path>       Execution report
  --anomalies <path>       Anomaly report
  --journey <path>         Journey plan
  --baseline-id <id>       Safe identifier; becomes the file name
  --name "<text>"          Human-readable baseline name
  --accept-signal <id>     Accept a known signal instead of fixing it.
                           Repeatable. Never inferred.
  --confirmed-by <text>    Optional operator attribution
  --baseline-dir <path>    Storage directory [default: ${DEFAULT_BASELINE_DIR}]
  --confirm-known-good     REQUIRED. A baseline records a human's judgement
                           that this state is normal; it is never inferred
                           from a green exit code.
  --allow-unverified-assertions
                           Permit a run that left prose assertions
                           unverified. The baseline is recorded as
                           known-good-partial, covering executed steps
                           only. Requires --confirm-known-good, and never
                           overrides a failed or blocked run.
  --allow-declared-expectations
                           Build 6.5: permit a run that used operator-declared
                           expectations (reports/expectations.json). The
                           baseline is recorded as known-good-declared.
                           Requires --confirm-known-good.
  --parent-baseline <path> Build 7: optional parent baseline to descend from
  --list                   Build 7: list stored baselines deterministically
  --filter-origin <origin> Filter by target origin (with --list)
  --filter-journey <hash>  Filter by journey plan hash (with --list)
  --filter-build <id>      Filter by application build ID (with --list)
  --filter-status <status> Filter by baseline status (with --list)
  --filter-coverage <cov>  Filter by verification coverage (with --list)

Baselines are immutable. A duplicate id is refused rather than overwritten.

Build 7 opens no browser, makes no network call, and uses no AI.`;

export const BASELINE_SUMMARY_NOTE =
  'A baseline records what a human accepted as normal. It is not a defect verdict and confirms nothing.';

/**
 * Run the `baseline` command.
 *
 * @returns the process exit code.
 */
export async function runBaselineCommand(argv: readonly string[]): Promise<number> {
  const args = parseBaselineArgs(argv);

  if (!args.valid) {
    console.error(args.error ?? 'Invalid arguments.');
    return 2;
  }

  // --- Build 7: list mode -------------------------------------------------
  if (args.list) {
    const baselines = await listBaselines({
      baselineDir: args.baselineDir,
      filters: {
        targetOrigin: args.filterOrigin,
        journeyHash: args.filterJourney,
        applicationBuildId: args.filterBuild,
        status: args.filterStatus,
        verificationCoverage: args.filterCoverage,
      },
    });

    console.log('CRASHLAB SCOUT - BASELINE REGISTRY v0.1.0');
    console.log('');
    console.log(`  Directory:       ${args.baselineDir}`);
    console.log(`  Baselines found: ${baselines.length}`);
    if (baselines.length > 0) {
      console.log('');
      for (const b of baselines) {
        console.log(`  ${b.baselineId.padEnd(28)} [${b.status ?? 'known-good'}] ${b.name}`);
        console.log(`      Created:   ${b.createdAt}`);
        console.log(`      Origin:    ${b.targetOrigin ?? '(unknown)'}`);
        if (b.journeyHash) console.log(`      Journey:   ${b.journeyHash}`);
        if (b.applicationBuildId) console.log(`      Build:     ${b.applicationBuildId}`);
        if (b.parentBaselineId) console.log(`      Parent:    ${b.parentBaselineId}`);
        console.log(`      Coverage:  ${b.verificationCoverage ?? 'unknown'}`);
        console.log('');
      }
    }
    return 0;
  }

  // --- gate: operator confirmation, before anything is read or written ----
  if (!args.confirmKnownGood) {
    console.error('Refusing to create a baseline: --confirm-known-good was not supplied.');
    console.error('');
    console.error('A baseline records a human judgement that this state is normal.');
    console.error('It is never inferred from a passing run, because a run that produced');
    console.error('no signals may simply have collected no evidence.');
    return 1;
  }

  if (args.baselineId === null) {
    console.error('Refusing to create a baseline: --baseline-id is required.');
    return 1;
  }

  // --- load and validate every input before writing anything --------------
  let execution;
  let anomalies;
  let journey;
  try {
    [execution, anomalies, journey] = await Promise.all([
      loadExecutionInput(args.executionPath),
      loadAnomalyInput(args.anomaliesPath),
      loadJourneyPlan(args.journeyPath),
    ]);
  } catch (error) {
    console.error(`Cannot create a baseline: ${(error as Error).message}`);
    return 1;
  }

  // --- Build 7: load optional parent baseline -----------------------------
  let parentBaseline: Baseline | null = null;
  if (args.parentBaseline !== null) {
    const parentPath = resolveBaselinePath(args.parentBaseline, args.baselineDir);
    try {
      parentBaseline = await readBaseline(parentPath);
    } catch (error) {
      console.error(`Refusing to create a baseline:\n  - Parent baseline could not be read: ${(error as Error).message}`);
      return 1;
    }
  }

  const validation = validateBaselineCandidate({
    execution,
    anomalies,
    journey,
    acceptedSignalIds: args.acceptedSignalIds,
    allowUnverifiedAssertions: args.allowUnverifiedAssertions,
    allowDeclaredExpectations: args.allowDeclaredExpectations,
    parentBaseline,
    candidateBaselineId: args.baselineId,
    paths: { execution: args.executionPath, anomalies: args.anomaliesPath, journey: args.journeyPath },
  });

  if (!validation.safe) {
    console.error('Refusing to create a baseline:');
    for (const blocker of validation.blockers) console.error(`  - ${blocker}`);
    return 1;
  }

  for (const warning of validation.warnings) {
    console.error(`  note: ${warning}`);
  }

  // --- build and store, immutably ----------------------------------------
  try {
    const baseline = buildBaseline({
      baselineId: args.baselineId,
      name: safeVersion(args.name, 'Untitled baseline'),
      execution,
      anomalies,
      journey,
      acceptedSignalIds: validation.acceptedSignalIds,
      confirmedBy: args.confirmedBy === null ? null : safeVersion(args.confirmedBy, 'operator'),
      paths: { execution: args.executionPath, anomalies: args.anomaliesPath, journey: args.journeyPath },
      allowUnverifiedAssertions: args.allowUnverifiedAssertions,
      allowDeclaredExpectations: args.allowDeclaredExpectations,
      parentBaseline,
      baselineDir: args.baselineDir,
    });

    const written = await writeBaseline(baseline, args.baselineDir);

    console.log('CRASHLAB SCOUT - BASELINE REGISTRY v0.1.0');
    console.log('');
    console.log(`  Baseline ID:    ${baseline.baselineId}`);
    console.log(`  Name:           ${baseline.name}`);
    console.log(`  Status:         ${baseline.status}`);
    console.log(`  Verified:       ${baseline.verification.coverage}${baseline.verification.complete ? '' : ' (partial)'}`);
    console.log(`  Target origin:  ${baseline.identity.targetOrigin ?? '(unknown)'}`);
    console.log(`  Journey hash:   ${baseline.identity.journeyHash}`);
    console.log(`  Environment:    ${baseline.identity.environmentFingerprint ?? '(no provenance)'}`);
    if (baseline.parentBaselineId) {
      console.log(`  Parent ID:      ${baseline.parentBaselineId}`);
      console.log(`  Lineage depth:  ${baseline.lineage.depth}${baseline.lineage.truncated ? ' (truncated)' : ''}`);
    }
    console.log(`  Known signals:  ${baseline.knownSignals.length}`);
    console.log(`  Accepted:       ${baseline.confirmation.acceptedSignalIds.length}`);
    if (baseline.status === 'known-good-partial') {
      console.log('');
      console.log('  This baseline is NOT fully verified. It covers executed steps only,');
      console.log(`  and ${baseline.verification.unverifiedAssertions} expectation(s) remain unverified.`);
    }
    if (baseline.status === 'known-good-declared') {
      console.log('');
      console.log('  This baseline used operator-declared expectations. Coverage is "operator-declared",');
      console.log('  not "full-plan"; trust came from operator declaration, not from Scout observation.');
    }
    console.log('');
    console.log(`  ${BASELINE_SUMMARY_NOTE}`);
    console.log(`  Baseline: ${toDisplayPath(written)}`);
    return 0;
  } catch (error) {
    if (error instanceof BaselineError) {
      console.error(`Cannot create a baseline: ${error.message}`);
      return 1;
    }
    console.error(`Cannot create a baseline: ${(error as Error).message}`);
    return 1;
  }
}
