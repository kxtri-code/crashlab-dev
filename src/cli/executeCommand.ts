/**
 * The `execute` command.
 *
 * Reads an immutable journey plan and attempts it in a browser, writing a
 * separate `execution.json`.
 *
 * Order of operations matters and is deliberate: **every validation runs before
 * Playwright is imported for a session.** A missing authorization flag, a
 * malformed plan, or unreadable test data all stop the run without a browser
 * ever being launched. The `--confirm-authorized` gate is checked first,
 * before the plan is even read, so an unauthorized invocation cannot navigate.
 *
 * Exits:
 *   0  execution completed and a report was written
 *   1  refused: no authorization, bad plan, bad test data, or a run error
 *   2  bad arguments
 */

import { relative, resolve } from 'node:path';
import process from 'node:process';
import { flagValue, scanArgs } from './args.js';
import { writeReport } from '../report/write.js';
import { loadJourneyPlan } from '../executor/planValidator.js';
import { loadTestData } from '../executor/testData.js';
import { executeJourney, DEFAULT_STEP_TIMEOUT_MS } from '../executor/executor.js';
import { summarizeExecution } from '../executor/executionReport.js';
import { ExecutionRefused, JourneyPlanError } from '../executor/types.js';
import { TOOL_NAME, TOOL_VERSION } from '../version.js';

/** Default journey plan input path. */
export const DEFAULT_JOURNEY_INPUT_PATH = 'reports/journey.json';

/** Default execution report output path. */
export const DEFAULT_EXECUTION_OUTPUT_PATH = 'reports/execution.json';

/** Flags this command understands. */
export const EXECUTE_FLAGS = [
  '--journey',
  '--data',
  '--output',
  '--out',
  '-o',
  '--timeout',
  '--continue-on-failure',
  '--headed',
  '--confirm-authorized',
  '--no-screenshots',
] as const;

/** Parsed `execute` arguments. Pure, so it is unit-testable. */
export interface ParsedExecuteArgs {
  journeyPath: string;
  dataPath: string | null;
  outputPath: string;
  timeoutMs: number;
  continueOnFailure: boolean;
  headed: boolean;
  /** The safety gate. Absent means the run is refused. */
  confirmAuthorized: boolean;
  /**
   * Always true. Safe test mode is the default and has no opt-out in this
   * milestone, so a live payment path cannot be enabled from the CLI.
   */
  safeTestMode: boolean;
  screenshots: boolean;
  valid: boolean;
  error: string | null;
  unknown: string[];
}

/** Parse `argv` for the `execute` command. */
export function parseExecuteArgs(argv: readonly string[]): ParsedExecuteArgs {
  const scan = scanArgs(argv);
  const parsed: ParsedExecuteArgs = {
    journeyPath: process.env.CRASHLAB_JOURNEY_INPUT?.trim() || DEFAULT_JOURNEY_INPUT_PATH,
    dataPath: null,
    outputPath: process.env.CRASHLAB_EXECUTION_OUTPUT?.trim() || DEFAULT_EXECUTION_OUTPUT_PATH,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    continueOnFailure: false,
    headed: false,
    confirmAuthorized: false,
    safeTestMode: false,
    screenshots: true,
    valid: true,
    error: null,
    unknown: [...scan.flags.keys()].filter((flag) => !(EXECUTE_FLAGS as readonly string[]).includes(flag)),
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

  const journey = requireValue(['--journey']);
  if (journey !== null) parsed.journeyPath = journey;
  const data = requireValue(['--data']);
  if (data !== null) parsed.dataPath = data;
  const output = requireValue(['--output', '--out', '-o']);
  if (output !== null) parsed.outputPath = output;

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

  parsed.continueOnFailure = scan.flags.has('--continue-on-failure');
  parsed.headed = scan.flags.has('--headed');
  parsed.confirmAuthorized = scan.flags.has('--confirm-authorized');
  // Safe test mode cannot be turned off, so it is not a parsed flag.
  parsed.safeTestMode = true;
  parsed.screenshots = !scan.flags.has('--no-screenshots');

  return parsed;
}

/** Prefer a repo-relative path in terminal output. */
function toDisplayPath(absolutePath: string): string {
  const rel = relative(process.cwd(), absolutePath);
  return rel && !rel.startsWith('..') ? rel : absolutePath;
}

export const EXECUTE_USAGE = `${TOOL_NAME} v${TOOL_VERSION}

Usage:
  npm run execute -- --journey <path> --confirm-authorized [--data <path>] [--output <path>]

Runs a Build 2 journey plan in a browser and writes a separate execution report.

Required:
  --journey <path>            Path to a journey plan (default: ${DEFAULT_JOURNEY_INPUT_PATH})
  --confirm-authorized        Confirm you are authorized to test the target.
                              Without this flag nothing is launched and nothing is navigated.

Options:
  --data <path>               JSON test data for fill/select/upload steps
  -o, --out <path>            Execution report path (default: ${DEFAULT_EXECUTION_OUTPUT_PATH})
  --timeout <ms>              Per-step timeout (default: ${DEFAULT_STEP_TIMEOUT_MS})
  --continue-on-failure       Attempt later steps after a failure instead of stopping
  --headed                    Run with a visible browser window
  --no-screenshots            Do not capture screenshots

Safe test mode is always on and cannot be disabled: payment-adjacent actions
are blocked before any browser interaction, and no live payment path exists.
Screenshots stop once test data has entered the page, because a bitmap cannot
be redacted the way the JSON report can.

Build 3 attempts a journey. It performs no retries, does not reproduce
failures, does not classify anomalies, and does not confirm bugs. Those belong
to Build 4 and later.`;

/**
 * Run the `execute` command.
 *
 * @returns the process exit code.
 */
export async function runExecuteCommand(argv: readonly string[]): Promise<number> {
  const args = parseExecuteArgs(argv);

  if (!args.valid) {
    console.error(args.error ?? 'Invalid arguments.');
    return 2;
  }

  // --- gate 1: authorization, checked before anything is read or launched --
  if (!args.confirmAuthorized) {
    console.error('Refusing to execute: --confirm-authorized was not supplied.');
    console.error('');
    console.error('CrashLab only runs against applications you own or are authorized to test.');
    console.error('Re-run with --confirm-authorized once you are sure the target is authorized.');
    return 1;
  }

  // --- gate 2: the plan ---------------------------------------------------
  let plan;
  try {
    plan = await loadJourneyPlan(args.journeyPath);
  } catch (error) {
    if (error instanceof JourneyPlanError) {
      console.error(`Refusing to execute: ${error.message}`);
      return 1;
    }
    console.error(`Refusing to execute: ${(error as Error).message}`);
    return 1;
  }

  // --- gate 3: test data, before any browser is launched -------------------
  let testData: Record<string, string> | undefined;
  if (args.dataPath !== null) {
    try {
      testData = await loadTestData(args.dataPath);
    } catch (error) {
      if (error instanceof ExecutionRefused) {
        console.error(`Refusing to execute: ${error.message}`);
        return 1;
      }
      console.error(`Refusing to execute: ${(error as Error).message}`);
      return 1;
    }
  }

  // --- gate 4: safe test mode is unconditional ----------------------------
  // There is no flag that disables the payment guard, so there is nothing to
  // validate here beyond keeping the authorization check above it.

  const outputAbsolute = resolve(process.cwd(), args.outputPath);
  // Screenshots live beside the report, in an `evidence/` directory at the repo
  // root, so a run's evidence is easy to find and easy to gitignore.
  const evidenceDir = resolve(process.cwd(), 'evidence');

  console.log(`${TOOL_NAME} v${TOOL_VERSION} - Journey Executor`);
  console.log(`Journey: ${args.journeyPath}`);
  console.log(`Goal:    ${plan.goal}`);
  console.log(`Target:  ${plan.target.url}`);
  if (args.dataPath) console.log(`Test data: ${args.dataPath} (${Object.keys(testData ?? {}).length} key(s), values never logged)`);
  console.log('Safe test mode: ON (payment actions are blocked; this cannot be disabled)');
  console.log('Executing journey steps...');

  let report;
  try {
    report = await executeJourney({
      plan,
      planPath: args.journeyPath,
      testData,
      timeoutMs: args.timeoutMs,
      headed: args.headed,
      continueOnFailure: args.continueOnFailure,
      safeTestMode: args.safeTestMode,
      screenshots: args.screenshots,
      evidenceDir,
    });
  } catch (error) {
    console.error('');
    console.error(`Execution could not run: ${(error as Error).message}`);
    return 1;
  }

  await writeReport(report, args.outputPath);

  console.log('');
  console.log(summarizeExecution(report));
  console.log(`Execution report: ${toDisplayPath(outputAbsolute)}`);

  // A blocked or failed step is a legitimate result of an attempt, so the
  // report still counts as a successful run of the command. Only a run that
  // produced no report at all is a non-zero exit.
  return 0;
}
