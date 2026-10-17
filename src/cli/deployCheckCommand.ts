/**
 * CrashLab Deployment Configuration Preflight Check — Build 12E.
 *
 * Verifies deployment configuration safety before launching containers or deploying.
 * Never outputs secret values, database passwords, tokens, or private credentials.
 * Reports only variable names and safe operational statuses.
 *
 * Exit codes:
 *   0: All required production deployment configurations verified safely
 *   1: Configuration validation failed
 *   2: Invalid CLI arguments
 */

import process from 'node:process';

export const DEPLOY_CHECK_USAGE = `crashlab deploy:check (Build 12E)

Verify deployment environment configuration safety for Render private-beta deployment.
Never prints raw credentials, database passwords, or secret keys.

Usage:
  npm run deploy:check
  npx tsx src/cli.ts deploy:check [options]

Options:
  --role <api|worker|all>  Target role to validate [default: all]
  -h, --help               Show this help message

Environment:
  PRODUCT_AUTH_MODE             Must be 'production'
  PRODUCT_STORAGE               Must be 'postgres'
  DATABASE_URL                  PostgreSQL connection URL (masked)
  PRODUCT_BLOB_STORE            Must be 'supabase'
  SUPABASE_URL                  Supabase project URL (masked host)
  SUPABASE_STORAGE_BUCKET       Private artifact bucket name
  SUPABASE_SERVICE_ROLE_KEY     Server-only secret key (masked length)
  SUPABASE_JWT_ISSUER           JWT issuer URL (masked length)
  SUPABASE_JWKS_URL             JWKS URL (masked host)
  PRODUCT_CORS_ALLOWED_ORIGINS  Allowed origins (wildcard '*' prohibited)
  PRODUCT_WORKER_ENABLED        Worker loop enable flag

Exit codes:
  0: Configuration is valid and safe for deployment
  1: Configuration validation failed
  2: Invalid CLI arguments
`;

export interface DeployCheckResult {
  readonly success: boolean;
  readonly code: 0 | 1 | 2;
  readonly errors: readonly string[];
  readonly statuses: Readonly<Record<string, string>>;
}

export interface DeployCheckOptions {
  readonly role?: 'api' | 'worker' | 'all';
}

export function checkDeploymentConfiguration(
  env: Record<string, string | undefined> = process.env,
  options: DeployCheckOptions = {},
): {
  valid: boolean;
  errors: readonly string[];
  statuses: Record<string, string>;
} {
  const errors: string[] = [];
  const statuses: Record<string, string> = {};
  const role = options.role ?? 'all';

  // 1. PRODUCT_AUTH_MODE
  const authMode = env.PRODUCT_AUTH_MODE?.trim().toLowerCase();
  if (authMode === 'production') {
    statuses['PRODUCT_AUTH_MODE'] = '[configured: production]';
  } else {
    statuses['PRODUCT_AUTH_MODE'] = `[FAIL: ${authMode || '(omitted: defaults to dev)'}]`;
    errors.push('PRODUCT_AUTH_MODE must be set to "production"');
  }

  // 2. PRODUCT_STORAGE
  const storage = env.PRODUCT_STORAGE?.trim().toLowerCase();
  if (storage === 'postgres') {
    statuses['PRODUCT_STORAGE'] = '[configured: postgres]';
  } else {
    statuses['PRODUCT_STORAGE'] = `[FAIL: ${storage || 'in-memory'}]`;
    errors.push('PRODUCT_STORAGE must be set to "postgres" in production');
  }

  // 3. DATABASE_URL
  const dbUrl = env.DATABASE_URL?.trim();
  if (dbUrl) {
    try {
      const parsed = new URL(dbUrl);
      const dbName = parsed.pathname.replace(/^\//, '');
      statuses['DATABASE_URL'] = `[configured: host=${parsed.host}, db=${dbName || 'default'}, ${dbUrl.length} chars]`;
    } catch {
      statuses['DATABASE_URL'] = `[FAIL: malformed URL]`;
      errors.push('DATABASE_URL must be a valid PostgreSQL URL');
    }
  } else {
    statuses['DATABASE_URL'] = '[FAIL: not configured]';
    errors.push('DATABASE_URL is required when PRODUCT_STORAGE=postgres');
  }

  // 4. PRODUCT_BLOB_STORE
  const blobStore = env.PRODUCT_BLOB_STORE?.trim().toLowerCase();
  if (blobStore === 'supabase') {
    statuses['PRODUCT_BLOB_STORE'] = '[configured: supabase]';
  } else {
    statuses['PRODUCT_BLOB_STORE'] = `[FAIL: ${blobStore || 'local'}]`;
    errors.push('PRODUCT_BLOB_STORE must be set to "supabase" in production');
  }

  // 5. SUPABASE_URL
  const supabaseUrl = env.SUPABASE_URL?.trim();
  if (supabaseUrl) {
    try {
      const parsed = new URL(supabaseUrl);
      statuses['SUPABASE_URL'] = `[configured: host=${parsed.host}]`;
    } catch {
      statuses['SUPABASE_URL'] = '[FAIL: malformed URL]';
      errors.push('SUPABASE_URL must be a valid HTTPS URL');
    }
  } else {
    statuses['SUPABASE_URL'] = '[FAIL: not configured]';
    errors.push('SUPABASE_URL is required for Supabase Storage');
  }

  // 6. SUPABASE_STORAGE_BUCKET
  const bucket = env.SUPABASE_STORAGE_BUCKET?.trim();
  if (bucket) {
    statuses['SUPABASE_STORAGE_BUCKET'] = `[configured: ${bucket}]`;
  } else {
    statuses['SUPABASE_STORAGE_BUCKET'] = '[FAIL: not configured]';
    errors.push('SUPABASE_STORAGE_BUCKET is required');
  }

  // 7. SUPABASE_SERVICE_ROLE_KEY
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (serviceKey) {
    statuses['SUPABASE_SERVICE_ROLE_KEY'] = `[configured: ${serviceKey.length} chars]`;
  } else {
    statuses['SUPABASE_SERVICE_ROLE_KEY'] = '[FAIL: not configured]';
    errors.push('SUPABASE_SERVICE_ROLE_KEY is required');
  }

  // 8. SUPABASE_JWT_ISSUER
  const jwtIssuer = env.SUPABASE_JWT_ISSUER?.trim();
  if (role === 'worker') {
    statuses['SUPABASE_JWT_ISSUER'] = '[not required for worker service]';
  } else if (jwtIssuer) {
    statuses['SUPABASE_JWT_ISSUER'] = `[configured: ${jwtIssuer.length} chars]`;
  } else {
    statuses['SUPABASE_JWT_ISSUER'] = '[FAIL: not configured]';
    errors.push('SUPABASE_JWT_ISSUER is required for production auth');
  }

  // 9. SUPABASE_JWKS_URL
  const jwksUrl = env.SUPABASE_JWKS_URL?.trim();
  if (role === 'worker') {
    statuses['SUPABASE_JWKS_URL'] = '[not required for worker service]';
  } else if (jwksUrl) {
    try {
      const parsed = new URL(jwksUrl);
      statuses['SUPABASE_JWKS_URL'] = `[configured: host=${parsed.host}]`;
    } catch {
      statuses['SUPABASE_JWKS_URL'] = '[FAIL: malformed URL]';
      errors.push('SUPABASE_JWKS_URL must be a valid URL');
    }
  } else {
    statuses['SUPABASE_JWKS_URL'] = '[FAIL: not configured]';
    errors.push('SUPABASE_JWKS_URL is required for production auth');
  }

  // 10. PRODUCT_CORS_ALLOWED_ORIGINS
  const corsRaw = env.PRODUCT_CORS_ALLOWED_ORIGINS?.trim();
  if (role === 'worker') {
    statuses['PRODUCT_CORS_ALLOWED_ORIGINS'] = '[not required for worker service]';
  } else if (corsRaw === '*') {
    statuses['PRODUCT_CORS_ALLOWED_ORIGINS'] = '[FAIL: wildcard "*" prohibited]';
    errors.push('PRODUCT_CORS_ALLOWED_ORIGINS cannot be wildcard "*" in production');
  } else if (corsRaw) {
    const origins = corsRaw.split(',').map((o) => o.trim()).filter(Boolean);
    if (origins.length === 0 || origins.includes('*')) {
      statuses['PRODUCT_CORS_ALLOWED_ORIGINS'] = '[FAIL: wildcard prohibited]';
      errors.push('PRODUCT_CORS_ALLOWED_ORIGINS must contain explicit origin URLs without wildcards');
    } else {
      statuses['PRODUCT_CORS_ALLOWED_ORIGINS'] = `[configured: ${origins.length} origin(s)]`;
    }
  } else {
    // Unset or empty: Same-origin requests work without CORS (dashboard served by same API process)
    statuses['PRODUCT_CORS_ALLOWED_ORIGINS'] =
      '[configured: same-origin only (safe for self-hosted dashboard; set if hosting on external domain)]';
  }

  // 11. PRODUCT_WORKER_ENABLED role verification
  const workerRaw = env.PRODUCT_WORKER_ENABLED?.trim().toLowerCase();
  const workerEnabled = workerRaw === 'true';

  if (role === 'api') {
    if (workerEnabled) {
      statuses['PRODUCT_WORKER_ENABLED'] = '[FAIL: API service must not have worker enabled]';
      errors.push('PRODUCT_WORKER_ENABLED must be false or omitted for the API service');
    } else {
      statuses['PRODUCT_WORKER_ENABLED'] = '[configured: disabled (safe for API)]';
    }
  } else if (role === 'worker') {
    if (!workerEnabled) {
      statuses['PRODUCT_WORKER_ENABLED'] = `[FAIL: worker service requires true, got: ${workerRaw || 'false'}]`;
      errors.push('PRODUCT_WORKER_ENABLED must be "true" for the Background Worker service');
    } else {
      statuses['PRODUCT_WORKER_ENABLED'] = '[configured: enabled (required for worker)]';
    }
  } else {
    // Role 'all' - describe status for both services
    statuses['PRODUCT_WORKER_ENABLED'] = workerEnabled
      ? '[configured: true (Worker role active; must be false for API service)]'
      : '[configured: false/unset (API role safe; must be true for Worker service)]';
  }

  return {
    valid: errors.length === 0,
    errors: Object.freeze(errors),
    statuses,
  };
}

export async function runDeployCheckCommand(
  argv: readonly string[] = [],
  env: Record<string, string | undefined> = process.env,
): Promise<DeployCheckResult> {
  let role: 'api' | 'worker' | 'all' = 'all';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--help' || arg === '-h') {
      console.log(DEPLOY_CHECK_USAGE);
      return { success: true, code: 0, errors: [], statuses: {} };
    }
    if (arg === '--role') {
      const next = argv[++i]?.trim().toLowerCase();
      if (next === 'api' || next === 'worker' || next === 'all') {
        role = next;
      } else {
        console.error(`Error: Invalid value for --role: ${next}. Expected: api, worker, or all.\n`);
        console.log(DEPLOY_CHECK_USAGE);
        return { success: false, code: 2, errors: ['Invalid --role argument'], statuses: {} };
      }
      continue;
    }
    if (arg.startsWith('--role=')) {
      const next = arg.slice('--role='.length).trim().toLowerCase();
      if (next === 'api' || next === 'worker' || next === 'all') {
        role = next;
      } else {
        console.error(`Error: Invalid value for --role: ${next}. Expected: api, worker, or all.\n`);
        console.log(DEPLOY_CHECK_USAGE);
        return { success: false, code: 2, errors: ['Invalid --role argument'], statuses: {} };
      }
      continue;
    }
    if (arg.startsWith('-')) {
      console.error(`Error: Unrecognised flag: ${arg}\n`);
      console.log(DEPLOY_CHECK_USAGE);
      return { success: false, code: 2, errors: [`Unrecognised flag: ${arg}`], statuses: {} };
    }
  }

  console.log('============================================================');
  console.log(`CRASHLAB DEPLOYMENT PREFLIGHT CHECK (Build 12E)`);
  console.log('============================================================');
  console.log(`Target Role: ${role.toUpperCase()}`);
  console.log('------------------------------------------------------------');

  const check = checkDeploymentConfiguration(env, { role });

  for (const [key, status] of Object.entries(check.statuses)) {
    const padded = key.padEnd(30, ' ');
    console.log(`${padded} ${status}`);
  }

  console.log('============================================================');

  if (check.valid) {
    console.log('PREFLIGHT RESULT: PASSED (Configuration is deployment-ready)');
    console.log('Zero credentials or secret keys exposed.');
    console.log('============================================================');
    return {
      success: true,
      code: 0,
      errors: [],
      statuses: check.statuses,
    };
  }

  console.error(`PREFLIGHT RESULT: FAILED (${check.errors.length} configuration error(s))`);
  for (const err of check.errors) {
    console.error(`  - ${err}`);
  }
  console.error('============================================================');

  return {
    success: false,
    code: 1,
    errors: check.errors,
    statuses: check.statuses,
  };
}
