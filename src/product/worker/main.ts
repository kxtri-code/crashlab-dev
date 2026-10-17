/**
 * CrashLab Worker Main Entry Point — Build 12D.2B.
 *
 * Dedicated standalone worker process consuming queued runs from PostgreSQL.
 *
 * Usage:
 *   npm run worker -- [options]
 *   npx tsx src/product/worker/main.ts [options]
 *
 * Options:
 *   --once                 Claim and process at most one run, then exit cleanly
 *   --poll-ms <n>          Polling interval in milliseconds (default: 1000)
 *   --worker-id <id>       Unique safe worker identifier
 *   --health-port <port>   Internal health HTTP server port (default: 3230)
 *   --concurrency <n>      Max concurrent runs (1..10, default: 1)
 *   -h, --help             Show this help message
 *
 * Exit codes:
 *   0: Clean execution or graceful termination
 *   1: Operational or configuration error (e.g. worker disabled)
 *   2: Invalid CLI arguments or syntax error
 */

import {
  loadWorkerServiceConfigFromEnv,
  validateWorkerServiceConfig,
  type WorkerServiceConfig,
} from './config.js';
import { WorkerService } from './service.js';

export const WORKER_CLI_USAGE = `crashlab worker (Build 12D.2B)

Dedicated execution worker service consuming queued runs from PostgreSQL.

Usage:
  npm run worker -- [options]
  npx tsx src/product/worker/main.ts [options]

Options:
  --once                 Claim and process at most one run, then exit cleanly
  --poll-ms <n>          Polling interval in milliseconds (default: 1000)
  --worker-id <id>       Unique safe worker identifier (alphanumeric, dash, dot, underscore)
  --health-port <port>   Internal health HTTP server port (default: 3230)
  --concurrency <n>      Max concurrent runs processed (1..10, default: 1)
  -h, --help             Show this help message

Environment Variables:
  PRODUCT_WORKER_ENABLED               Must be 'true' to allow worker execution (default: false)
  PRODUCT_WORKER_ID                    Worker instance identifier
  PRODUCT_WORKER_POLL_MS               Polling frequency in ms (100..60000)
  PRODUCT_WORKER_LEASE_SECONDS         Lease duration in seconds (5..600)
  PRODUCT_WORKER_MAX_CONCURRENCY       Max parallel runs (1..10)
  PRODUCT_WORKER_SHUTDOWN_TIMEOUT_MS   Max time to wait for active runs on shutdown (default: 30000)
  PRODUCT_WORKER_HEALTH_PORT           Health/readiness port (default: 3230)
  DATABASE_URL                         PostgreSQL connection string (required in production)
  PRODUCT_BLOB_STORE                   Storage provider ('local' | 'supabase')
  SUPABASE_URL                         Supabase project URL (when storage is supabase)
  SUPABASE_STORAGE_BUCKET              Private artifact bucket name
  SUPABASE_SERVICE_ROLE_KEY            Server-only service-role secret key (masked)

Exit codes:
  0: Success / clean shutdown
  1: Operational or configuration error (e.g. worker disabled)
  2: Invalid CLI arguments or syntax error
`;

export interface ParsedWorkerCliArgs {
  readonly once: boolean;
  readonly pollMs?: number;
  readonly workerId?: string;
  readonly healthPort?: number;
  readonly concurrency?: number;
  readonly showHelp: boolean;
}

export function parseWorkerCliArgs(argv: readonly string[]): {
  args: ParsedWorkerCliArgs;
  error?: string;
} {
  let once = false;
  let showHelp = false;
  let pollMs: number | undefined;
  let workerId: string | undefined;
  let healthPort: number | undefined;
  let concurrency: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--help' || arg === '-h') {
      showHelp = true;
    } else if (arg === '--once') {
      once = true;
    } else if (arg === '--poll-ms') {
      if (i + 1 >= argv.length) return { args: { once: false, showHelp: false }, error: 'Missing value for --poll-ms' };
      const val = parseInt(argv[++i]!, 10);
      if (!Number.isFinite(val) || val < 100) return { args: { once: false, showHelp: false }, error: 'Invalid value for --poll-ms: must be >= 100' };
      pollMs = val;
    } else if (arg.startsWith('--poll-ms=')) {
      const val = parseInt(arg.slice('--poll-ms='.length), 10);
      if (!Number.isFinite(val) || val < 100) return { args: { once: false, showHelp: false }, error: 'Invalid value for --poll-ms: must be >= 100' };
      pollMs = val;
    } else if (arg === '--worker-id') {
      if (i + 1 >= argv.length) return { args: { once: false, showHelp: false }, error: 'Missing value for --worker-id' };
      workerId = argv[++i]!.trim();
    } else if (arg.startsWith('--worker-id=')) {
      workerId = arg.slice('--worker-id='.length).trim();
    } else if (arg === '--health-port') {
      if (i + 1 >= argv.length) return { args: { once: false, showHelp: false }, error: 'Missing value for --health-port' };
      const val = parseInt(argv[++i]!, 10);
      if (!Number.isFinite(val) || val < 1 || val > 65535) return { args: { once: false, showHelp: false }, error: 'Invalid value for --health-port: must be 1..65535' };
      healthPort = val;
    } else if (arg.startsWith('--health-port=')) {
      const val = parseInt(arg.slice('--health-port='.length), 10);
      if (!Number.isFinite(val) || val < 1 || val > 65535) return { args: { once: false, showHelp: false }, error: 'Invalid value for --health-port: must be 1..65535' };
      healthPort = val;
    } else if (arg === '--concurrency') {
      if (i + 1 >= argv.length) return { args: { once: false, showHelp: false }, error: 'Missing value for --concurrency' };
      const val = parseInt(argv[++i]!, 10);
      if (!Number.isFinite(val) || val < 1 || val > 10) return { args: { once: false, showHelp: false }, error: 'Invalid value for --concurrency: must be 1..10' };
      concurrency = val;
    } else if (arg.startsWith('--concurrency=')) {
      const val = parseInt(arg.slice('--concurrency='.length), 10);
      if (!Number.isFinite(val) || val < 1 || val > 10) return { args: { once: false, showHelp: false }, error: 'Invalid value for --concurrency: must be 1..10' };
      concurrency = val;
    } else {
      return { args: { once: false, showHelp: false }, error: `Unrecognized option: "${arg}". Run with --help for usage.` };
    }
  }

  return {
    args: { once, pollMs, workerId, healthPort, concurrency, showHelp },
  };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseWorkerCliArgs(argv);
  if (parsed.error) {
    console.error(`ERROR: ${parsed.error}`);
    console.error(`Run "npm run worker -- --help" for supported options.`);
    return 2;
  }

  if (parsed.args.showHelp) {
    console.log(WORKER_CLI_USAGE);
    return 0;
  }

  const baseConfig = loadWorkerServiceConfigFromEnv();
  const config: WorkerServiceConfig = {
    ...baseConfig,
    workerId: parsed.args.workerId ?? baseConfig.workerId,
    pollMs: parsed.args.pollMs ?? baseConfig.pollMs,
    healthPort: parsed.args.healthPort ?? baseConfig.healthPort,
    maxConcurrency: parsed.args.concurrency ?? baseConfig.maxConcurrency,
  };

  const validation = validateWorkerServiceConfig(config);
  if (!validation.valid) {
    console.error('FATAL: Worker configuration validation failed:');
    for (const err of validation.errors) {
      console.error(`  - ${err}`);
    }
    return 1;
  }

  // Refuse if worker is disabled
  if (!config.enabled) {
    console.error(`REFUSED: CrashLab Worker is disabled (PRODUCT_WORKER_ENABLED=false).`);
    console.error(`Set PRODUCT_WORKER_ENABLED=true in server environment to enable worker execution.`);
    return 1;
  }

  const service = new WorkerService({ config });

  if (parsed.args.once) {
    console.log(`[Worker ${config.workerId}] Starting in --once mode...`);
    try {
      const result = await service.runOnce();
      if (result) {
        console.log(`[Worker ${config.workerId}] Executed run "${result.runId}" -> status: ${result.status}`);
      } else {
        console.log(`[Worker ${config.workerId}] No eligible queued runs found.`);
      }
      return 0;
    } catch (err) {
      console.error(`[Worker ${config.workerId}] Error in --once mode: ${(err as Error).message}`);
      return 1;
    }
  }

  console.log(`============================================================`);
  console.log(`CRASHLAB WORKER SERVICE (Build 12D.2B)`);
  console.log(`============================================================`);
  console.log(`Worker ID:       ${config.workerId}`);
  console.log(`Poll Frequency:  ${config.pollMs}ms`);
  console.log(`Lease Duration:  ${config.leaseSeconds}s`);
  console.log(`Max Concurrency: ${config.maxConcurrency}`);
  console.log(`Health Port:     http://0.0.0.0:${config.healthPort}`);
  console.log(`Storage:         ${config.storage} | Blob: ${config.blobStore}`);
  console.log(`Safe Test Mode:  ENABLED (Hardcoded invariant)`);
  console.log(`============================================================`);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[Worker ${config.workerId}] SIGINT/SIGTERM received. Gracefully stopping...`);
    try {
      await service.stop();
      console.log(`[Worker ${config.workerId}] Stopped cleanly.`);
      process.exit(0);
    } catch (err) {
      console.error(`[Worker ${config.workerId}] Error during shutdown: ${(err as Error).message}`);
      process.exit(1);
    }
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await service.start();
    console.log(`[Worker ${config.workerId}] Worker loop active. Polling run queue...`);
    return 0;
  } catch (err) {
    console.error(`FATAL: Failed to start worker service: ${(err as Error).message}`);
    await service.close().catch(() => {});
    return 1;
  }
}

// Direct execution guard
const normalizedArgv1 = process.argv[1]?.replace(/\\/g, '/') || '';
const isMain = Boolean(
  normalizedArgv1 && (
    normalizedArgv1.endsWith('worker/main.ts') ||
    normalizedArgv1.endsWith('worker/main.js')
  )
);

if (isMain) {
  main().then((code) => {
    if (code !== 0) {
      process.exit(code);
    }
  }).catch((err) => {
    console.error(`Unexpected worker failure: ${(err as Error).message}`);
    process.exit(1);
  });
}
