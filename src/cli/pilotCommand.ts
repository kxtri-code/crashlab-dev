/**
 * The `pilot` CLI command — Build 10.3.
 *
 * Orchestrates pilot execution through the mandatory preflight safety gate.
 * Strictly guarantees that no browser is created unless preflight validation passes.
 *
 * Exits:
 *   0  Configuration is ready/valid or local synthetic run succeeded
 *   1  Configuration is blocked or invalid by safety rules
 *   2  CLI argument or syntax error
 */

import { flagValue, scanArgs } from './args.js';
import { runPilot } from '../pilot/runner.js';
import { TOOL_NAME, TOOL_VERSION } from '../version.js';

export const PILOT_FLAGS = [
  '--config',
  '-c',
  '--preflight-only',
  '--dry-run',
  '--journey',
  '-j',
  '--report-dir',
  '--report',
  '-o',
  '--json',
  '--confirm-authorized',
  '--pipeline',
  '--baseline',
  '-h',
  '--help',
] as const;

export const PILOT_USAGE = `${TOOL_NAME} v${TOOL_VERSION} - Pilot Execution Gate

Usage:
  npm run pilot -- --config <path> [options]
  npx tsx src/cli.ts pilot --config <path> [options]

Executes an authorized pilot run with mandatory preflight safety gate verification.
No browser is launched unless preflight validation returns status: "ready".

Required:
  -c, --config <path>          Path to pilot configuration file (.json or key-value format)

Options:
  --preflight-only             Run preflight checks only; do not launch a browser
  -j, --journey <path>         Path to approved journey plan (local synthetic fixtures only)
  --report-dir <path>          Directory for execution reports and artifacts
  -o, --report <path>          Write JSON preflight report to file path
  --json                       Print preflight report as JSON to stdout
  --confirm-authorized         Confirm authorization for external non-local targets
  --pipeline                   Run full post-execution pipeline (anomalies, reproduction, review)
  --baseline <path>            Path to baseline file for candidate comparison
  -h, --help                   Show this message

Exit codes:
  0  Valid preflight or successful local synthetic run
  1  Blocked or invalid safety configuration
  2  CLI syntax error, missing argument, or unreadable file

Safety Invariant: Zero browser traffic occurs unless preflight status is "ready".`;

export interface ParsedPilotArgs {
  configPath: string | null;
  preflightOnly: boolean;
  journeyPath?: string;
  reportDir?: string;
  reportPath?: string;
  json: boolean;
  confirmAuthorized: boolean;
  pipeline: boolean;
  baselinePath?: string;
  valid: boolean;
  error: string | null;
  unknown: string[];
}

export function parsePilotArgs(argv: readonly string[]): ParsedPilotArgs {
  const scan = scanArgs(argv);
  const parsed: ParsedPilotArgs = {
    configPath: null,
    preflightOnly: false,
    json: false,
    confirmAuthorized: false,
    pipeline: false,
    valid: true,
    error: null,
    unknown: [...scan.flags.keys()].filter(
      (flag) => !(PILOT_FLAGS as readonly string[]).includes(flag),
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

  parsed.preflightOnly = scan.flags.has('--preflight-only') || scan.flags.has('--dry-run');

  const journey = flagValue(scan, ['--journey', '-j']);
  if (journey.present) {
    if (journey.missingValue) {
      parsed.error = 'Option --journey requires a file path.';
      parsed.valid = false;
      return parsed;
    }
    parsed.journeyPath = journey.value ?? undefined;
  }

  const reportDir = flagValue(scan, ['--report-dir']);
  if (reportDir.present) {
    if (reportDir.missingValue) {
      parsed.error = 'Option --report-dir requires a directory path.';
      parsed.valid = false;
      return parsed;
    }
    parsed.reportDir = reportDir.value ?? undefined;
  }

  const report = flagValue(scan, ['--report', '-o']);
  if (report.present) {
    if (report.missingValue) {
      parsed.error = 'Option --report requires a file path.';
      parsed.valid = false;
      return parsed;
    }
    parsed.reportPath = report.value ?? undefined;
  }

  parsed.json = scan.flags.has('--json');
  parsed.confirmAuthorized = scan.flags.has('--confirm-authorized');
  parsed.pipeline = scan.flags.has('--pipeline');

  const baseline = flagValue(scan, ['--baseline']);
  if (baseline.present) {
    if (baseline.missingValue) {
      parsed.error = 'Option --baseline requires a file path.';
      parsed.valid = false;
      return parsed;
    }
    parsed.baselinePath = baseline.value ?? undefined;
  }

  return parsed;
}

export async function runPilotCommand(argv: readonly string[]): Promise<number> {
  const args = parsePilotArgs(argv);

  if (!args.valid) {
    console.error(args.error);
    console.error('');
    console.error(PILOT_USAGE);
    return 2;
  }

  const result = await runPilot({
    config: args.configPath!,
    preflightOnly: args.preflightOnly,
    journeyPath: args.journeyPath,
    reportDir: args.reportDir,
    preflightReportPath: args.reportPath,
    confirmAuthorized: args.confirmAuthorized,
    pipeline: args.pipeline,
    baselinePath: args.baselinePath,
    quiet: args.json,
  });

  if (args.json) {
    console.log(JSON.stringify(result.preflightReport, null, 2));
  } else if (result.executed) {
    console.log(result.message);
  } else if (result.message) {
    if (result.exitCode !== 0) {
      console.error(result.message);
    }
  }

  return result.exitCode;
}
