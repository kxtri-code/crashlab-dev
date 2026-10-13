/**
 * CrashLab Product Dashboard CLI Command — Build 12C.1.
 *
 * Launches the local authenticated Product Dashboard web interface.
 *
 * Exit codes:
 *   0  clean shutdown (SIGINT / SIGTERM / help)
 *   1  server or network error
 *   2  invalid CLI arguments
 */

import process from 'node:process';
import { TOOL_NAME, TOOL_VERSION } from '../version.js';
import {
  DEFAULT_DASHBOARD_HOST,
  DEFAULT_DASHBOARD_PORT,
  DEFAULT_PRODUCT_API_URL,
  createDashboardServer,
  type RunningDashboardServer,
} from '../product/index.js';

export const DASHBOARD_USAGE = `${TOOL_NAME} v${TOOL_VERSION} - Product Dashboard (Local Web Interface)

Usage:
  npm run dashboard -- [options]
  npx tsx src/cli.ts dashboard [options]

Options:
  --api-url <url>         Backing Product API endpoint [default: ${DEFAULT_PRODUCT_API_URL}]
  --host <host>           Host IP to bind UI server    [default: ${DEFAULT_DASHBOARD_HOST}]
  --port <port>           Port number for UI server    [default: ${DEFAULT_DASHBOARD_PORT}]
  -h, --help              Show this message

Environment:
  PRODUCT_API_URL         Backing Product API endpoint URL
  PRODUCT_DASHBOARD_PORT  Port number for dashboard server

Safety & Isolation Guarantees:
  - Dashboard web client connects exclusively to the Product API.
  - Zero direct Supabase access from browser.
  - Development tokens are kept in memory only; never printed or rendered in HTML.
  - Strict tenant isolation enforced on every request.
  - Non-negotiable trust invariants: safeTestMode: true, confirmedBug: false.`;

export interface ParsedDashboardArgs {
  readonly apiUrl: string;
  readonly host: string;
  readonly port: number;
  readonly help: boolean;
  readonly valid: boolean;
  readonly error: string | null;
}

export function parseDashboardArgs(argv: readonly string[]): ParsedDashboardArgs {
  let apiUrl = process.env.PRODUCT_API_URL || DEFAULT_PRODUCT_API_URL;
  let host = DEFAULT_DASHBOARD_HOST;
  let port = process.env.PRODUCT_DASHBOARD_PORT ? parseInt(process.env.PRODUCT_DASHBOARD_PORT, 10) : DEFAULT_DASHBOARD_PORT;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg === '--api-url') {
      const next = argv[++i];
      if (!next || next.startsWith('-')) {
        return { apiUrl, host, port, help: false, valid: false, error: 'Option --api-url requires a URL value.' };
      }
      apiUrl = next.trim();
      continue;
    }
    if (arg?.startsWith('--api-url=')) {
      apiUrl = arg.slice(10).trim();
      continue;
    }
    if (arg === '--host') {
      const next = argv[++i];
      if (!next || next.startsWith('-')) {
        return { apiUrl, host, port, help: false, valid: false, error: 'Option --host requires a host value.' };
      }
      host = next.trim();
      continue;
    }
    if (arg?.startsWith('--host=')) {
      host = arg.slice(7).trim();
      continue;
    }
    if (arg === '--port') {
      const next = argv[++i];
      const parsed = next ? parseInt(next, 10) : NaN;
      if (isNaN(parsed) || parsed < 0 || parsed > 65535) {
        return { apiUrl, host, port, help: false, valid: false, error: 'Option --port requires a valid port number (0-65535).' };
      }
      port = parsed;
      continue;
    }
    if (arg?.startsWith('--port=')) {
      const parsed = parseInt(arg.slice(7), 10);
      if (isNaN(parsed) || parsed < 0 || parsed > 65535) {
        return { apiUrl, host, port, help: false, valid: false, error: 'Option --port requires a valid port number (0-65535).' };
      }
      port = parsed;
      continue;
    }
    if (arg?.startsWith('-')) {
      return { apiUrl, host, port, help: false, valid: false, error: `Unrecognised flag: ${arg}` };
    }
  }

  return { apiUrl, host, port, help, valid: true, error: null };
}

export async function runDashboardCommand(argv: readonly string[]): Promise<number> {
  const args = parseDashboardArgs(argv);

  if (args.help) {
    console.log(DASHBOARD_USAGE);
    return 0;
  }

  if (!args.valid) {
    console.error(`Error: ${args.error}\n`);
    console.error(DASHBOARD_USAGE);
    return 2;
  }

  let server: RunningDashboardServer;
  try {
    server = await createDashboardServer({
      host: args.host,
      port: args.port,
      apiUrl: args.apiUrl,
    });
  } catch (err) {
    console.error(`Failed to start Product Dashboard server: ${(err as Error).message}`);
    return 1;
  }

  console.log(`CrashLab Product Dashboard active at: ${server.url}`);
  console.log(`Connected Product API:                ${server.apiUrl}`);
  console.log('Press Ctrl+C to stop.\n');

  const shutdown = async () => {
    try {
      await server.stop();
      process.exit(0);
    } catch {
      process.exit(1);
    }
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return 0;
}
