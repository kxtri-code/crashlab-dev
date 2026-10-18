/**
 * CrashLab Product API & Dashboard Server — Build 12E: Render Deployment Package.
 *
 * Dedicated standalone HTTP server entry point for Render Web Service:
 * - Hosts Product API (/api/v1/*), /health, /readiness, and Dashboard UI shell
 * - Binds to 0.0.0.0 and honors $PORT (Render standard)
 * - Fails closed on startup if production environment is invalid
 * - Strict process isolation: NEVER runs worker loop, NEVER launches browsers
 * - Never executes database migrations automatically
 * - Graceful shutdown on SIGTERM / SIGINT
 */

import process from 'node:process';
import { validateProductionEnvironment } from '../deployment/readiness.js';
import { createProductApiServer, type ProductApiServer } from './server.js';
import { DEFAULT_PRODUCT_API_PORT, DEFAULT_PRODUCT_API_HOST } from './types.js';

export interface ParsedApiCliArgs {
  readonly host?: string;
  readonly port?: number;
  readonly showHelp: boolean;
}

export function parseApiCliArgs(argv: readonly string[]): {
  args: ParsedApiCliArgs;
  error?: string;
} {
  let showHelp = false;
  let host: string | undefined;
  let port: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--help' || arg === '-h') {
      showHelp = true;
    } else if (arg === '--host') {
      if (i + 1 >= argv.length) return { args: { showHelp: false }, error: 'Missing value for --host' };
      host = argv[++i]!;
    } else if (arg.startsWith('--host=')) {
      host = arg.slice('--host='.length);
    } else if (arg === '--port') {
      if (i + 1 >= argv.length) return { args: { showHelp: false }, error: 'Missing value for --port' };
      const parsed = parseInt(argv[++i]!, 10);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 65535) {
        return { args: { showHelp: false }, error: 'Invalid port number' };
      }
      port = parsed;
    } else if (arg.startsWith('--port=')) {
      const parsed = parseInt(arg.slice('--port='.length), 10);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 65535) {
        return { args: { showHelp: false }, error: 'Invalid port number' };
      }
      port = parsed;
    } else if (arg.startsWith('-')) {
      return { args: { showHelp: false }, error: `Unrecognised option: ${arg}` };
    }
  }

  return { args: { host, port, showHelp } };
}

export const API_CLI_USAGE = `crashlab api (Build 12E)

Production API and Dashboard server for CrashLab.

Usage:
  npm run api -- [options]
  node dist/src/product/api/main.js [options]

Options:
  --host <host>          Host interface to bind [default: 0.0.0.0 or $HOST]
  --port <port>          Port to listen on      [default: 3220 or $PORT]
  -h, --help             Show this help message

Environment:
  PORT                   Port number to bind (standard Render Web Service variable)
  HOST                   Host IP to bind (default: 0.0.0.0)
  PRODUCT_AUTH_MODE      Authentication mode ('production' | 'development')
  PRODUCT_STORAGE        Storage backend ('postgres' | 'in-memory')
  DATABASE_URL           PostgreSQL connection URL
  PRODUCT_BLOB_STORE     Blob storage provider ('supabase' | 'local' | 's3')
  SUPABASE_URL           Supabase project URL
  SUPABASE_STORAGE_BUCKET Supabase artifact bucket name
  SUPABASE_SERVICE_ROLE_KEY Supabase service-role key (masked)
  PRODUCT_CORS_ALLOWED_ORIGINS Comma-separated allowed CORS origins

Security Invariants:
  - Fails closed on invalid production configuration.
  - Zero browser execution.
  - Zero background worker loops (never starts worker).
  - Never executes database migrations automatically.
`;

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const { args, error } = parseApiCliArgs(argv);

  if (error) {
    console.error(`Error: ${error}`);
    console.log(API_CLI_USAGE);
    return 2;
  }

  if (args.showHelp) {
    console.log(API_CLI_USAGE);
    return 0;
  }

  // 1. Production environment validation
  const rawAuthMode = process.env.PRODUCT_AUTH_MODE?.trim().toLowerCase();
  const isProduction = rawAuthMode === 'production' || !rawAuthMode;

  if (isProduction) {
    const validation = validateProductionEnvironment(process.env);
    if (!validation.valid) {
      console.error('[FATAL CONFIG ERROR] Production environment validation failed:');
      for (const err of validation.errors) {
        console.error(`  - ${err}`);
      }
      return 1;
    }
  }

  // 2. Resolve port and host
  const rawPort =
    args.port ??
    (process.env.PORT ? parseInt(process.env.PORT, 10) : DEFAULT_PRODUCT_API_PORT);
  const host = args.host ?? process.env.HOST ?? DEFAULT_PRODUCT_API_HOST;

  const storageType =
    process.env.PRODUCT_STORAGE === 'postgres'
      ? 'postgres'
      : isProduction
        ? 'postgres'
        : 'in-memory';

  const rawCors = process.env.PRODUCT_CORS_ALLOWED_ORIGINS?.trim();
  const corsAllowedOrigins = rawCors
    ? rawCors.split(',').map((s) => s.trim()).filter(Boolean)
    : undefined;

  // 3. Instantiate server
  let server: ProductApiServer;
  try {
    server = createProductApiServer({
      host,
      port: rawPort,
      storage: storageType,
      databaseUrl: process.env.DATABASE_URL,
      serveDashboard: true,
      corsAllowedOrigins,
      supabaseUrl: process.env.SUPABASE_URL,
      supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
    });
  } catch (err) {
    console.error(`[FATAL] Failed to initialize Product API server: ${(err as Error).message}`);
    return 1;
  }

  // 4. Start HTTP listener
  let bound: { url: string; port: number };
  try {
    bound = await server.start();
  } catch (err) {
    console.error(
      `[FATAL] Failed to bind Product API server to ${host}:${rawPort}: ${(err as Error).message}`,
    );
    return 1;
  }

  console.log('============================================================');
  console.log('CRASHLAB PRODUCT API & DASHBOARD SERVER (Build 12E)');
  console.log('============================================================');
  console.log(`Listening on:          ${bound.url} (${host}:${bound.port})`);
  console.log(`Authentication Mode:   ${isProduction ? 'production' : 'development'}`);
  console.log(`Storage Provider:      ${storageType}`);
  console.log(`Blob Store Provider:   ${process.env.PRODUCT_BLOB_STORE || 'local'}`);
  console.log(`Worker Fleet Status:   DISABLED (API process never executes worker)`);
  console.log(`Database Migrations:   MANUAL ONLY (never run during HTTP traffic)`);
  console.log('============================================================');

  // 5. Graceful shutdown handler
  let shuttingDown = false;
  const onSignal = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nReceived ${signal}, gracefully terminating Product API server...`);
    try {
      await server.stop();
      console.log('Product API server stopped cleanly.');
      process.exit(0);
    } catch (err) {
      console.error(`Error during server shutdown: ${(err as Error).message}`);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void onSignal('SIGTERM'));
  process.on('SIGINT', () => void onSignal('SIGINT'));

  return 0;
}

// Auto-run if executed directly as entrypoint
const normalizedArgv1 = process.argv[1]?.replace(/\\/g, '/') || '';
if (
  normalizedArgv1 &&
  (normalizedArgv1.endsWith('api/main.ts') || normalizedArgv1.endsWith('api/main.js'))
) {
  main().then((code) => {
    if (code !== 0) {
      process.exit(code);
    }
  });
}
