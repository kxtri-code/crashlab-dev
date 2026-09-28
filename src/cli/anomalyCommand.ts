/**
 * The `anomalies` command.
 *
 * Reads `execution.json` and `journey.json`, classifies deterministic evidence
 * signals, and writes a new `reports/anomalies.json`.
 *
 * Build 4 opens no browser and makes no network call. The command reads two
 * local files and writes a third; it never modifies its inputs.
 *
 * Exits:
 *   0  analysis completed and a report was written, whether or not signals
 *      were found - finding signals is a successful analysis
 *   1  an input was missing or invalid, so no report was produced
 *   2  bad arguments
 */

import { relative } from 'node:path';
import process from 'node:process';
import { flagValue, scanArgs } from './args.js';
import { loadAnalysisInputs } from '../anomaly/validator.js';
import { AnomalyInputError } from '../anomaly/types.js';
import { DEFAULT_ANOMALY_OUTPUT_PATH, buildAnomalyReport, summarizeAnomalyReport, writeAnomalyReport } from '../anomaly/report.js';
import { SUPPORTED_ANOMALY_JOURNEY_SCHEMA_VERSIONS } from '../anomaly/types.js';
import { JOURNEY_SCHEMA_VERSION } from '../journey/types.js';
import { TOOL_NAME, TOOL_VERSION } from '../version.js';

/** Default journey plan path, matching the `journey` command. */
export const DEFAULT_JOURNEY_INPUT_PATH = 'reports/journey.json';

/** Default execution report path, matching the `execute` command. */
export const DEFAULT_EXECUTION_INPUT_PATH = 'reports/execution.json';

/** Re-exported so the usage text can name the version it validates against. */
export { JOURNEY_SCHEMA_VERSION };

/** Flags this command understands. */
export const ANOMALY_FLAGS = ['--execution', '--journey', '--output', '--out', '-o', '--include-console-warnings'] as const;

/** Parsed `anomalies` arguments. Pure, so it is unit-testable. */
export interface ParsedAnomalyArgs {
  executionPath: string;
  journeyPath: string;
  outputPath: string;
  includeConsoleWarnings: boolean;
  valid: boolean;
  error: string | null;
  unknown: string[];
}

/** Parse `argv` for the `anomalies` command. */
export function parseAnomalyArgs(argv: readonly string[]): ParsedAnomalyArgs {
  const scan = scanArgs(argv);
  const parsed: ParsedAnomalyArgs = {
    executionPath: process.env.CRASHLAB_EXECUTION_INPUT?.trim() || DEFAULT_EXECUTION_INPUT_PATH,
    journeyPath: process.env.CRASHLAB_JOURNEY_INPUT?.trim() || DEFAULT_JOURNEY_INPUT_PATH,
    outputPath: process.env.CRASHLAB_ANOMALY_OUTPUT?.trim() || DEFAULT_ANOMALY_OUTPUT_PATH,
    includeConsoleWarnings: false,
    valid: true,
    error: null,
    unknown: [...scan.flags.keys()].filter((flag) => !(ANOMALY_FLAGS as readonly string[]).includes(flag)),
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
  const journey = requireValue(['--journey']);
  if (journey !== null) parsed.journeyPath = journey;
  const output = requireValue(['--output', '--out', '-o']);
  if (output !== null) parsed.outputPath = output;

  // Warnings are usually expected, so they are opt-in rather than always-on.
  parsed.includeConsoleWarnings = scan.flags.has('--include-console-warnings');

  return parsed;
}

/** Prefer a repo-relative path in terminal output. */
function toDisplayPath(absolutePath: string): string {
  const rel = relative(process.cwd(), absolutePath);
  return rel && !rel.startsWith('..') ? rel : absolutePath;
}

export const ANOMALY_USAGE = `${TOOL_NAME} v${TOOL_VERSION}

Usage:
  npm run anomalies -- --execution <path> --journey <path> [--output <path>]

Classifies deterministic evidence signals from a completed execution.

Options:
  --execution <path>          Execution report  [default: ${DEFAULT_EXECUTION_INPUT_PATH}]
  --journey <path>            Journey plan      [default: ${DEFAULT_JOURNEY_INPUT_PATH}]
  -o, --out <path>            Anomaly report    [default: ${DEFAULT_ANOMALY_OUTPUT_PATH}]
  --include-console-warnings  Also report console warnings. Off by default,
                              because a warning is frequently expected.

Build 4 reports signals observed, not bugs found. It opens no browser, makes
no network call, uses no AI, and never retries or reproduces. Neither input
is modified. Confirmation and reproduction belong to Build 5.`;

/**
 * Run the `anomalies` command.
 *
 * @returns the process exit code.
 */
export async function runAnomalyCommand(argv: readonly string[]): Promise<number> {
  const args = parseAnomalyArgs(argv);

  if (!args.valid) {
    console.error(args.error ?? 'Invalid arguments.');
    return 2;
  }

  let inputs;
  try {
    inputs = await loadAnalysisInputs(args.executionPath, args.journeyPath);
  } catch (error) {
    if (error instanceof AnomalyInputError) {
      console.error(`Cannot analyze: ${error.message}`);
      return 1;
    }
    console.error(`Cannot analyze: ${(error as Error).message}`);
    return 1;
  }

  const report = buildAnomalyReport(
    {
      execution: inputs.execution,
      journey: inputs.journey,
      executionPath: args.executionPath,
      journeyPath: args.journeyPath,
    },
    { includeConsoleWarnings: args.includeConsoleWarnings },
  );

  const absolutePath = await writeAnomalyReport(report, args.outputPath);

  console.log(summarizeAnomalyReport(report));
  console.log(`Output: ${toDisplayPath(absolutePath)}`);

  // Finding signals is a successful analysis, not an error. Only an invalid
  // input is a non-zero exit, and that case returns before reaching here.
  return 0;
}
