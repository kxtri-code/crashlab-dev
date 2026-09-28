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
import { buildBaseline, writeBaseline } from '../baseline/writer.js';
import { assertBaselineCandidate, validateBaselineCandidate } from '../baseline/validator.js';
import { sanitizeIdentifier, safeVersion } from '../provenance/redaction.js';
import { BaselineError, DEFAULT_BASELINE_DIR } from '../baseline/types.js';
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
  '--baseline-dir',
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
  baselineDir: string;
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
    baselineDir: DEFAULT_BASELINE_DIR,
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

Baselines are immutable. A duplicate id is refused rather than overwritten.

Build 6 opens no browser, makes no network call, and uses no AI.`;

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

  const validation = validateBaselineCandidate({
    execution,
    anomalies,
    journey,
    acceptedSignalIds: args.acceptedSignalIds,
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
      baselineDir: args.baselineDir,
    });

    const written = await writeBaseline(baseline, args.baselineDir);

    console.log('CRASHLAB SCOUT - BASELINE REGISTRY v0.1.0');
    console.log('');
    console.log(`  Baseline ID:    ${baseline.baselineId}`);
    console.log(`  Name:           ${baseline.name}`);
    console.log(`  Status:         ${baseline.status}`);
    console.log(`  Target origin:  ${baseline.identity.targetOrigin ?? '(unknown)'}`);
    console.log(`  Journey hash:   ${baseline.identity.journeyHash}`);
    console.log(`  Environment:    ${baseline.identity.environmentFingerprint ?? '(no provenance)'}`);
    console.log(`  Known signals:  ${baseline.knownSignals.length}`);
    console.log(`  Accepted:       ${baseline.confirmation.acceptedSignalIds.length}`);
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
