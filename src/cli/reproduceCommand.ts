/**
 * The `reproduce` command.
 *
 * Reads an anomaly report, reruns the journey a bounded number of times, and
 * reports whether each signal recurred.
 *
 * Order of operations is the safety story, and it is deliberate:
 *
 *   1. arguments are parsed and validated
 *   2. `--confirm-authorized` is checked
 *   3. the journey, anomaly and test-data files are loaded and validated
 *   4. eligibility is evaluated
 *   5. only then, and only if something is eligible, is a browser opened
 *
 * So an unauthorized or unusable invocation cannot navigate, and a run with
 * nothing eligible costs no browser at all.
 *
 * Exits:
 *   0  reproduction completed and a report was written, whatever the verdicts
 *   1  refused (no authorization) or an input was missing or invalid
 *   2  bad arguments
 */

import { relative, resolve } from 'node:path';
import process from 'node:process';
import { flagValue, scanArgs } from './args.js';
import { loadTestData } from '../executor/testData.js';
import { loadReproductionInputs, validateAttempts } from '../reproducer/inputLoader.js';
import { reproduceSignals, ReproductionRefused } from '../reproducer/reproducer.js';
import {
  DEFAULT_REPRODUCTION_OUTPUT_PATH,
  summarizeReproductionReport,
  writeReproductionReport,
} from '../reproducer/reproductionReport.js';
import { MAX_ATTEMPTS, MIN_ATTEMPTS, DEFAULT_ATTEMPTS, ReproductionInputError } from '../reproducer/types.js';
import { TOOL_NAME, TOOL_VERSION } from '../version.js';

/** Default artifact directory for rerun reports. */
export const DEFAULT_REPRODUCTION_DIR = 'reports/reproduction';

/** Flags this command understands. */
export const REPRODUCE_FLAGS = [
  '--anomalies',
  '--journey',
  '--data',
  '--output',
  '--out',
  '-o',
  '--attempts',
  '--timeout',
  '--headed',
  '--include-possibly-expected',
  '--confirm-authorized',
] as const;

/** Parsed `reproduce` arguments. Pure, so it is unit-testable. */
export interface ParsedReproduceArgs {
  anomalyPath: string;
  journeyPath: string;
  dataPath: string | null;
  outputPath: string;
  attempts: number;
  timeoutMs: number | undefined;
  headed: boolean;
  includePossiblyExpected: boolean;
  /** The safety gate. Absent means the run is refused. */
  confirmAuthorized: boolean;
  valid: boolean;
  error: string | null;
  unknown: string[];
}

/** Parse `argv` for the `reproduce` command. */
export function parseReproduceArgs(argv: readonly string[]): ParsedReproduceArgs {
  const scan = scanArgs(argv);
  const parsed: ParsedReproduceArgs = {
    anomalyPath: process.env.CRASHLAB_ANOMALY_INPUT?.trim() || 'reports/anomalies.json',
    journeyPath: process.env.CRASHLAB_JOURNEY_INPUT?.trim() || 'reports/journey.json',
    dataPath: null,
    outputPath: process.env.CRASHLAB_REPRODUCTION_OUTPUT?.trim() || DEFAULT_REPRODUCTION_OUTPUT_PATH,
    attempts: DEFAULT_ATTEMPTS,
    timeoutMs: undefined,
    headed: false,
    includePossiblyExpected: false,
    confirmAuthorized: false,
    valid: true,
    error: null,
    unknown: [...scan.flags.keys()].filter((flag) => !(REPRODUCE_FLAGS as readonly string[]).includes(flag)),
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

  const anomalies = requireValue(['--anomalies']);
  if (anomalies !== null) parsed.anomalyPath = anomalies;
  const journey = requireValue(['--journey']);
  if (journey !== null) parsed.journeyPath = journey;
  const data = requireValue(['--data']);
  if (data !== null) parsed.dataPath = data;
  const output = requireValue(['--output', '--out', '-o']);
  if (output !== null) parsed.outputPath = output;

  const attempts = flagValue(scan, ['--attempts']);
  if (attempts.present) {
    if (attempts.missingValue) {
      parsed.error = 'Option --attempts requires a value.';
      parsed.valid = false;
      return parsed;
    }
    // Rejected rather than clamped: a caller asking for 50 should find out.
    try {
      parsed.attempts = validateAttempts(Number(attempts.value));
    } catch (error) {
      parsed.error = (error as Error).message;
      parsed.valid = false;
      return parsed;
    }
  }

  const timeout = flagValue(scan, ['--timeout']);
  if (timeout.present) {
    if (timeout.missingValue) {
      parsed.error = 'Option --timeout requires a value in milliseconds.';
      parsed.valid = false;
    } else {
      const value = Number(timeout.value);
      if (!Number.isFinite(value) || value < 1000) {
        parsed.error = 'Option --timeout must be a number of milliseconds of at least 1000.';
        parsed.valid = false;
      } else {
        parsed.timeoutMs = Math.trunc(value);
      }
    }
  }

  parsed.headed = scan.flags.has('--headed');
  parsed.includePossiblyExpected = scan.flags.has('--include-possibly-expected');
  parsed.confirmAuthorized = scan.flags.has('--confirm-authorized');

  return parsed;
}

/** Prefer a repo-relative path in terminal output. */
function toDisplayPath(absolutePath: string): string {
  const rel = relative(process.cwd(), absolutePath);
  return rel && !rel.startsWith('..') ? rel : absolutePath;
}

export const REPRODUCE_USAGE = `${TOOL_NAME} v${TOOL_VERSION}

Usage:
  npm run reproduce -- \\
    --anomalies reports/anomalies.json \\
    --journey reports/journey.json \\
    --attempts ${DEFAULT_ATTEMPTS} \\
    --confirm-authorized

Reruns a journey a bounded number of times and reports whether each observed
signal occurred again.

Options:
  --anomalies <path>       Anomaly report        [default: reports/anomalies.json]
  --journey <path>         Journey plan          [default: reports/journey.json]
  --data <path>            Test data, used unchanged for every attempt
  -o, --out <path>         Reproduction report   [default: ${DEFAULT_REPRODUCTION_OUTPUT_PATH}]
  --attempts <n>           Controlled attempts, ${MIN_ATTEMPTS}-${MAX_ATTEMPTS}  [default: ${DEFAULT_ATTEMPTS}]
  --timeout <ms>           Per-step executor timeout
  --headed                 Run the browser with a window
  --include-possibly-expected
                           Also rerun signals excluded by default
                           (HTTP_4XX, console warnings, duplicate requests,
                           origin changes)
  --confirm-authorized     REQUIRED. Confirms you are authorized to test the
                           target. Without it nothing is opened and nothing
                           is written.

Rerun artifacts are written under reports/reproduction/attempt-NNN/, and never
overwrite the journey, execution or anomaly reports.

Safe test mode is unconditional and there is no live-payment flag. These are
declared reproduction attempts under an explicit budget, not hidden retries.

A reproduced signal is a candidate for investigation, not a confirmed defect.
Build 5 confirms nothing: interpretation.confirmedBug is always false.`;

/**
 * Run the `reproduce` command.
 *
 * @returns the process exit code.
 */
export async function runReproduceCommand(argv: readonly string[]): Promise<number> {
  const args = parseReproduceArgs(argv);

  if (!args.valid) {
    console.error(args.error ?? 'Invalid arguments.');
    return 2;
  }

  // --- gate 1: authorization, before anything is read or opened ---------
  if (!args.confirmAuthorized) {
    console.error('Refusing to reproduce: --confirm-authorized was not supplied.');
    console.error('');
    console.error('CrashLab only runs against applications you own or are authorized to test.');
    console.error('No browser was opened and no artifact was written.');
    return 1;
  }

  // --- gate 2: validate every input before any browser ------------------
  let loaded;
  try {
    loaded = await loadReproductionInputs(args.anomalyPath, args.journeyPath);
  } catch (error) {
    if (error instanceof ReproductionInputError) {
      console.error(`Cannot reproduce: ${error.message}`);
      return 1;
    }
    console.error(`Cannot reproduce: ${(error as Error).message}`);
    return 1;
  }

  // Test data is validated before any browser opens, so a malformed file cannot
  // start a run that will only fail at the first fill.
  let testData: Record<string, string> | undefined;
  if (args.dataPath !== null) {
    try {
      testData = await loadTestData(args.dataPath);
    } catch (error) {
      console.error(`Cannot reproduce: ${(error as Error).message}`);
      return 1;
    }
  }

  // The original execution report is referenced but never rewritten. When it
  // sits beside the others it is named, so the report can point a reader at it.
  const executionPath = resolve(process.cwd(), 'reports', 'execution.json');

  console.log(`${TOOL_NAME} v${TOOL_VERSION} - Controlled Reproducer`);
  console.log(`Anomalies: ${args.anomalyPath}`);
  console.log(`Journey:   ${args.journeyPath}`);
  console.log(`Attempts:  ${args.attempts} (declared, not hidden retries)`);
  if (args.dataPath) console.log(`Test data: ${args.dataPath} (${Object.keys(testData ?? {}).length} key(s), values never logged)`);
  console.log('Safe test mode: ON (payment actions remain blocked)');

  let report;
  try {
    report = await reproduceSignals({
      anomalies: loaded.anomalies,
      journey: loaded.journey,
      testData,
      attempts: args.attempts,
      authorized: true,
      anomalyPath: args.anomalyPath,
      journeyPath: args.journeyPath,
      executionPath,
      includePossiblyExpected: args.includePossiblyExpected,
      timeoutMs: args.timeoutMs,
      headed: args.headed,
      outputDir: DEFAULT_REPRODUCTION_DIR,
    });
  } catch (error) {
    if (error instanceof ReproductionRefused) {
      console.error(`Refusing to reproduce: ${error.message}`);
      return 1;
    }
    console.error(`Reproduction failed: ${(error as Error).message}`);
    return 1;
  }

  const absolutePath = await writeReproductionReport(report, args.outputPath);

  console.log('');
  console.log(summarizeReproductionReport(report));
  console.log(`Output: ${toDisplayPath(absolutePath)}`);

  // Any verdict is a successful reproduction run. Only a refusal or a bad input
  // is a non-zero exit, and both return before reaching here.
  return 0;
}
