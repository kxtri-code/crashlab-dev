/**
 * The `pilot-preflight` CLI command — Build 10.2.
 *
 * Validates a protected pilot configuration against CrashLab safety invariants.
 * Never opens a browser, never makes network requests, and never outputs secrets.
 *
 * Exits:
 *   0  Configuration is valid and safe for the declared environment (status: ready)
 *   1  Configuration is blocked or invalid by safety rules
 *   2  CLI argument or syntax error
 */

import { flagValue, scanArgs } from './args.js';
import { loadPilotConfiguration, ConfigurationLoadError } from '../preflight/loader.js';
import { validatePilotConfiguration, buildPreflightReport } from '../preflight/validator.js';
import { formatPreflightSummary, writePreflightReport } from '../preflight/report.js';
import { assertPilotReady, PilotExecutionGateError } from '../pilot/gate.js';
import { TOOL_NAME, TOOL_VERSION } from '../version.js';

export const PREFLIGHT_FLAGS = [
  '--config',
  '-c',
  '--report',
  '--out',
  '-o',
  '--json',
  '--check-execution-gate',
  '-h',
  '--help',
] as const;

export const PREFLIGHT_USAGE = `${TOOL_NAME} v${TOOL_VERSION} - Pilot Preflight Validator

Usage:
  npm run pilot-preflight -- --config <path> [options]
  npx tsx src/cli.ts pilot-preflight --config <path> [options]

Validates a protected pilot configuration against CrashLab safety invariants
before any browser execution is permitted.

Required:
  -c, --config <path>          Path to pilot configuration file (.json or key-value format)

Options:
  -o, --report <path>          Write JSON preflight report to file path
  --json                       Print preflight report as JSON to stdout
  --check-execution-gate       Explicitly verify the execution gate assertion
  -h, --help                   Show this message

Exit codes:
  0  Configuration is valid and safe for the declared environment
  1  Configuration is blocked or invalid by safety rules
  2  CLI syntax error, missing argument, or unreadable file

Zero browser traffic generated. Preflight validation only.`;

export interface ParsedPreflightArgs {
  configPath: string | null;
  reportPath: string | null;
  json: boolean;
  checkExecutionGate: boolean;
  valid: boolean;
  error: string | null;
  unknown: string[];
}

export function parsePreflightArgs(argv: readonly string[]): ParsedPreflightArgs {
  const scan = scanArgs(argv);
  const parsed: ParsedPreflightArgs = {
    configPath: null,
    reportPath: null,
    json: false,
    checkExecutionGate: false,
    valid: true,
    error: null,
    unknown: [...scan.flags.keys()].filter(
      (flag) => !(PREFLIGHT_FLAGS as readonly string[]).includes(flag),
    ),
  };

  if (parsed.unknown.length > 0) {
    parsed.error = `Unknown option: ${parsed.unknown[0]}. Run with --help for supported options.`;
    parsed.valid = false;
    return parsed;
  }

  const config = flagValue(scan, ['--config', '-c']);
  if (config.present) {
    if (config.missingValue) {
      parsed.error = 'Option --config requires a file path.';
      parsed.valid = false;
      return parsed;
    }
    parsed.configPath = config.value;
  } else if (scan.positionals.length > 0) {
    parsed.configPath = scan.positionals[0] ?? null;
  }

  if (!parsed.configPath) {
    parsed.error = 'Missing required option: --config <path>. Run with --help for usage.';
    parsed.valid = false;
    return parsed;
  }

  const report = flagValue(scan, ['--report', '--out', '-o']);
  if (report.present) {
    if (report.missingValue) {
      parsed.error = 'Option --report requires a file path.';
      parsed.valid = false;
      return parsed;
    }
    parsed.reportPath = report.value;
  }

  parsed.json = scan.flags.has('--json');
  parsed.checkExecutionGate = scan.flags.has('--check-execution-gate');

  return parsed;
}

export async function runPreflightCommand(argv: readonly string[]): Promise<number> {
  const args = parsePreflightArgs(argv);

  if (!args.valid) {
    console.error(args.error);
    console.error('');
    console.error(PREFLIGHT_USAGE);
    return 2;
  }

  let config;
  try {
    config = await loadPilotConfiguration(args.configPath!);
  } catch (error) {
    if (error instanceof ConfigurationLoadError) {
      console.error(`Configuration error [${error.code}]: ${error.message}`);
    } else {
      console.error(`Failed to load configuration: ${(error as Error).message}`);
    }
    return 2;
  }

  const result = validatePilotConfiguration(config);
  const report = buildPreflightReport(config, result);

  if (args.reportPath) {
    try {
      await writePreflightReport(report, args.reportPath);
    } catch (error) {
      console.error(`Failed to write preflight report: ${(error as Error).message}`);
      return 2;
    }
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatPreflightSummary(report));
    if (args.reportPath) {
      console.log(`Report written to: ${args.reportPath}`);
    }
  }

  if (args.checkExecutionGate) {
    try {
      assertPilotReady(result);
      if (!args.json) {
        console.log('EXECUTION GATE: CLEARED (Configuration is ready for execution).');
      }
    } catch (error) {
      if (!args.json) {
        console.error((error as Error).message);
      }
      return 1;
    }
  }

  // 0: ready; 1: blocked or invalid
  return result.status === 'ready' ? 0 : 1;
}
