/**
 * CrashLab auth:token CLI Command — Build 12B.1: Local Authentication.
 *
 * Generates a signed development bearer token for testing and local API calls.
 * Available only in local/development contexts. Never prints signing secrets.
 */

import { createDevToken, loadAuthConfigFromEnv } from '../product/index.js';

export const AUTH_TOKEN_USAGE = `crashlab auth:token

Generate a signed development bearer token for testing or local product API calls.

Usage:
  npm run auth:token -- --user <userId> [options]
  npx tsx src/cli.ts auth:token --user <userId> [options]

Options:
  -u, --user <userId>       User ID for token identity (required)
  -e, --expires <seconds>   Token lifetime in seconds (default: 3600 / 1 hour)
  -h, --help                Show this message

Environment:
  PRODUCT_AUTH_MODE         Authentication mode (development | production)
  PRODUCT_AUTH_SECRET       Secret used to sign the token

Exit codes:
  0: Token generated successfully
  1: Token generation failed
  2: Invalid CLI arguments`;

export async function runAuthTokenCommand(argv: readonly string[]): Promise<number> {
  let userId: string | null = null;
  let expiresInSeconds = 3600;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log(AUTH_TOKEN_USAGE);
      return 0;
    }

    if (arg === '--user' || arg === '-u') {
      const next = argv[i + 1];
      if (!next || next.startsWith('-')) {
        console.error('Error: Option --user requires a non-empty user ID value.\n');
        console.error(AUTH_TOKEN_USAGE);
        return 2;
      }
      userId = next.trim();
      i += 1;
      continue;
    }

    if (arg?.startsWith('--user=')) {
      userId = arg.slice(7).trim();
      continue;
    }

    if (arg === '--expires' || arg === '-e') {
      const next = argv[i + 1];
      if (!next || isNaN(parseInt(next, 10))) {
        console.error('Error: Option --expires requires an integer seconds value.\n');
        console.error(AUTH_TOKEN_USAGE);
        return 2;
      }
      expiresInSeconds = parseInt(next, 10);
      i += 1;
      continue;
    }

    if (arg?.startsWith('--expires=')) {
      const val = parseInt(arg.slice(10), 10);
      if (isNaN(val)) {
        console.error('Error: Option --expires requires an integer seconds value.\n');
        return 2;
      }
      expiresInSeconds = val;
      continue;
    }

    if (arg?.startsWith('-')) {
      console.error(`Invalid option: ${arg}\n`);
      console.error(AUTH_TOKEN_USAGE);
      return 2;
    }
  }

  if (!userId) {
    console.error('Error: User ID is required. Use --user <userId>.\n');
    console.error(AUTH_TOKEN_USAGE);
    return 2;
  }

  try {
    const authConfig = loadAuthConfigFromEnv();
    const token = createDevToken({
      userId,
      secret: authConfig.authSecret,
      expiresInSeconds,
    });

    const expDate = new Date(Date.now() + expiresInSeconds * 1000).toISOString();

    console.log(`Generated Development Token for user: "${userId}"`);
    console.log(`Token:      ${token}`);
    console.log(`Header:     Authorization: Bearer ${token}`);
    console.log(`Expires At: ${expDate}`);
    console.log(`Mode:       ${authConfig.authMode}`);
    console.log('');
    console.log('NOTICE: Development token for local test use only. Never commit or share.');
    return 0;
  } catch (err) {
    console.error(`Failed to generate token: ${(err as Error)?.message ?? String(err)}`);
    return 1;
  }
}
