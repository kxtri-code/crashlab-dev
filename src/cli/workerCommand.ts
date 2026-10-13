/**
 * CLI Worker Dispatcher Command — Build 12B.2B.
 *
 * Runs the asynchronous background queue worker.
 * Supports:
 *   --once             Process at most one queued run and exit cleanly
 *   --poll-ms <n>      Polling frequency in milliseconds (default: 1000)
 *   --worker-id <id>   Worker identifier (must be safe string)
 *   --help, -h         Display usage instructions
 */

import { resolveProductRepositories } from '../product/storage.js';
import { resolveBlobStore } from '../product/blob/config.js';
import { RunDispatcher } from '../product/queue/dispatcher.js';
import { WorkerLoop } from '../product/queue/workerLoop.js';
import { DeterministicMockWorker } from '../product/queue/worker.js';
import { assertSafeWorkerId, loadWorkerConfigFromEnv } from '../product/queue/types.js';

export const WORKER_USAGE = `CrashLab Worker Dispatcher (Build 12B.2B)

Usage:
  npm run worker -- [options]
  npx tsx src/cli.ts worker [options]

Options:
  --once             Claim and execute at most one run, then exit cleanly
  --poll-ms <ms>     Polling interval in milliseconds (default: 1000, min: 100)
  --worker-id <id>   Unique safe identifier for this worker instance
  --help, -h         Show this help message

Environment Variables:
  PRODUCT_WORKER_ENABLED       Enable worker (true/false, default: false)
  PRODUCT_WORKER_ID            Worker ID override
  PRODUCT_WORKER_POLL_MS       Polling interval override
  PRODUCT_WORKER_LEASE_SECONDS Worker lease expiry in seconds (default: 60)
`;

export interface ParsedWorkerArgs {
  readonly once: boolean;
  readonly pollMs: number;
  readonly workerId: string;
  readonly showHelp: boolean;
}

export function parseWorkerArgs(argv: readonly string[]): ParsedWorkerArgs {
  let once = false;
  let showHelp = false;
  let pollMs = 1000;
  let workerId = `worker-${process.pid}`;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--help' || arg === '-h') {
      showHelp = true;
    } else if (arg === '--once') {
      once = true;
    } else if (arg === '--poll-ms' && i + 1 < argv.length) {
      const val = parseInt(argv[++i]!, 10);
      if (Number.isFinite(val) && val >= 100) {
        pollMs = val;
      }
    } else if (arg.startsWith('--poll-ms=')) {
      const val = parseInt(arg.slice('--poll-ms='.length), 10);
      if (Number.isFinite(val) && val >= 100) {
        pollMs = val;
      }
    } else if (arg === '--worker-id' && i + 1 < argv.length) {
      workerId = argv[++i]!.trim();
    } else if (arg.startsWith('--worker-id=')) {
      workerId = arg.slice('--worker-id='.length).trim();
    }
  }

  return { once, pollMs, workerId, showHelp };
}

export async function runWorkerCommand(argv: readonly string[]): Promise<number> {
  const args = parseWorkerArgs(argv);

  if (args.showHelp) {
    console.log(WORKER_USAGE);
    return 0;
  }

  try {
    assertSafeWorkerId(args.workerId);
  } catch (err) {
    console.error(`Invalid worker configuration: ${(err as Error).message}`);
    return 1;
  }

  const envConfig = loadWorkerConfigFromEnv();
  const pollMs = args.pollMs ?? envConfig.pollMs;
  const workerId = args.workerId ?? envConfig.workerId;
  const leaseSeconds = envConfig.leaseSeconds;

  console.log(`Starting CrashLab Worker [${workerId}] (poll: ${pollMs}ms, lease: ${leaseSeconds}s, once: ${args.once})...`);

  // Resolve storage repositories
  const { repositories, pool } = resolveProductRepositories();
  const blobStore = resolveBlobStore();

  if (!repositories.queue) {
    console.error('Run queue repository is not configured.');
    return 1;
  }

  // Inject deterministic unit/local mock worker
  const worker = new DeterministicMockWorker();

  const dispatcher = new RunDispatcher({
    queue: repositories.queue,
    repositories,
    worker,
    blobStore,
    workerId,
    leaseSeconds,
  });

  const workerLoop = new WorkerLoop({
    dispatcher,
    config: {
      enabled: true,
      workerId,
      pollMs,
      leaseSeconds,
      maxConcurrency: 1,
    },
    onDispatched: (result) => {
      if (result) {
        console.log(`[Worker ${workerId}] Dispatched run "${result.runId}" -> ${result.status}`);
      }
    },
    onError: (err) => {
      console.error(`[Worker ${workerId}] Error: ${err.message}`);
    },
  });

  if (args.once) {
    try {
      const result = await workerLoop.runOnce();
      if (result) {
        console.log(`Dispatched 1 run: ${result.runId} (${result.status})`);
      } else {
        console.log('No eligible runs found in queue.');
      }
      return 0;
    } finally {
      await worker.close();
      await blobStore.close();
      if (pool) {
        await pool.end();
      }
    }
  }

  // Continuous loop
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\nGracefully stopping worker...');
    await workerLoop.stop();
    await worker.close();
    await blobStore.close();
    if (pool) {
      await pool.end();
    }
    console.log('Worker stopped cleanly.');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await workerLoop.start();
  console.log(`Worker active. Waiting for queued runs. Press Ctrl+C to terminate.`);

  return 0;
}
