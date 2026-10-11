#!/usr/bin/env node
/**
 * CrashLab CLI.
 *
 * A dispatcher over the build commands. Since Build 2 this holds `scout`
 * (unchanged from Build 1) and `journey`; the `journey` command itself lives
 * in `cli/journeyCommand.ts` and the `scout` planning logic in `scout/`, so
 * each command can be reused from a job runner or API without going through argv.
 *
 * `parseArgs` and `main` are retained exactly as Build 1 defined them for the
 * `scout` path, so Build 1's CLI contract and tests are unchanged.
 */

import { relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';
import { runScout } from './scout/scout.js';
import type { ScoutOptions } from './scout/scout.js';
import { DEFAULT_OUTPUT_PATH, writeReport } from './report/write.js';
import { summarizeReport } from './report/build.js';
import { normalizeInputUrl, parseBoolean, parseInteger, parseViewport } from './util/url.js';
import { TOOL_NAME, TOOL_VERSION } from './version.js';
import { JOURNEY_USAGE, runJourneyCommand } from './cli/journeyCommand.js';
import { EXECUTE_USAGE, runExecuteCommand } from './cli/executeCommand.js';
import { ANOMALY_USAGE, runAnomalyCommand } from './cli/anomalyCommand.js';
import { REPRODUCE_USAGE, runReproduceCommand } from './cli/reproduceCommand.js';
import { BASELINE_USAGE, runBaselineCommand } from './cli/baselineCommand.js';
import { REVIEW_USAGE, runReviewCommand } from './cli/reviewCommand.js';
import { REVIEW_STATE_USAGE, runReviewStateCommand } from './cli/reviewStateCommand.js';
import { REVIEW_API_USAGE, runReviewApiCommand } from './cli/reviewApiCommand.js';

const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

/** Parsed command-line state. Pure, so it is unit-testable. */
export interface ParsedArgs {
  command: 'scout' | 'help' | 'version';
  url: string | null;
  outputPath: string;
  headless: boolean;
  timeoutMs: number;
  settleMs: number;
  slowMoMs: number;
  ignoreHttpsErrors: boolean;
  viewport: { width: number; height: number };
  /** Flags the parser did not recognise, surfaced as an error. */
  unknown: string[];
  /** False when `error` is set and the CLI should stop. */
  valid: boolean;
  error: string | null;
}

export const USAGE = `${TOOL_NAME} v${TOOL_VERSION}

Usage:
  npm run scout -- <url> [options]
  npx tsx src/cli.ts scout <url> [options]
  npm run journey -- --goal "<goal>" --scout reports/scout.json
  npm run execute -- --journey reports/journey.json --confirm-authorized
  npm run anomalies -- --execution reports/execution.json --journey reports/journey.json
  npm run reproduce -- --anomalies reports/anomalies.json --journey reports/journey.json --confirm-authorized
  npm run baseline -- --baseline-id <id> --confirm-known-good
  npm run review -- --baseline reports/baselines/<id>.json
  npm run review-state -- --candidate <id> --status investigating
  npm run review-api -- --port 3210

Commands:
  scout <url>    Map an authorized page and write a JSON report (Build 1)
  journey        Plan a user journey from a goal and a Scout report (Build 2)
  execute        Attempt a journey plan in a browser (Build 3)
  anomalies      Classify evidence signals from an execution report (Build 4)
  reproduce      Rerun a journey to test whether a signal recurs (Build 5)
  baseline       Record an explicit known-good state (Build 6)
  review         Compare a run against a baseline for candidate defects (Build 6)
  review-state   Record persistent human review decisions for candidates (Build 8)
  review-api     Start local read-only HTTP review API (Build 9.1)
  help           Show this message
  version        Print the build version

Options:
  --url <url>            Target URL (alternative to the positional argument)
  -o, --out <path>       Report output path        [default: ${DEFAULT_OUTPUT_PATH}]
  --timeout <ms>         Navigation timeout        [default: 30000]
  --settle <ms>          Settle delay after load   [default: 1000]
  --slow-mo <ms>         Slow every action down, for watching a run [default: 0]
  --viewport <WxH>       Viewport size             [default: 1280x800]
  --insecure             Accept invalid TLS certificates
  --visible              Run Chromium with a window (same as --headless=false)
  --headless             Run Chromium headless (default)
  -h, --help             Show this message
  -v, --version          Print the build version

Environment (CLI flags win):
  CRASHLAB_HEADLESS, CRASHLAB_TIMEOUT_MS, CRASHLAB_SETTLE_MS, CRASHLAB_OUTPUT,
  CRASHLAB_SLOW_MO_MS, CRASHLAB_INSECURE, CRASHLAB_VIEWPORT

Only run this against applications you own or are authorized to test.`;

/** Split `--flag=value` into its parts; `value` is `null` when absent. */
function splitFlag(token: string): [string, string | null] {
  const eq = token.indexOf('=');
  if (eq < 0) return [token, null];
  return [token.slice(0, eq), token.slice(eq + 1)];
}

/** Build the defaults from the environment, before any CLI flag is applied. */
function defaultsFromEnv(): ParsedArgs {
  return {
    command: 'help',
    url: null,
    outputPath: process.env.CRASHLAB_OUTPUT?.trim() || DEFAULT_OUTPUT_PATH,
    headless: parseBoolean(process.env.CRASHLAB_HEADLESS, true),
    timeoutMs: parseInteger(process.env.CRASHLAB_TIMEOUT_MS, 30_000, 0),
    settleMs: parseInteger(process.env.CRASHLAB_SETTLE_MS, 1_000, 0),
    slowMoMs: parseInteger(process.env.CRASHLAB_SLOW_MO_MS, 0, 0),
    ignoreHttpsErrors: parseBoolean(process.env.CRASHLAB_INSECURE, false),
    viewport: parseViewport(process.env.CRASHLAB_VIEWPORT, DEFAULT_VIEWPORT),
    unknown: [],
    valid: true,
    error: null,
  };
}

/**
 * Parse `argv` (without `node` and the script path).
 *
 * Precedence is CLI flag > environment variable > default, resolved here so no
 * other module has to think about it.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed = defaultsFromEnv();
  let explicitUrl: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined) continue;

    if (token === '-h' || token === '--help' || token === 'help') {
      parsed.command = 'help';
      return parsed;
    }
    if (token === '-v' || token === '--version' || token === 'version') {
      parsed.command = 'version';
      return parsed;
    }

    if (token === 'scout') continue;

    if (token === '--visible') {
      parsed.headless = false;
      continue;
    }
    if (token === '--headless') {
      parsed.headless = true;
      continue;
    }
    if (token === '--insecure') {
      parsed.ignoreHttpsErrors = true;
      continue;
    }

    if (token.startsWith('-')) {
      const [flag, inlineValue] = splitFlag(token);
      let value = inlineValue;
      if (value === null) {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) {
          parsed.error = `Option ${flag} requires a value.`;
          parsed.valid = false;
          return parsed;
        }
        value = next;
        i += 1;
      }

      switch (flag) {
        case '--url':
          explicitUrl = value;
          break;
        case '-o':
        case '--out':
        case '--output':
          parsed.outputPath = value;
          break;
        case '--timeout':
          parsed.timeoutMs = parseInteger(value, parsed.timeoutMs, 1);
          break;
        case '--settle':
          parsed.settleMs = parseInteger(value, parsed.settleMs, 0);
          break;
        case '--slow-mo':
          parsed.slowMoMs = parseInteger(value, parsed.slowMoMs, 0);
          break;
        case '--viewport':
          parsed.viewport = parseViewport(value, parsed.viewport);
          break;
        default:
          parsed.unknown.push(flag);
      }
      continue;
    }

    if (explicitUrl === null) explicitUrl = token;
    else parsed.unknown.push(token);
  }

  if (parsed.unknown.length > 0) {
    parsed.error = `Unknown argument: ${parsed.unknown[0]}`;
    parsed.valid = false;
    return parsed;
  }

  if (explicitUrl === null) {
    // Nothing to do and nothing wrong: bare invocation is a help request.
    parsed.command = 'help';
    return parsed;
  }

  parsed.command = 'scout';
  parsed.url = normalizeInputUrl(explicitUrl);

  if (!parsed.url) {
    parsed.error = 'Missing target URL. Usage: npm run scout -- <url>';
    parsed.valid = false;
  }

  return parsed;
}

/** Translate parsed args into `runScout` options. */
export function toScoutOptions(args: ParsedArgs): ScoutOptions {
  return {
    url: args.url ?? '',
    headless: args.headless,
    timeoutMs: args.timeoutMs,
    settleMs: args.settleMs,
    slowMoMs: args.slowMoMs,
    ignoreHttpsErrors: args.ignoreHttpsErrors,
    viewport: args.viewport,
  };
}

/** Prefer a repo-relative path in terminal output; fall back to absolute. */
function toDisplayPath(absolutePath: string): string {
  const rel = relative(process.cwd(), absolutePath);
  return rel && !rel.startsWith('..') ? rel : absolutePath;
}

/** Run the CLI. Returns the process exit code. */
export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);

  // Validity is checked before the help/version dispatch: a parse error leaves
  // `command` at its default, so dispatching first would report success for an
  // invocation that was never valid.
  if (!args.valid) {
    console.error(args.error ?? 'Invalid arguments.');
    console.error('');
    console.error(USAGE);
    return 2;
  }

  if (args.command === 'help') {
    console.log(USAGE);
    return 0;
  }
  if (args.command === 'version') {
    console.log(`${TOOL_NAME} v${TOOL_VERSION}`);
    return 0;
  }
  if (!args.valid || !args.url) {
    console.error(args.error ?? 'Invalid arguments.');
    console.error('');
    console.error(USAGE);
    return 2;
  }
  console.log(`${TOOL_NAME} v${TOOL_VERSION}`);
  console.log(`Target: ${args.url}`);
  if (!args.headless) console.log('Running with a visible browser window.');
  console.log('Loading page...');

  let report;
  try {
    report = await runScout(toScoutOptions(args));
  } catch (error) {
    console.error('');
    console.error(`Scout failed to start: ${(error as Error).message}`);
    return 1;
  }

  const absolutePath = await writeReport(report, args.outputPath);

  console.log('');
  console.log(summarizeReport(report));
  console.log(`Report: ${toDisplayPath(absolutePath)}`);

  // A report written despite a failed navigation is still useful, so a failed
  // navigation is a warning-plus-exit-1, not a hard failure. Only a run that
  // produced no report at all is treated as success-with-output-missing.
  return report.scoutErrors.length > 0 ? 1 : 0;
}

/** True when this module was run directly, rather than imported by a caller. */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(resolve(entry)).href === pathToFileURL(fileURLToPath(import.meta.url)).href;
  } catch {
    return false;
  }
}

/**
 * Dispatch to the right build command.
 *
 * `scout` maps a page (Build 1), `journey` plans one (Build 2), `execute`
 * attempts one (Build 3), `anomalies` classifies evidence signals (Build 4),
 * and `reproduce` reruns a journey to test whether a signal recurs (Build 5).
 */
export async function dispatch(argv: readonly string[]): Promise<number> {
  const first = argv[0];
  const rest = argv.slice(1);
  const wantsHelp = (args: readonly string[]) => args.includes('--help') || args.includes('-h');

  if (first === 'journey') {
    if (wantsHelp(rest)) {
      console.log(JOURNEY_USAGE);
      return 0;
    }
    return runJourneyCommand(rest);
  }

  if (first === 'execute') {
    if (wantsHelp(rest)) {
      console.log(EXECUTE_USAGE);
      return 0;
    }
    return runExecuteCommand(rest);
  }

  if (first === 'anomalies' || first === 'anomaly') {
    if (wantsHelp(rest)) {
      console.log(ANOMALY_USAGE);
      return 0;
    }
    return runAnomalyCommand(rest);
  }

  if (first === 'reproduce' || first === 'repro') {
    if (wantsHelp(rest)) {
      console.log(REPRODUCE_USAGE);
      return 0;
    }
    return runReproduceCommand(rest);
  }

  if (first === 'baseline') {
    if (wantsHelp(rest)) {
      console.log(BASELINE_USAGE);
      return 0;
    }
    return runBaselineCommand(rest);
  }

  if (first === 'review') {
    if (wantsHelp(rest)) {
      console.log(REVIEW_USAGE);
      return 0;
    }
    return runReviewCommand(rest);
  }

  if (first === 'review-state') {
    if (wantsHelp(rest)) {
      console.log(REVIEW_STATE_USAGE);
      return 0;
    }
    return runReviewStateCommand(rest);
  }

  if (first === 'review-api') {
    if (wantsHelp(rest)) {
      console.log(REVIEW_API_USAGE);
      return 0;
    }
    return runReviewApiCommand(rest);
  }

  return main([...argv]);
}

if (isMainModule()) {
  dispatch(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(`Unexpected crashlab failure: ${(error as Error)?.message ?? String(error)}`);
      process.exitCode = 1;
    });
}
