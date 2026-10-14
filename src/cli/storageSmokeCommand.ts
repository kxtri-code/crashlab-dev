/**
 * Supabase Storage Smoke Test CLI Command — Build 12D.2B.
 *
 * Dedicated, safe operational smoke test verifying real Supabase Storage upload,
 * download, checksum integrity, and exact-object deletion.
 *
 * Safety Guarantees:
 * - Uses dedicated test workspace and test artifact IDs only.
 * - Targets only one small, harmless JSON payload.
 * - Deletes exactly that one object immediately afterward.
 * - Never prints credentials, service keys, or authorization tokens.
 * - Refuses execution if PRODUCT_BLOB_STORE is not 'supabase'.
 * - Never touches customer data or broad prefixes.
 */

import { createHash } from 'node:crypto';
import { loadBlobStoreConfigFromEnv } from '../product/blob/config.js';
import { SupabaseBlobStore, deleteTestArtifactSafely } from '../product/blob/supabaseStore.js';
import type { BlobLocator } from '../product/blob/interfaces.js';

export interface StorageSmokeResult {
  readonly success: boolean;
  readonly code: number;
  readonly message?: string;
  readonly details?: {
    uploadedBytes: number;
    downloadedBytes: number;
    checksum: string;
    cleanedUp: boolean;
  };
}

export const STORAGE_SMOKE_USAGE = `crashlab storage:smoke

Run a controlled, non-destructive smoke test against private Supabase Storage.
Uploads, downloads, verifies checksum, and safely deletes a single test artifact.

Usage:
  npm run storage:smoke
  npx tsx src/cli.ts storage:smoke

Options:
  -h, --help    Show this message

Environment:
  PRODUCT_BLOB_STORE           Must be 'supabase'
  SUPABASE_URL                 Supabase project URL
  SUPABASE_STORAGE_BUCKET      Artifact storage bucket name
  SUPABASE_SERVICE_ROLE_KEY    Server-only service-role secret key (masked)

Exit codes:
  0: Smoke test passed cleanly (upload, download, checksum, and deletion verified)
  1: Operational or configuration error
`;

export async function runStorageSmokeCommand(
  argv: readonly string[] = [],
  fetchFn: typeof fetch = fetch,
): Promise<StorageSmokeResult> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(STORAGE_SMOKE_USAGE);
    return { success: true, code: 0 };
  }

  const config = loadBlobStoreConfigFromEnv();

  if (config.provider !== 'supabase') {
    console.error(`REFUSED: storage:smoke requires PRODUCT_BLOB_STORE=supabase (current: ${config.provider}).`);
    console.error('Configure PRODUCT_BLOB_STORE=supabase and SUPABASE_SERVICE_ROLE_KEY in .env to run this smoke test.');
    return { success: false, code: 1, message: 'Provider is not supabase' };
  }

  const missing: string[] = [];
  if (!config.supabaseUrl) missing.push('SUPABASE_URL');
  if (!config.supabaseBucket) missing.push('SUPABASE_STORAGE_BUCKET');
  if (!config.supabaseServiceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');

  if (missing.length > 0) {
    console.error(`FATAL: Missing required Supabase Storage configuration for smoke test:`);
    for (const v of missing) {
      console.error(`  - ${v}`);
    }
    return { success: false, code: 1, message: `Missing: ${missing.join(', ')}` };
  }

  console.log(`============================================================`);
  console.log(`CRASHLAB SUPABASE STORAGE SMOKE TEST (Build 12D.2B)`);
  console.log(`============================================================`);
  console.log(`Target Host:    ${new URL(config.supabaseUrl!).host}`);
  console.log(`Bucket Name:    ${config.supabaseBucket}`);
  console.log(`Service Key:    [configured: ${config.supabaseServiceRoleKey!.length} chars]`);
  console.log(`============================================================`);

  const store = new SupabaseBlobStore({
    supabaseUrl: config.supabaseUrl!,
    bucket: config.supabaseBucket!,
    serviceRoleKey: config.supabaseServiceRoleKey!,
    fetchFn,
  });

  const uniqueId = `art_test_smoke_${Date.now()}`;
  const locator: BlobLocator = {
    workspaceId: 'ws_test_storage_smoke',
    projectId: 'prj_test_smoke',
    runId: 'run_test_smoke',
    artifactId: uniqueId,
  };

  const smokePayload = JSON.stringify({
    smokeTest: true,
    artifactId: uniqueId,
    timestamp: new Date().toISOString(),
    purpose: 'Validate private Supabase Storage upload, download, and deletion lifecycle.',
  });
  const expectedSha256 = createHash('sha256').update(smokePayload).digest('hex');
  const expectedLength = Buffer.byteLength(smokePayload, 'utf8');

  try {
    // 1. Upload test object
    console.log(`[1/4] Uploading test artifact "${locator.artifactId}"...`);
    const putRes = await store.put({
      ...locator,
      content: smokePayload,
      contentType: 'application/json',
    });

    if (putRes.checksum !== expectedSha256) {
      throw new Error(`Upload checksum mismatch: expected ${expectedSha256}, got ${putRes.checksum}`);
    }
    if (putRes.byteLength !== expectedLength) {
      throw new Error(`Upload byte length mismatch: expected ${expectedLength}, got ${putRes.byteLength}`);
    }
    console.log(`      Upload successful: ${putRes.byteLength} bytes, SHA-256: ${putRes.checksum.slice(0, 16)}...`);

    // 2. Download test object
    console.log(`[2/4] Downloading test artifact through authenticated API client...`);
    const getRes = await store.get(locator);
    if (!getRes) {
      throw new Error(`Downloaded artifact returned null.`);
    }

    const downloadedText = Buffer.from(getRes.content).toString('utf8');
    const downloadedSha256 = createHash('sha256').update(downloadedText).digest('hex');

    if (downloadedSha256 !== expectedSha256) {
      throw new Error(`Downloaded checksum mismatch: expected ${expectedSha256}, got ${downloadedSha256}`);
    }
    if (downloadedText !== smokePayload) {
      throw new Error('Downloaded content does not match uploaded payload.');
    }
    console.log(`      Download verified: byte-identical payload match.`);

    // 3. Delete exact test object
    console.log(`[3/4] Deleting test artifact safely via deleteTestArtifactSafely...`);
    const deleted = await deleteTestArtifactSafely(store, locator);
    if (!deleted) {
      throw new Error('Failed to delete test artifact.');
    }
    console.log(`      Deletion successful.`);

    // 4. Verify object is no longer present
    console.log(`[4/4] Verifying object no longer exists in bucket...`);
    const stillExists = await store.exists(locator);
    if (stillExists) {
      throw new Error('Artifact still exists after deletion!');
    }
    console.log(`      Verification confirmed: artifact successfully removed.`);

    console.log(`============================================================`);
    console.log(`SMOKE TEST RESULT: PASSED (100% Verified)`);
    console.log(`- Upload:          SUCCESS (${putRes.byteLength} bytes)`);
    console.log(`- Download:        SUCCESS (Matching content)`);
    console.log(`- Checksum:        MATCH (${expectedSha256.slice(0, 16)}...)`);
    console.log(`- Exact Cleanup:   SUCCESS (Object purged)`);
    console.log(`============================================================`);

    return {
      success: true,
      code: 0,
      details: {
        uploadedBytes: putRes.byteLength,
        downloadedBytes: getRes.metadata.byteLength,
        checksum: putRes.checksum,
        cleanedUp: true,
      },
    };
  } catch (err) {
    console.error(`ERROR: Storage smoke test failed: ${(err as Error).message}`);
    // Attempt best-effort emergency cleanup of test object
    try {
      await deleteTestArtifactSafely(store, locator);
      console.log(`Emergency cleanup: test artifact "${locator.artifactId}" deleted.`);
    } catch {
      // Best-effort
    }
    return { success: false, code: 1, message: (err as Error).message };
  } finally {
    await store.close();
  }
}
