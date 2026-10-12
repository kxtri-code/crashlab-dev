/**
 * CLI command for `npm run demo` (Build 10.5: Local Product Demo).
 *
 * Exits:
 *   0  Successful demo run or successful cleanup
 *   1  Execution failure
 *   2  CLI argument error
 */

import { flagValue, scanArgs } from './args.js';
import { TOOL_NAME, TOOL_VERSION } from '../version.js';
import { runDemo, DEFAULT_DEMO_OUT_DIR } from '../demo/runner.js';
import type { DemoOptions, DemoScenario } from '../demo/types.js';

export const DEMO_FLAGS = [
  '--clean',
  '--reset',
  '--scenario',
  '--out-dir',
  '--quiet',
  '--json',
  '--help',
  '-h',
] as const;

export const DEMO_USAGE = `${TOOL_NAME} v${TOOL_VERSION} - Local Product Demo

Usage:
  npm run demo [options]
  npx tsx src/cli.ts demo [options]

Executes an automated, beginner-friendly local demonstration of the complete CrashLab pipeline:
Scout -> Journey -> Execute -> Anomalies -> Reproduce -> Review -> Review-State

Scenarios demonstrated:
  1. Healthy Scenario: Safe catalog navigation, 0 anomalies, clean baseline registration.
  2. Controlled Failure: Deterministic HTTP 500 fault on /boom, HTTP_5XX classification,
     3x bounded reproduction, candidate generation (confirmed: false invariant),
     and review-state triage recording.

Options:
  --scenario <type>        Scenario to run: healthy, failure, all   [default: all]
  --out-dir <path>         Output directory for demo artifacts     [default: ${DEFAULT_DEMO_OUT_DIR}]
  --clean, --reset         Safely remove demo artifacts and exit
  --quiet                  Suppress progress output
  --json                   Output summary report as JSON
  -h, --help               Show this message

Safety Guarantees:
  - 100% loopback traffic only (127.0.0.1 ephemeral port). Zero external requests.
  - Zero real credentials, customer data, or payment mechanisms.
  - Safe test mode remains enabled; payment actions are strictly blocked.
  - Invariants strictly preserved: confirmed: false, confirmedBug: false.`;

export interface ParsedDemoArgs {
  valid: boolean;
  error: string | null;
  unknown: string[];
  clean: boolean;
  scenario: DemoScenario;
  outDir: string;
  quiet: boolean;
  json: boolean;
}

export function parseDemoArgs(argv: readonly string[]): ParsedDemoArgs {
  const scan = scanArgs(argv);
  const parsed: ParsedDemoArgs = {
    valid: true,
    error: null,
    unknown: [],
    clean: false,
    scenario: 'all',
    outDir: DEFAULT_DEMO_OUT_DIR,
    quiet: false,
    json: false,
  };

  const known = new Set<string>(DEMO_FLAGS);
  for (const flag of scan.flags.keys()) {
    if (!known.has(flag)) {
      parsed.unknown.push(flag);
    }
  }

  if (parsed.unknown.length > 0) {
    parsed.valid = false;
    parsed.error = `Unknown option: ${parsed.unknown.join(', ')}. Run with --help for supported options.`;
    return parsed;
  }

  if (scan.flags.has('--clean') || scan.flags.has('--reset')) {
    parsed.clean = true;
  }

  if (scan.flags.has('--quiet')) {
    parsed.quiet = true;
  }

  if (scan.flags.has('--json')) {
    parsed.json = true;
  }

  const outVal = flagValue(scan, ['--out-dir']);
  if (outVal.present) {
    if (!outVal.value || outVal.missingValue || !outVal.value.trim()) {
      parsed.valid = false;
      parsed.error = '--out-dir requires a directory path.';
      return parsed;
    }
    parsed.outDir = outVal.value.trim();
  }

  const scenVal = flagValue(scan, ['--scenario']);
  if (scenVal.present) {
    if (!scenVal.value || scenVal.missingValue || !scenVal.value.trim()) {
      parsed.valid = false;
      parsed.error = '--scenario requires a value: healthy, failure, or all.';
      return parsed;
    }
    const val = scenVal.value.trim().toLowerCase();
    if (val !== 'healthy' && val !== 'failure' && val !== 'all') {
      parsed.valid = false;
      parsed.error = `Invalid scenario "${scenVal.value}". Must be healthy, failure, or all.`;
      return parsed;
    }
    parsed.scenario = val as DemoScenario;
  }

  return parsed;
}

export async function runDemoCommand(argv: readonly string[]): Promise<number> {
  const parsed = parseDemoArgs(argv);

  if (!parsed.valid) {
    console.error(parsed.error);
    console.error('');
    console.error(DEMO_USAGE);
    return 2;
  }

  const options: DemoOptions = {
    scenario: parsed.scenario,
    outDir: parsed.outDir,
    quiet: parsed.quiet || parsed.json,
    clean: parsed.clean,
  };

  try {
    const result = await runDemo(options);

    if (parsed.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (parsed.clean && !parsed.quiet && result.message) {
      console.log(result.message);
    }

    return result.exitCode;
  } catch (error) {
    console.error('');
    console.error(`Demo execution failed: ${(error as Error).message}`);
    return 1;
  }
}
