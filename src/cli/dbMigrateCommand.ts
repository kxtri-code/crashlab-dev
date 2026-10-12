/**
 * CrashLab db:migrate CLI command — Build 12A: PostgreSQL Adapter.
 *
 * Runs pending schema migrations against the configured PostgreSQL / Supabase database.
 * Never prints passwords, secrets, or raw connection strings.
 */

import {
  createPgPool,
  loadPostgresConfigFromEnv,
} from '../product/repository/postgresPool.js';
import { runMigrations } from '../product/repository/migrationRunner.js';

export const DB_MIGRATE_USAGE = `crashlab db:migrate

Run pending schema migrations against the configured PostgreSQL or Supabase database.

Usage:
  npm run db:migrate
  npx tsx src/cli.ts db:migrate [options]

Options:
  -h, --help      Show this help message

Environment:
  DATABASE_URL                PostgreSQL connection string (required)
  DATABASE_SSL                Enable TLS/SSL connection (true/false/require)
  DATABASE_CONNECT_TIMEOUT_MS Connection timeout in ms (default: 5000)

Exit codes:
  0: Migrations successfully executed
  1: Migration or database failure
  2: Invalid CLI arguments`;

export async function runDbMigrateCommand(argv: readonly string[]): Promise<number> {
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      console.log(DB_MIGRATE_USAGE);
      return 0;
    }
    if (arg.startsWith('-')) {
      console.error(`Invalid option: ${arg}\n`);
      console.error(DB_MIGRATE_USAGE);
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

    console.log(`Running migrations against PostgreSQL (${safeInfo.host}:${safeInfo.port}/${safeInfo.database})...`);

    const result = await runMigrations(pool);
    await pool.end();

    if (result.applied.length > 0) {
      console.log(`Successfully applied ${result.applied.length} migration(s):`);
      for (const m of result.applied) {
        console.log(`  + ${m}`);
      }
    } else {
      console.log(`Database is up to date (${result.alreadyApplied.length} migrations already applied).`);
    }

    return 0;
  } catch (err: unknown) {
    console.error(`Database migration failed: ${(err as Error)?.message ?? String(err)}`);
    return 1;
  }
}
