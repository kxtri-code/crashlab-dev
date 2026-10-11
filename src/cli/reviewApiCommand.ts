/**
 * The `review-api` CLI command (Build 9.1).
 *
 * Starts a local, read-only HTTP API serving CrashLab candidate defect reports,
 * review-state history, and baseline documents.
 *
 * Exits:
 *   0  clean shutdown (SIGINT / SIGTERM)
 *   1  server or artifact loading error
 *   2  bad arguments
 */

import process from 'node:process';
import { flagValue, scanArgs } from './args.js';
import { TOOL_NAME, TOOL_VERSION } from '../version.js';
import { DEFAULT_CANDIDATE_OUTPUT_PATH } from '../review/types.js';
import { DEFAULT_REVIEW_STATE_DIR } from '../review/reviewStateTypes.js';
import { DEFAULT_BASELINE_DIR } from '../baseline/types.js';
import { DEFAULT_OUTPUT_PATH as DEFAULT_EXECUTION_PATH } from '../report/write.js';
import { DEFAULT_JOURNEY_OUTPUT_PATH } from '../journey/report.js';
import { DEFAULT_ANOMALY_OUTPUT_PATH } from '../anomaly/report.js';
import { DEFAULT_REPRODUCTION_OUTPUT_PATH } from '../reproducer/reproductionReport.js';
import { createReviewApiServer } from '../reviewApi/server.js';
import type { RunningReviewApiServer } from '../reviewApi/server.js';
import { validateHost, validatePort } from '../reviewApi/validator.js';

export const REVIEW_API_FLAGS = [
  '--candidates',
  '--review-state',
  '--baselines',
  '--journey',
  '--execution',
  '--anomalies',
  '--reproduction',
  '--host',
  '--port',
  '--help',
  '-h',
] as const;

export const REVIEW_API_USAGE = `${TOOL_NAME} v${TOOL_VERSION} - Review API (Read-Only)

Usage:
  npm run review-api -- [options]
  npx tsx src/cli.ts review-api [options]

Options:
  --candidates <path>     Candidate report path        [default: ${DEFAULT_CANDIDATE_OUTPUT_PATH}]
  --review-state <dir>    Review state directory       [default: ${DEFAULT_REVIEW_STATE_DIR}]
  --baselines <dir>       Baselines directory          [default: ${DEFAULT_BASELINE_DIR}]
  --journey <path>        Journey plan path            [default: ${DEFAULT_JOURNEY_OUTPUT_PATH}]
  --execution <path>      Execution report path        [default: ${DEFAULT_EXECUTION_PATH}]
  --anomalies <path>      Anomaly report path          [default: ${DEFAULT_ANOMALY_OUTPUT_PATH}]
  --reproduction <path>   Reproduction report path     [default: ${DEFAULT_REPRODUCTION_OUTPUT_PATH}]
  --host <host>           Host IP to bind              [default: 127.0.0.1]
  --port <port>           Port number to listen on     [default: 3210]
  -h, --help              Show this message

Read-Only Guarantees:
  - Serves GET and HEAD requests only; all mutations return 405 Method Not Allowed.
  - Leaves all report and baseline files byte-identical.
  - No database, no auth, no external network requests.
  - Non-negotiable trust invariants: confirmedBug: false and confirmed: false.`;

export interface ParsedReviewApiArgs {
  candidatesPath: string;
  reviewStateDir: string;
  baselinesDir: string;
  journeyPath: string;
  executionPath: string;
  anomaliesPath: string;
  reproductionPath: string;
  host: string;
  port: number;
  valid: boolean;
  error: string | null;
  unknown: string[];
}

export function parseReviewApiArgs(argv: readonly string[]): ParsedReviewApiArgs {
  const scan = scanArgs(argv);
  const parsed: ParsedReviewApiArgs = {
    candidatesPath: DEFAULT_CANDIDATE_OUTPUT_PATH,
    reviewStateDir: DEFAULT_REVIEW_STATE_DIR,
    baselinesDir: DEFAULT_BASELINE_DIR,
    journeyPath: DEFAULT_JOURNEY_OUTPUT_PATH,
    executionPath: DEFAULT_EXECUTION_PATH,
    anomaliesPath: DEFAULT_ANOMALY_OUTPUT_PATH,
    reproductionPath: DEFAULT_REPRODUCTION_OUTPUT_PATH,
    host: '127.0.0.1',
    port: 3210,
    valid: true,
    error: null,
    unknown: [],
  };

  const known = new Set<string>(REVIEW_API_FLAGS);
  for (const flag of scan.flags.keys()) {
    if (!known.has(flag)) {
      parsed.unknown.push(flag);
    }
  }

  if (parsed.unknown.length > 0) {
    parsed.valid = false;
    parsed.error = `Unrecognised flag(s): ${parsed.unknown.join(', ')}. Run with --help for usage.`;
    return parsed;
  }

  const candVal = flagValue(scan, ['--candidates']);
  if (candVal.present) {
    if (!candVal.value || candVal.missingValue) {
      parsed.valid = false;
      parsed.error = '--candidates requires a file path.';
      return parsed;
    }
    parsed.candidatesPath = candVal.value;
  }

  const stateVal = flagValue(scan, ['--review-state']);
  if (stateVal.present) {
    if (!stateVal.value || stateVal.missingValue) {
      parsed.valid = false;
      parsed.error = '--review-state requires a directory path.';
      return parsed;
    }
    parsed.reviewStateDir = stateVal.value;
  }

  const baseVal = flagValue(scan, ['--baselines']);
  if (baseVal.present) {
    if (!baseVal.value || baseVal.missingValue) {
      parsed.valid = false;
      parsed.error = '--baselines requires a directory path.';
      return parsed;
    }
    parsed.baselinesDir = baseVal.value;
  }

  const journeyVal = flagValue(scan, ['--journey']);
  if (journeyVal.present) {
    if (!journeyVal.value || journeyVal.missingValue) {
      parsed.valid = false;
      parsed.error = '--journey requires a file path.';
      return parsed;
    }
    parsed.journeyPath = journeyVal.value;
  }

  const execVal = flagValue(scan, ['--execution']);
  if (execVal.present) {
    if (!execVal.value || execVal.missingValue) {
      parsed.valid = false;
      parsed.error = '--execution requires a file path.';
      return parsed;
    }
    parsed.executionPath = execVal.value;
  }

  const anomVal = flagValue(scan, ['--anomalies']);
  if (anomVal.present) {
    if (!anomVal.value || anomVal.missingValue) {
      parsed.valid = false;
      parsed.error = '--anomalies requires a file path.';
      return parsed;
    }
    parsed.anomaliesPath = anomVal.value;
  }

  const reproVal = flagValue(scan, ['--reproduction']);
  if (reproVal.present) {
    if (!reproVal.value || reproVal.missingValue) {
      parsed.valid = false;
      parsed.error = '--reproduction requires a file path.';
      return parsed;
    }
    parsed.reproductionPath = reproVal.value;
  }

  const hostVal = flagValue(scan, ['--host']);
  if (hostVal.present) {
    if (!hostVal.value || hostVal.missingValue) {
      parsed.valid = false;
      parsed.error = '--host requires a valid hostname or IP address.';
      return parsed;
    }
    try {
      parsed.host = validateHost(hostVal.value);
    } catch (e) {
      parsed.valid = false;
      parsed.error = (e as Error).message;
      return parsed;
    }
  }

  const portVal = flagValue(scan, ['--port']);
  if (portVal.present) {
    if (!portVal.value || portVal.missingValue) {
      parsed.valid = false;
      parsed.error = '--port requires a port number.';
      return parsed;
    }
    try {
      parsed.port = validatePort(portVal.value);
    } catch (e) {
      parsed.valid = false;
      parsed.error = (e as Error).message;
      return parsed;
    }
  }

  return parsed;
}

/**
 * Execute the `review-api` CLI command.
 */
export async function runReviewApiCommand(
  argv: readonly string[],
  cwd: string = process.cwd(),
): Promise<number> {
  const parsed = parseReviewApiArgs(argv);
  if (!parsed.valid) {
    console.error(`Error: ${parsed.error}`);
    return 2;
  }

  let server: RunningReviewApiServer;
  try {
    server = await createReviewApiServer(
      {
        host: parsed.host,
        port: parsed.port,
        paths: {
          candidatesPath: parsed.candidatesPath,
          reviewStateDir: parsed.reviewStateDir,
          baselinesDir: parsed.baselinesDir,
          journeyPath: parsed.journeyPath,
          executionPath: parsed.executionPath,
          anomaliesPath: parsed.anomaliesPath,
          reproductionPath: parsed.reproductionPath,
        },
      },
      cwd,
    );
    await server.start();
  } catch (err) {
    console.error(`Error starting review API: ${(err as Error).message}`);
    return 1;
  }

  console.log(`CrashLab Review API listening on ${server.url} (read-only mode)`);
  console.log('Press Ctrl+C to stop.');

  return new Promise<number>((resolve) => {
    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log('\nShutting down review API...');
      try {
        await server.stop();
        console.log('Server stopped cleanly.');
        resolve(0);
      } catch (err) {
        console.error(`Error during shutdown: ${(err as Error).message}`);
        resolve(1);
      }
    };

    process.once('SIGINT', () => void shutdown());
    process.once('SIGTERM', () => void shutdown());
  });
}
