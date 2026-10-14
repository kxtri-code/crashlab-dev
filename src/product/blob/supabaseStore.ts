/**
 * Supabase Storage Adapter — Build 12D.2A: Private Supabase Storage for Production Artifacts.
 *
 * Implements the provider-neutral BlobStore contract using the Supabase Storage REST API:
 * - Direct HTTP communication via native fetch (zero external cloud dependencies).
 * - Strict tenant isolation via deterministic safe object keys.
 * - SHA-256 cryptographic checksum computation and verification.
 * - Idempotent identical writes; conflicting overwrites rejected.
 * - Enforces private bucket requirement (refuses public buckets).
 * - Sanitizes all error messages to guarantee service-role keys are never leaked.
 */

import { createHash } from 'node:crypto';
import type {
  BlobStore,
  BlobLocator,
  PutBlobInput,
  BlobMetadata,
  BlobPayload,
} from './interfaces.js';
import {
  ArtifactImmutableConflictError,
  ChecksumMismatchError,
  BlobStorageError,
  buildBlobStorageKey,
  validateBlobLocator,
} from './interfaces.js';

export const DEFAULT_MAX_BLOB_BYTES = 50 * 1024 * 1024; // 50MB bounded limit

export interface SupabaseBlobStoreOptions {
  readonly supabaseUrl: string;
  readonly bucket: string;
  readonly serviceRoleKey: string;
  readonly maxByteLength?: number;
  readonly requirePrivateBucket?: boolean;
  readonly fetchFn?: typeof fetch;
}

/**
 * Sanitizes any raw error message or string so service-role keys, JWTs,
 * or Authorization tokens are never printed or leaked in exceptions.
 */
export function sanitizeStorageErrorMessage(message: string, secrets: readonly string[]): string {
  let sanitized = message;
  for (const secret of secrets) {
    if (secret && secret.length >= 6) {
      sanitized = sanitized.replaceAll(secret, '[REDACTED_SECRET]');
    }
  }
  // Strip Bearer tokens and apikey headers that might be echoed in error bodies
  sanitized = sanitized.replace(/Bearer\s+[A-Za-z0-9_\-\.]+/gi, 'Bearer [REDACTED_TOKEN]');
  sanitized = sanitized.replace(/apikey[:=]\s*[A-Za-z0-9_\-\.]+/gi, 'apikey=[REDACTED_KEY]');
  return sanitized;
}

export class SupabaseBlobStore implements BlobStore {
  private readonly baseUrl: string;
  private readonly bucket: string;
  private readonly serviceRoleKey: string;
  private readonly maxByteLength: number;
  private readonly requirePrivateBucket: boolean;
  private readonly fetch: typeof fetch;
  private bucketPrivacyVerified = false;

  constructor(options: SupabaseBlobStoreOptions) {
    if (!options?.supabaseUrl || typeof options.supabaseUrl !== 'string') {
      throw new BlobStorageError('SupabaseBlobStore requires a non-empty supabaseUrl.');
    }
    if (!options?.bucket || typeof options.bucket !== 'string') {
      throw new BlobStorageError('SupabaseBlobStore requires a non-empty bucket name.');
    }
    if (!options?.serviceRoleKey || typeof options.serviceRoleKey !== 'string') {
      throw new BlobStorageError('SupabaseBlobStore requires a non-empty serviceRoleKey.');
    }

    this.baseUrl = options.supabaseUrl.replace(/\/+$/, '') + '/storage/v1';
    this.bucket = options.bucket.trim();
    this.serviceRoleKey = options.serviceRoleKey.trim();
    this.maxByteLength = options.maxByteLength ?? DEFAULT_MAX_BLOB_BYTES;
    this.requirePrivateBucket = options.requirePrivateBucket ?? true;
    this.fetch = options.fetchFn ?? globalThis.fetch;
  }

  private get authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.serviceRoleKey}`,
      apikey: this.serviceRoleKey,
    };
  }

  private sanitize(message: string): string {
    return sanitizeStorageErrorMessage(message, [this.serviceRoleKey]);
  }

  private toBuffer(content: Buffer | Uint8Array | string): Buffer {
    if (Buffer.isBuffer(content)) return content;
    if (typeof content === 'string') return Buffer.from(content, 'utf8');
    return Buffer.from(content);
  }

  /**
   * Verifies that the configured Supabase bucket exists and is private.
   * If public, refuses to operate to prevent unauthenticated data exposure.
   */
  async verifyBucketPrivacy(): Promise<void> {
    if (this.bucketPrivacyVerified) {
      return;
    }

    const bucketUrl = `${this.baseUrl}/bucket/${encodeURIComponent(this.bucket)}`;
    let res: Response;
    try {
      res = await this.fetch(bucketUrl, {
        method: 'GET',
        headers: this.authHeaders,
      });
    } catch (err) {
      throw new BlobStorageError(
        `Failed to reach Supabase Storage at "${this.baseUrl}": ${this.sanitize((err as Error).message)}`,
      );
    }

    if (res.status === 404) {
      throw new BlobStorageError(
        `Supabase Storage bucket "${this.bucket}" does not exist. Run "npm run storage:setup -- --confirm" to create it.`,
      );
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new BlobStorageError(
        `Failed to inspect Supabase bucket "${this.bucket}": HTTP ${res.status} ${this.sanitize(text)}`,
      );
    }

    const data = (await res.json().catch(() => null)) as { public?: boolean } | null;
    if (this.requirePrivateBucket && data?.public === true) {
      throw new BlobStorageError(
        `Supabase Storage bucket "${this.bucket}" is public. A private bucket is strictly required for artifact storage.`,
      );
    }

    this.bucketPrivacyVerified = true;
  }

  async put(input: PutBlobInput): Promise<BlobMetadata> {
    validateBlobLocator(input);
    await this.verifyBucketPrivacy();

    const safeObjectKey = buildBlobStorageKey(input);
    const buffer = this.toBuffer(input.content);
    const byteLength = buffer.length;

    // Bounded upload size enforcement
    if (byteLength > this.maxByteLength) {
      throw new BlobStorageError(
        `Artifact "${input.artifactId}" exceeds maximum permitted byte size (${byteLength} > ${this.maxByteLength} bytes).`,
      );
    }

    if (input.expectedByteLength !== undefined && input.expectedByteLength !== byteLength) {
      throw new ChecksumMismatchError(
        `Byte length mismatch for artifact "${input.artifactId}": expected ${input.expectedByteLength}, got ${byteLength}.`,
      );
    }

    const checksum = createHash('sha256').update(buffer).digest('hex');

    if (input.expectedSha256 !== undefined && input.expectedSha256.toLowerCase() !== checksum.toLowerCase()) {
      throw new ChecksumMismatchError(
        `SHA-256 checksum mismatch for artifact "${input.artifactId}": expected ${input.expectedSha256}, got ${checksum}.`,
      );
    }

    // Check if object already exists to enforce immutability
    const existing = await this.get(input);
    if (existing) {
      const existingChecksum = existing.metadata.checksum;
      if (existingChecksum.toLowerCase() === checksum.toLowerCase()) {
        // Idempotent duplicate: byte-identical content already stored
        return existing.metadata;
      }
      // Conflicting overwrite: different content under existing key
      throw new ArtifactImmutableConflictError(
        `Artifact "${input.artifactId}" in run "${input.runId}" already exists with different content. Artifacts are immutable.`,
      );
    }

    // Upload to Supabase Storage
    const uploadUrl = `${this.baseUrl}/object/${encodeURIComponent(this.bucket)}/${safeObjectKey}`;
    let res: Response;
    try {
      res = await this.fetch(uploadUrl, {
        method: 'POST',
        headers: {
          ...this.authHeaders,
          'Content-Type': input.contentType || 'application/octet-stream',
          'x-upsert': 'false',
        },
        body: new Uint8Array(buffer),
      });

    } catch (err) {
      throw new BlobStorageError(
        `Supabase Storage upload failed for "${safeObjectKey}": ${this.sanitize((err as Error).message)}`,
      );
    }

    if (!res.ok) {
      if (res.status === 409) {
        // Concurrent write conflict check
        const concurrent = await this.get(input);
        if (concurrent && concurrent.metadata.checksum.toLowerCase() === checksum.toLowerCase()) {
          return concurrent.metadata;
        }
        throw new ArtifactImmutableConflictError(
          `Artifact "${input.artifactId}" in run "${input.runId}" encountered a concurrent write conflict.`,
        );
      }

      const text = await res.text().catch(() => '');
      throw new BlobStorageError(
        `Supabase Storage upload returned HTTP ${res.status}: ${this.sanitize(text)}`,
      );
    }

    return {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      runId: input.runId,
      artifactId: input.artifactId,
      contentType: input.contentType || 'application/octet-stream',
      byteLength,
      checksum,
      safeObjectKey,
      createdAt: new Date().toISOString(),
    };
  }

  async get(locator: BlobLocator): Promise<BlobPayload | null> {
    validateBlobLocator(locator);
    const safeObjectKey = buildBlobStorageKey(locator);
    const downloadUrl = `${this.baseUrl}/object/authenticated/${encodeURIComponent(this.bucket)}/${safeObjectKey}`;

    let res: Response;
    try {
      res = await this.fetch(downloadUrl, {
        method: 'GET',
        headers: this.authHeaders,
      });
    } catch (err) {
      throw new BlobStorageError(
        `Supabase Storage download failed for "${safeObjectKey}": ${this.sanitize((err as Error).message)}`,
      );
    }

    if (res.status === 404) {
      return null;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // Supabase storage sometimes returns 400 with "Not Found" message
      if (res.status === 400 && /not found|not_found/i.test(text)) {
        return null;
      }
      throw new BlobStorageError(
        `Supabase Storage download returned HTTP ${res.status}: ${this.sanitize(text)}`,
      );
    }

    const arrayBuffer = await res.arrayBuffer();
    const content = Buffer.from(arrayBuffer);

    if (content.length > this.maxByteLength) {
      throw new BlobStorageError(
        `Downloaded artifact "${locator.artifactId}" exceeds maximum permitted byte size (${content.length} > ${this.maxByteLength} bytes).`,
      );
    }

    const contentType = res.headers.get('content-type') || 'application/octet-stream';
    const checksum = createHash('sha256').update(content).digest('hex');

    const metadata: BlobMetadata = {
      workspaceId: locator.workspaceId,
      projectId: locator.projectId,
      runId: locator.runId,
      artifactId: locator.artifactId,
      contentType,
      byteLength: content.length,
      checksum,
      safeObjectKey,
      createdAt: new Date().toISOString(),
    };

    return { metadata, content };
  }

  async exists(locator: BlobLocator): Promise<boolean> {
    validateBlobLocator(locator);
    const safeObjectKey = buildBlobStorageKey(locator);

    // Use GET /object/authenticated with Range header or info endpoint
    const infoUrl = `${this.baseUrl}/object/info/authenticated/${encodeURIComponent(this.bucket)}/${safeObjectKey}`;
    try {
      const res = await this.fetch(infoUrl, {
        method: 'GET',
        headers: this.authHeaders,
      });

      if (res.status === 200) return true;
      if (res.status === 404) return false;

      // Fallback: authenticated download check if info endpoint is not enabled
      const downloadUrl = `${this.baseUrl}/object/authenticated/${encodeURIComponent(this.bucket)}/${safeObjectKey}`;
      const dlRes = await this.fetch(downloadUrl, {
        method: 'GET',
        headers: {
          ...this.authHeaders,
          Range: 'bytes=0-0',
        },
      });

      if (dlRes.status === 200 || dlRes.status === 206) return true;
      if (dlRes.status === 404) return false;
      const text = await dlRes.text().catch(() => '');
      if (dlRes.status === 400 && /not found|not_found/i.test(text)) return false;

      throw new BlobStorageError(`Supabase Storage exists check returned HTTP ${dlRes.status}: ${this.sanitize(text)}`);
    } catch (err) {
      if (err instanceof BlobStorageError) throw err;
      throw new BlobStorageError(`Supabase Storage exists check failed: ${this.sanitize((err as Error).message)}`);
    }
  }

  async getMetadata(locator: BlobLocator): Promise<BlobMetadata | null> {
    validateBlobLocator(locator);
    const safeObjectKey = buildBlobStorageKey(locator);

    // Retrieve full object to ensure exact SHA-256 checksum and Content-Type match
    const payload = await this.get(locator);
    if (!payload) return null;
    return payload.metadata;
  }

  async delete(locator: BlobLocator): Promise<boolean> {
    validateBlobLocator(locator);
    const safeObjectKey = buildBlobStorageKey(locator);

    const deleteUrl = `${this.baseUrl}/object/${encodeURIComponent(this.bucket)}`;
    let res: Response;
    try {
      res = await this.fetch(deleteUrl, {
        method: 'DELETE',
        headers: {
          ...this.authHeaders,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ prefixes: [safeObjectKey] }),
      });
    } catch (err) {
      throw new BlobStorageError(
        `Supabase Storage delete failed for "${safeObjectKey}": ${this.sanitize((err as Error).message)}`,
      );
    }

    if (res.status === 404) return false;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new BlobStorageError(
        `Supabase Storage delete returned HTTP ${res.status}: ${this.sanitize(text)}`,
      );
    }

    return true;
  }

  async close(): Promise<void> {
    // No-op for fetch-based adapter
  }
}

/**
 * Narrowly scoped test cleanup helper.
 * Strictly verifies that the locator targets an explicit test artifact ID before deleting.
 * Prevents accidental broad deletion or deletion of customer artifacts.
 */
export async function deleteTestArtifactSafely(
  store: BlobStore,
  locator: BlobLocator,
): Promise<boolean> {
  validateBlobLocator(locator);

  const isTest =
    locator.artifactId.startsWith('test-') ||
    locator.artifactId.startsWith('art_test_') ||
    locator.runId.startsWith('test-') ||
    locator.runId.startsWith('run_test_') ||
    locator.workspaceId.startsWith('ws_test_') ||
    locator.workspaceId.startsWith('test-');

  if (!isTest) {
    throw new BlobStorageError(
      `Refusing to delete artifact "${locator.artifactId}": deleteTestArtifactSafely only targets test artifact IDs.`,
    );
  }

  return store.delete(locator);
}
