/**
 * Storage Setup CLI Command — Build 12D.2A: Private Supabase Storage.
 *
 * Explicit command to safely create a private Supabase Storage bucket for CrashLab artifacts:
 * - Requires explicit confirmation flag (--confirm)
 * - Refuses to create public buckets
 * - Idempotently checks if the bucket already exists
 * - Never prints raw secrets or service keys
 *
 * Exit codes:
 *   0: Bucket already exists or created successfully
 *   1: Configuration or operational error
 *   2: Invalid CLI arguments or missing confirmation
 */

import { loadBlobStoreConfigFromEnv } from '../product/blob/config.js';

export const STORAGE_SETUP_USAGE = `crashlab storage:setup

Explicitly initialize a private Supabase Storage bucket for CrashLab artifacts.
Requires explicit confirmation flag --confirm.

Usage:
  npm run storage:setup -- --confirm
  npx tsx src/cli.ts storage:setup --confirm

Options:
  --confirm     Required flag confirming bucket creation
  -h, --help    Show this message

Environment:
  PRODUCT_BLOB_STORE           Must be 'supabase'
  SUPABASE_URL                 Supabase project URL
  SUPABASE_STORAGE_BUCKET      Artifact storage bucket name (default: crashlab-artifacts)
  SUPABASE_SERVICE_ROLE_KEY    Server-only service-role secret key (masked)
  PRODUCT_BLOB_MAX_BYTES       Max file size limit for bucket in bytes (default: 52428800)

Exit codes:
  0: Success (bucket created or already exists)
  1: Operational or configuration error
  2: Missing --confirm flag or invalid argument
`;

export interface StorageSetupResult {
  readonly success: boolean;
  readonly code: 0 | 1 | 2;
  readonly message?: string;
}

export async function runStorageSetupCommand(
  argv: string[],
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<StorageSetupResult> {
  let hasConfirm = false;

  for (const arg of argv) {
    if (arg === '-h' || arg === '--help') {
      console.log(STORAGE_SETUP_USAGE);
      return { success: true, code: 0 };
    }
    if (arg === '--confirm') {
      hasConfirm = true;
      continue;
    }
    console.error(`Invalid option: ${arg}\n`);
    console.error(STORAGE_SETUP_USAGE);
    return { success: false, code: 2, message: `Invalid option: ${arg}` };
  }

  if (!hasConfirm) {
    console.error('REFUSED: Bucket setup requires explicit confirmation.\n');
    console.error('Please run with:');
    console.error('  npm run storage:setup -- --confirm\n');
    console.error(STORAGE_SETUP_USAGE);
    return {
      success: false,
      code: 2,
      message: 'Missing required confirmation flag --confirm',
    };
  }

  const config = loadBlobStoreConfigFromEnv();

  if (config.provider !== 'supabase') {
    console.error(
      `ERROR: storage:setup is only applicable when PRODUCT_BLOB_STORE=supabase (current: ${config.provider}).`,
    );
    return { success: false, code: 1, message: 'Provider is not supabase' };
  }

  const supabaseUrl = config.supabaseUrl;
  const bucket = config.supabaseBucket;
  const serviceRoleKey = config.supabaseServiceRoleKey;

  const missing: string[] = [];
  if (!supabaseUrl) missing.push('SUPABASE_URL');
  if (!bucket) missing.push('SUPABASE_STORAGE_BUCKET');
  if (!serviceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');

  if (missing.length > 0) {
    console.error('ERROR: Missing required Supabase configuration:');
    for (const m of missing) {
      console.error(`  - ${m}`);
    }
    return { success: false, code: 1, message: `Missing: ${missing.join(', ')}` };
  }

  const baseUrl = supabaseUrl!.replace(/\/+$/, '') + '/storage/v1';
  const bucketUrl = `${baseUrl}/bucket/${encodeURIComponent(bucket!)}`;

  console.log(`Checking existing bucket status for "${bucket}"...`);

  // 1. Check if bucket exists
  try {
    const checkRes = await fetchFn(bucketUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        apikey: serviceRoleKey!,
      },
    });

    if (checkRes.ok) {
      const data = (await checkRes.json().catch(() => null)) as { public?: boolean } | null;
      if (data?.public === true) {
        console.error(`SECURITY WARNING: Bucket "${bucket}" already exists, but is PUBLIC.`);
        console.error('CrashLab artifacts require a private bucket. Please update bucket settings in Supabase.');
        return { success: false, code: 1, message: 'Existing bucket is public' };
      }
      console.log(`Bucket "${bucket}" already exists and is PRIVATE. No changes needed.`);
      return { success: true, code: 0 };
    }
  } catch (err) {
    console.error(`Connection error checking bucket: ${(err as Error).message}`);
    return { success: false, code: 1, message: (err as Error).message };
  }

  // 2. Create private bucket
  console.log(`Creating private bucket "${bucket}" in Supabase Storage...`);
  const createUrl = `${baseUrl}/bucket`;
  try {
    const createRes = await fetchFn(createUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        apikey: serviceRoleKey!,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        id: bucket,
        name: bucket,
        public: false, // Strictly private bucket
        file_size_limit: config.maxByteLength ?? 52428800,
      }),
    });

    if (!createRes.ok) {
      const text = await createRes.text().catch(() => '');
      if (createRes.status === 409 || /already exists/i.test(text)) {
        console.log(`Bucket "${bucket}" already exists.`);
        return { success: true, code: 0 };
      }
      console.error(`Failed to create bucket: HTTP ${createRes.status} ${text}`);
      return { success: false, code: 1, message: `HTTP ${createRes.status}` };
    }

    console.log(`Private bucket "${bucket}" successfully created!`);
    console.log('Public access: DISABLED (Secure)');
    return { success: true, code: 0 };
  } catch (err) {
    console.error(`Failed to create bucket: ${(err as Error).message}`);
    return { success: false, code: 1, message: (err as Error).message };
  }
}
