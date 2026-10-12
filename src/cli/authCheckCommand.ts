/**
 * CrashLab auth:check CLI Command — Build 12B.1: Local Authentication.
 *
 * Verifies current authentication and storage configuration without leaking secrets.
 */

import { loadAuthConfigFromEnv, loadStorageConfigFromEnv, extractSafeTargetInfo } from '../product/index.js';

export const AUTH_CHECK_USAGE = `crashlab auth:check

Verify the current product authentication mode and storage configuration.
Never prints signing secrets, passwords, or raw connection strings.

Usage:
  npm run auth:check
  npx tsx src/cli.ts auth:check [options]

Options:
  -h, --help    Show this message

Environment:
  PRODUCT_AUTH_MODE     Authentication mode (development | production)
  PRODUCT_AUTH_SECRET   Token signing secret (masked)
  PRODUCT_STORAGE       Storage provider (in-memory | postgres)
  DATABASE_URL          PostgreSQL connection URL (masked, host/db only)

Exit codes:
  0: Configuration successfully verified
  1: Configuration error
  2: Invalid CLI arguments`;

export async function runAuthCheckCommand(argv: readonly string[]): Promise<number> {
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      console.log(AUTH_CHECK_USAGE);
      return 0;
    }
    if (arg.startsWith('-')) {
      console.error(`Invalid option: ${arg}\n`);
      console.error(AUTH_CHECK_USAGE);
      return 2;
    }
  }

  const authConfig = loadAuthConfigFromEnv();
  const storageConfig = loadStorageConfigFromEnv();

  console.log('CrashLab Product Configuration Check:');
  console.log('--------------------------------------------------');
  console.log(`Authentication Mode: ${authConfig.authMode}`);
  const secretDisplay = authConfig.authSecret
    ? `[configured: ${authConfig.authSecret.length} chars]`
    : '[not configured]';
  console.log(`Auth Secret Status:  ${secretDisplay}`);
  console.log(`Storage Provider:    ${storageConfig.storage}`);

  if (storageConfig.storage === 'postgres') {
    if (storageConfig.databaseUrl) {
      const target = extractSafeTargetInfo(storageConfig.databaseUrl);
      console.log(`Database Target:     host=${target.host}, port=${target.port}, database=${target.database}, ssl=${target.ssl}`);
    } else {
      console.log('Database Target:     [MISSING DATABASE_URL]');
      console.error('\nWarning: PRODUCT_STORAGE=postgres is configured, but DATABASE_URL is missing.');
      return 1;
    }
  } else {
    console.log('Database Target:     (In-Memory Transient Storage)');
  }

  console.log('--------------------------------------------------');
  console.log('Configuration verified successfully.');
  return 0;
}
