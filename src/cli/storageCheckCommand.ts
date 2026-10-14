/**
 * Storage Check CLI Command — Build 12D.2A: Private Supabase Storage.
 *
 * Verifies the current product artifact storage backend:
 * - Checks whether Supabase URL, bucket, and service-role key are configured
 * - Inspects bucket reachability and private privacy state via Supabase Storage REST API
 * - NEVER prints raw secrets, passwords, or service-role keys
 * - Reports clear status and diagnostics
 *
 * Exit codes:
 *   0: Storage successfully verified and bucket is reachable & private
 *   1: Storage configuration error or verification failure
 *   2: Invalid CLI arguments
 */

import { loadBlobStoreConfigFromEnv } from '../product/blob/config.js';

export const STORAGE_CHECK_USAGE = `crashlab storage:check

Verify the current artifact storage configuration and private bucket readiness.
Never prints service-role keys, secrets, or raw credentials.

Usage:
  npm run storage:check
  npx tsx src/cli.ts storage:check [options]

Options:
  -h, --help    Show this message

Environment:
  PRODUCT_BLOB_STORE           Storage provider (local | s3 | supabase)
  SUPABASE_URL                 Supabase project URL (https://<project-ref>.supabase.co)
  SUPABASE_STORAGE_BUCKET      Artifact storage bucket name (default: crashlab-artifacts)
  SUPABASE_SERVICE_ROLE_KEY    Server-only secret service-role key (masked)
  PRODUCT_BLOB_MAX_BYTES       Max artifact byte limit (default: 52428800)

Exit codes:
  0: Storage configuration successfully verified
  1: Configuration or verification failure
  2: Invalid CLI arguments
`;

export interface StorageCheckResult {
  readonly success: boolean;
  readonly code: 0 | 1 | 2;
  readonly message?: string;
}

export async function runStorageCheckCommand(
  argv: string[],
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<StorageCheckResult> {
  for (const arg of argv) {
    if (arg === '-h' || arg === '--help') {
      console.log(STORAGE_CHECK_USAGE);
      return { success: true, code: 0 };
    }
    if (arg.startsWith('-')) {
      console.error(`Invalid option: ${arg}\n`);
      console.error(STORAGE_CHECK_USAGE);
      return { success: false, code: 2, message: `Invalid option: ${arg}` };
    }
  }

  const config = loadBlobStoreConfigFromEnv();
  console.log('CrashLab Artifact Storage Check:');
  console.log('--------------------------------------------------');
  console.log(`Storage Provider:    ${config.provider}`);

  if (config.provider === 'local') {
    console.log(`Local Artifact Root: ${config.localRoot ?? '(default .artifacts)'}`);
    console.log('Mode:                Development / Test Filesystem Store');
    console.log('--------------------------------------------------');
    console.log('Configuration verified successfully (local development store).');
    return { success: true, code: 0 };
  }

  if (config.provider === 's3') {
    console.log(`S3 Bucket:           ${config.s3Bucket ?? '(not configured)'}`);
    console.log(`S3 Prefix:           ${config.s3Prefix ?? '(none)'}`);
    console.log('Mode:                S3-Compatible Cloud Storage Boundary');
    console.log('--------------------------------------------------');
    if (!config.s3Bucket) {
      console.error('ERROR: PRODUCT_BLOB_S3_BUCKET is required when PRODUCT_BLOB_STORE=s3.');
      return { success: false, code: 1, message: 'Missing S3 bucket' };
    }
    console.log('Configuration verified.');
    return { success: true, code: 0 };
  }

  if (config.provider === 'supabase') {
    const supabaseUrl = config.supabaseUrl;
    const bucket = config.supabaseBucket;
    const serviceRoleKey = config.supabaseServiceRoleKey;

    let hostDisplay = '(not configured)';
    if (supabaseUrl) {
      try {
        const parsed = new URL(supabaseUrl);
        hostDisplay = `${parsed.protocol}//${parsed.host}`;
      } catch {
        hostDisplay = '(invalid URL)';
      }
    }

    console.log(`Supabase Host:       ${hostDisplay}`);
    console.log(`Storage Bucket:      ${bucket || '(not configured)'}`);
    console.log(
      `Service Key Status:  ${serviceRoleKey ? `[configured: ${serviceRoleKey.length} chars]` : '(not configured)'}`,
    );
    console.log(`Max Artifact Bytes:  ${config.maxByteLength ?? 52428800} bytes`);
    console.log('--------------------------------------------------');

    const missing: string[] = [];
    if (!supabaseUrl) missing.push('SUPABASE_URL');
    if (!bucket) missing.push('SUPABASE_STORAGE_BUCKET');
    if (!serviceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');

    if (missing.length > 0) {
      console.error('ERROR: Missing required Supabase Storage configuration:');
      for (const m of missing) {
        console.error(`  - ${m}`);
      }
      return { success: false, code: 1, message: `Missing: ${missing.join(', ')}` };
    }

    // Inspect bucket via Supabase Storage REST API
    const baseUrl = supabaseUrl!.replace(/\/+$/, '') + '/storage/v1';
    const bucketUrl = `${baseUrl}/bucket/${encodeURIComponent(bucket!)}`;

    try {
      const res = await fetchFn(bucketUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${serviceRoleKey}`,
          apikey: serviceRoleKey!,
        },
      });

      if (res.status === 404) {
        console.error(`ERROR: Supabase Storage bucket "${bucket}" does not exist.`);
        console.error(`Run "npm run storage:setup -- --confirm" to create the private bucket.`);
        return { success: false, code: 1, message: 'Bucket does not exist' };
      }

      if (!res.ok) {
        console.error(`ERROR: Supabase Storage returned HTTP ${res.status}.`);
        return { success: false, code: 1, message: `HTTP ${res.status}` };
      }

      const data = (await res.json().catch(() => null)) as { public?: boolean; id?: string } | null;
      const isPublic = data?.public === true;

      if (isPublic) {
        console.error(`SECURITY VIOLATION: Bucket "${bucket}" is marked PUBLIC.`);
        console.error('Artifact buckets must be private. Please update bucket settings in Supabase to public: false.');
        return { success: false, code: 1, message: 'Bucket is public' };
      }

      console.log('Bucket Status:       Reachable');
      console.log('Privacy Check:       PRIVATE (Secure)');
      console.log('--------------------------------------------------');
      console.log('Storage configuration verified successfully.');
      return { success: true, code: 0 };
    } catch (err) {
      console.error(`ERROR: Failed to connect to Supabase Storage: ${(err as Error).message}`);
      return { success: false, code: 1, message: (err as Error).message };
    }
  }

  console.error(`ERROR: Unsupported PRODUCT_BLOB_STORE "${config.provider}". Supported: local, s3, supabase.`);
  return { success: false, code: 1, message: 'Unsupported provider' };
}
