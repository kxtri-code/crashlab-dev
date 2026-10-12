/**
 * CrashLab db:check CLI command — Build 12A: PostgreSQL Adapter.
 *
 * Verifies connectivity to the configured PostgreSQL / Supabase database.
 * Never prints passwords, secrets, or raw connection strings.
 */

import {
  createPgPool,
  loadPostgresConfigFromEnv,
} from '../product/repository/postgresPool.js';

export const DB_CHECK_USAGE = `crashlab db:check

Check connectivity to the configured PostgreSQL or Supabase database.

Usage:
  npm run db:check
  npx tsx src/cli.ts db:check [options]

Options:
  -h, --help      Show this help message

Environment:
  DATABASE_URL                PostgreSQL connection string (required)
  DATABASE_SSL                Enable TLS/SSL connection (true/false/require)
  DATABASE_CONNECT_TIMEOUT_MS Connection timeout in ms (default: 5000)

Exit codes:
  0: Database connection verified
  1: Connection or configuration failure
  2: Invalid CLI arguments`;

export async function runDbCheckCommand(argv: readonly string[]): Promise<number> {
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      console.log(DB_CHECK_USAGE);
      return 0;
    }
    // Any other flag is invalid
    if (arg.startsWith('-')) {
      console.error(`Invalid option: ${arg}\n`);
      console.error(DB_CHECK_USAGE);
      return 2;
    }
  }

  const config = loadPostgresConfigFromEnv();
  if (!config.databaseUrl) {
    console.error('DATABASE_URL is required for this command.');
    return 1;
  }

  try {
    const pool = createPgPool(config);
    const safeInfo = pool.getSafeTargetInfo();

    console.log(`Checking connection to PostgreSQL (${safeInfo.host}:${safeInfo.port}/${safeInfo.database})...`);

    const client = await pool.connect();
    try {
      await client.query('SELECT 1;');
    } finally {
      client.release();
    }
    await pool.end();

    console.log('Database connection verified successfully.');
    console.log(`Target: host=${safeInfo.host}, port=${safeInfo.port}, database=${safeInfo.database}, ssl=${safeInfo.ssl}`);
    return 0;
  } catch (err: unknown) {
    console.error(`Database connection failed: ${(err as Error)?.message ?? String(err)}`);
    return 1;
  }
}
