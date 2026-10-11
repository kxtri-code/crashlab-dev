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
import { ANOMALY_USAGE, runAnomalyCommand } from './anomalyCommand.js';
import { TOOL_NAME, TOOL_VERSION } from '../version.js';
import { sanitizeAppBuildId, sanitizeDataId, sanitizeEnvironmentId } from '../provenance/redaction.js';
import { readFile } from 'node:fs/promises';
import type { ProvenanceInput } from '../provenance/types.js';
import { loadExpectationsFile } from '../executor/expectations.js';

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
  // Build 5.1 provenance. All optional and safe-identifiers only.
  '--environment-id',
  '--app-build-id',
  '--data-id',
  '--hash-test-data',
  // Build 6.5: operator-declared expectations for SPA/JS flows.
  '--expectations',
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
  /** Build 5.1 provenance: optional, safe identifiers only. */
  provenance: ProvenanceInput;
  /** Read the test-data file's bytes so its hash can be recorded. */
  hashTestData: boolean;
  /** Build 6.5: optional operator-declared expectations for SPA/JS flows. */
  expectationsPath: string | null;
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
    provenance: {},
    hashTestData: false,
    expectationsPath: null,
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
  const expectations = requireValue(['--expectations']);
  if (expectations !== null) parsed.expectationsPath = expectations;

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
  parsed.hashTestData = scan.flags.has('--hash-test-data');

  // Build 5.1 provenance identifiers. Validated here so an unsafe value is
  // refused before any browser opens, and sanitized exactly once.
  try {
    parsed.provenance = {
      environmentId: sanitizeEnvironmentId(readProvenanceFlag(scan, '--environment-id')),
      appBuildId: sanitizeAppBuildId(readProvenanceFlag(scan, '--app-build-id')),
      dataId: sanitizeDataId(readProvenanceFlag(scan, '--data-id')),
      hashTestData: parsed.hashTestData,
    };
  } catch (error) {
    parsed.error = (error as Error).message;
    parsed.valid = false;
  }

  return parsed;
}

/** Read a provenance flag's raw value, or `null` when absent. */
function readProvenanceFlag(scan: ReturnType<typeof scanArgs>, flag: string): string | null {
  return flagValue(scan, [flag]).value;
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

Provenance (Build 5.1, all optional):
  --environment-id <id>        Short safe id for this environment
  --app-build-id <id>          Short safe application build id
  --data-id <id>               Short safe test-data fixture id
  --hash-test-data             Also record a SHA-256 of the fixture file.
                               Opt-in: a hash marks identity, it does not
                               protect a secret.

Operator-declared expectations (Build 6.5, optional):
  --expectations <path>        Operator-declared expectations for SPA/JS
                               flows. Bound to the journey by SHA-256.
                               Only source="operator-declared" is accepted;
                               no inference from Scout evidence.

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

  // --- gate 5: operator-declared expectations, before any browser opens ----
  // The expectations file is bound to the journey by hash, so it must be
  // validated against the plan that just loaded. Validation rejects unsafe
  // paths, payment-adjacent destinations, cross-origin claims, and any
  // expectation that references a step the plan does not contain.
  let expectations;
  if (args.expectationsPath !== null) {
    try {
      expectations = await loadExpectationsFile(args.expectationsPath, plan);
    } catch (error) {
      console.error(`Refusing to execute: ${(error as Error).message}`);
      return 1;
    }
  }

  const outputAbsolute = resolve(process.cwd(), args.outputPath);
  // Screenshots live beside the report, in an `evidence/` directory at the repo
  // root, so a run's evidence is easy to find and easy to gitignore.
  const evidenceDir = resolve(process.cwd(), 'evidence');

  console.log(`${TOOL_NAME} v${TOOL_VERSION} - Journey Executor`);
  console.log(`Journey: ${args.journeyPath}`);
  console.log(`Goal:    ${plan.goal}`);
  console.log(`Target:  ${plan.target.url}`);
  if (args.dataPath) console.log(`Test data: ${args.dataPath} (${Object.keys(testData ?? {}).length} key(s), values never logged)`);
  if (args.expectationsPath) console.log(`Expectations: ${args.expectationsPath} (operator-declared, bound to journey hash)`);
  console.log('Safe test mode: ON (payment actions are blocked; this cannot be disabled)');
  if (args.provenance.environmentId) console.log(`Environment ID: ${args.provenance.environmentId}`);
  if (args.provenance.appBuildId) console.log(`Application build: ${args.provenance.appBuildId}`);
  console.log('Executing journey steps...');

  let report;
  try {
    // Build 5.1: read the fixture bytes only when a hash was requested, so the
    // default path never holds test-data contents in memory or on disk.
    const testDataFixtureHashSource = args.hashTestData && args.dataPath ? await readFile(args.dataPath) : undefined;

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
      provenance: args.provenance,
      testDataFixtureHashSource,
      expectations,
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
