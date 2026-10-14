/**
 * CLI Worker Dispatcher Command — Build 12D.2B.
 *
 * Runs the asynchronous background queue worker.
 * Delegates directly to the standalone worker entry point at src/product/worker/main.ts.
 */

import { WORKER_CLI_USAGE, main, parseWorkerCliArgs } from '../product/worker/main.js';

export const WORKER_USAGE = WORKER_CLI_USAGE;

export interface ParsedWorkerArgs {
  readonly once: boolean;
  readonly pollMs?: number;
  readonly workerId?: string;
  readonly healthPort?: number;
  readonly concurrency?: number;
  readonly showHelp: boolean;
}

export function parseWorkerArgs(argv: readonly string[]): ParsedWorkerArgs {
  const parsed = parseWorkerCliArgs(argv);
  return parsed.args;
}

export async function runWorkerCommand(argv: readonly string[]): Promise<number> {
  return main(argv);
}
