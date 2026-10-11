/**
 * The `review-ui` CLI command (Build 9.2).
 *
 * Launches a local, read-only browser interface for inspecting CrashLab candidate findings.
 *
 * Exits:
 *   0  clean shutdown (SIGINT / SIGTERM)
 *   1  server or network error
 *   2  bad arguments
 */

import process from 'node:process';
import { flagValue, scanArgs } from './args.js';
import { TOOL_NAME, TOOL_VERSION } from '../version.js';
import { createReviewUiServer } from '../reviewUi/staticServer.js';
import type { RunningReviewUiServer } from '../reviewUi/types.js';
import { DEFAULT_UI_HOST, DEFAULT_UI_PORT, DEFAULT_API_URL } from '../reviewUi/types.js';
import { validateHost, validatePort } from '../reviewApi/validator.js';

export const REVIEW_UI_FLAGS = [
  '--api-url',
  '--host',
  '--port',
  '--no-open',
  '--help',
  '-h',
] as const;

export const REVIEW_UI_USAGE = `${TOOL_NAME} v${TOOL_VERSION} - Review UI (Local Browser Interface)

Usage:
  npm run review-ui -- [options]
  npx tsx src/cli.ts review-ui [options]

Options:
  --api-url <url>         Backing Review API endpoint  [default: ${DEFAULT_API_URL}]
  --host <host>           Host IP to bind UI server    [default: ${DEFAULT_UI_HOST}]
  --port <port>           Port number for UI server    [default: ${DEFAULT_UI_PORT}]
  --no-open               Do not open browser on start
  -h, --help              Show this message

Read-Only Guarantees:
  - Browser UI consumes the Read-Only Review API exclusively.
  - UI never mutates files or executes review-state writes directly.
  - Non-negotiable trust invariants: confirmedBug: false and confirmed: false.
  - Human review decisions are made via the CLI: npm run review-state.`;

export interface ParsedReviewUiArgs {
  apiUrl: string;
  host: string;
  port: number;
  noOpen: boolean;
  valid: boolean;
  error: string | null;
  unknown: string[];
}

export function parseReviewUiArgs(argv: readonly string[]): ParsedReviewUiArgs {
  const scan = scanArgs(argv);
  const parsed: ParsedReviewUiArgs = {
    apiUrl: DEFAULT_API_URL,
    host: DEFAULT_UI_HOST,
    port: DEFAULT_UI_PORT,
    noOpen: false,
    valid: true,
    error: null,
    unknown: [],
  };

  const known = new Set<string>(REVIEW_UI_FLAGS);
  for (const flag of scan.flags.keys()) {
    if (!known.has(flag)) {
      parsed.unknown.push(flag);
    }
  }

  if (parsed.unknown.length > 0) {
    parsed.valid = false;
    parsed.error = `Unknown option: ${parsed.unknown.join(', ')}`;
    return parsed;
  }

  if (scan.flags.has('--no-open')) {
    parsed.noOpen = true;
  }

  const apiVal = flagValue(scan, ['--api-url']);
  if (apiVal.present) {
    if (!apiVal.value || apiVal.missingValue || !apiVal.value.trim()) {
      parsed.valid = false;
      parsed.error = '--api-url requires a non-empty URL string';
      return parsed;
    }
    try {
      new URL(apiVal.value.trim());
      parsed.apiUrl = apiVal.value.trim();
    } catch {
      parsed.valid = false;
      parsed.error = `--api-url must be a valid URL (got "${apiVal.value}")`;
      return parsed;
    }
  }

  const hostVal = flagValue(scan, ['--host']);
  if (hostVal.present) {
    if (!hostVal.value || hostVal.missingValue) {
      parsed.valid = false;
      parsed.error = '--host requires an IP address string';
      return parsed;
    }
    try {
      parsed.host = validateHost(hostVal.value);
    } catch (err) {
      parsed.valid = false;
      parsed.error = (err as Error).message;
      return parsed;
    }
  }

  const portVal = flagValue(scan, ['--port']);
  if (portVal.present) {
    if (!portVal.value || portVal.missingValue) {
      parsed.valid = false;
      parsed.error = '--port requires an integer value';
      return parsed;
    }
    const num = Number(portVal.value);
    if (!Number.isInteger(num)) {
      parsed.valid = false;
      parsed.error = `--port must be an integer (got "${portVal.value}")`;
      return parsed;
    }
    try {
      parsed.port = validatePort(num);
    } catch (err) {
      parsed.valid = false;
      parsed.error = (err as Error).message;
      return parsed;
    }
  }

  return parsed;
}

export async function runReviewUiCommand(
  argv: readonly string[],
): Promise<number> {
  const parsed = parseReviewUiArgs(argv);
  if (!parsed.valid) {
    console.error(`Error: ${parsed.error}`);
    console.error(`Run "${TOOL_NAME} review-ui --help" for usage.`);
    return 2;
  }

  let server: RunningReviewUiServer | null = null;

  try {
    server = await createReviewUiServer({
      host: parsed.host,
      port: parsed.port,
      apiUrl: parsed.apiUrl,
      noOpen: parsed.noOpen,
    });

    console.log(`CrashLab Review UI running at ${server.url}`);
    console.log(`Connected to Review API: ${server.apiUrl}`);
    console.log(`Read-Only Mode: All mutations prohibited in UI.`);
    console.log(`To record human review decisions, run: npm run review-state`);
    console.log(`Press Ctrl+C to exit.`);

    // Handle graceful shutdown
    await new Promise<void>((resolve) => {
      const shutdown = () => {
        process.removeListener('SIGINT', shutdown);
        process.removeListener('SIGTERM', shutdown);
        console.log('\nStopping CrashLab Review UI server...');
        if (server) {
          server
            .stop()
            .then(() => resolve())
            .catch((err) => {
              console.error('Error during shutdown:', err);
              resolve();
            });
        } else {
          resolve();
        }
      };

      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    });

    return 0;
  } catch (error) {
    console.error(`Review UI server failed: ${(error as Error)?.message ?? String(error)}`);
    if (server) {
      await server.stop().catch(() => {});
    }
    return 1;
  }
}
