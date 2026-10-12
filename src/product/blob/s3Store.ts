/**
 * S3-Compatible Blob Store Adapter — Build 12B.2A: Secure Artifact Blob Storage.
 *
 * Provider-neutral contract for S3-compatible cloud object storage (AWS S3, MinIO, Cloudflare R2).
 * Does not require external cloud dependencies at runtime; accepts any S3ClientLike driver.
 *
 * Enforces:
 * - Deterministic, tenant-scoped object keys
 * - Checksum verification and storage in S3 metadata
 * - Artifact immutability (detects conflicting overwrites)
 * - Safe sanitization of credentials in errors
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

export interface S3ClientLike {
  putObject(params: {
    Bucket: string;
    Key: string;
    Body: Buffer;
    ContentType: string;
    Metadata?: Record<string, string>;
  }): Promise<unknown>;

  getObject(params: {
    Bucket: string;
    Key: string;
  }): Promise<{
    Body: Buffer | Uint8Array | NodeJS.ReadableStream;
    ContentType?: string;
    ContentLength?: number;
    ETag?: string;
    Metadata?: Record<string, string>;
  }>;

  headObject(params: {
    Bucket: string;
    Key: string;
  }): Promise<{
    ContentLength?: number;
    ContentType?: string;
    ETag?: string;
    Metadata?: Record<string, string>;
  }>;

  deleteObject(params: {
    Bucket: string;
    Key: string;
  }): Promise<unknown>;
}

export interface S3CompatibleBlobStoreOptions {
  readonly client: S3ClientLike;
  readonly bucket: string;
  readonly prefix?: string;
}

export class S3CompatibleBlobStore implements BlobStore {
  private readonly client: S3ClientLike;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(options: S3CompatibleBlobStoreOptions) {
    if (!options?.client) {
      throw new BlobStorageError('S3CompatibleBlobStore requires a valid S3 client implementation.');
    }
    if (!options?.bucket || typeof options.bucket !== 'string') {
      throw new BlobStorageError('S3CompatibleBlobStore requires a non-empty bucket name.');
    }
    this.client = options.client;
    this.bucket = options.bucket;
    this.prefix = options.prefix ? options.prefix.replace(/^\/+|\/+$/g, '') + '/' : '';
  }

  private resolveKey(locator: BlobLocator): { s3Key: string; safeObjectKey: string } {
    validateBlobLocator(locator);
    const safeObjectKey = buildBlobStorageKey(locator);
    const s3Key = `${this.prefix}${safeObjectKey}`;
    return { s3Key, safeObjectKey };
  }

  private toBuffer(content: Buffer | Uint8Array | string): Buffer {
    if (Buffer.isBuffer(content)) return content;
    if (typeof content === 'string') return Buffer.from(content, 'utf8');
    return Buffer.from(content);
  }

  private async streamToBuffer(streamOrBuf: Buffer | Uint8Array | NodeJS.ReadableStream): Promise<Buffer> {
    if (Buffer.isBuffer(streamOrBuf)) return streamOrBuf;
    if (streamOrBuf instanceof Uint8Array) return Buffer.from(streamOrBuf);

    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const stream = streamOrBuf as NodeJS.ReadableStream;
      stream.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  }

  private isNotFoundError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const anyErr = err as Record<string, unknown>;
    return (
      anyErr.name === 'NotFound' ||
      anyErr.name === 'NoSuchKey' ||
      anyErr.$metadata !== undefined && (anyErr.$metadata as Record<string, unknown>).httpStatusCode === 404 ||
      anyErr.statusCode === 404 ||
      anyErr.code === 'ENOENT'
    );
  }

  async put(input: PutBlobInput): Promise<BlobMetadata> {
    const { s3Key, safeObjectKey } = this.resolveKey(input);
    const buffer = this.toBuffer(input.content);
    const byteLength = buffer.length;
    const checksum = createHash('sha256').update(buffer).digest('hex');

    if (input.expectedByteLength !== undefined && input.expectedByteLength !== byteLength) {
      throw new ChecksumMismatchError(
        `Byte length mismatch for artifact "${input.artifactId}": expected ${input.expectedByteLength}, got ${byteLength}.`,
      );
    }

    if (input.expectedSha256 !== undefined && input.expectedSha256.toLowerCase() !== checksum.toLowerCase()) {
      throw new ChecksumMismatchError(
        `SHA-256 checksum mismatch for artifact "${input.artifactId}": expected ${input.expectedSha256}, got ${checksum}.`,
      );
    }

    // Check if object already exists in S3
    try {
      const head = await this.client.headObject({ Bucket: this.bucket, Key: s3Key });
      const existingChecksum = head.Metadata?.['checksum'] ?? head.Metadata?.['sha256'];

      if (existingChecksum && existingChecksum.toLowerCase() === checksum.toLowerCase()) {
        // Idempotent duplicate
        return {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          runId: input.runId,
          artifactId: input.artifactId,
          contentType: head.ContentType ?? input.contentType,
          byteLength: head.ContentLength ?? byteLength,
          checksum,
          safeObjectKey,
          createdAt: new Date().toISOString(),
        };
      }

      throw new ArtifactImmutableConflictError(
        `Artifact "${input.artifactId}" in run "${input.runId}" already exists in S3 bucket "${this.bucket}" with different content.`,
      );
    } catch (err) {
      if (!this.isNotFoundError(err)) {
        if (err instanceof ArtifactImmutableConflictError) throw err;
        throw new BlobStorageError(`Failed to check existing artifact in S3: ${(err as Error).message}`);
      }
    }

    const metadataHeader: Record<string, string> = {
      checksum,
      workspaceid: input.workspaceId,
      projectid: input.projectId,
      runid: input.runId,
      artifactid: input.artifactId,
    };

    try {
      await this.client.putObject({
        Bucket: this.bucket,
        Key: s3Key,
        Body: buffer,
        ContentType: input.contentType,
        Metadata: metadataHeader,
      });

      return {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        runId: input.runId,
        artifactId: input.artifactId,
        contentType: input.contentType,
        byteLength,
        checksum,
        safeObjectKey,
        createdAt: new Date().toISOString(),
      };
    } catch (err) {
      throw new BlobStorageError(`S3 putObject failed: ${(err as Error).message}`);
    }
  }

  async get(locator: BlobLocator): Promise<BlobPayload | null> {
    const { s3Key, safeObjectKey } = this.resolveKey(locator);

    try {
      const obj = await this.client.getObject({ Bucket: this.bucket, Key: s3Key });
      const content = await this.streamToBuffer(obj.Body);
      const checksum = obj.Metadata?.['checksum'] ?? createHash('sha256').update(content).digest('hex');

      const metadata: BlobMetadata = {
        workspaceId: locator.workspaceId,
        projectId: locator.projectId,
        runId: locator.runId,
        artifactId: locator.artifactId,
        contentType: obj.ContentType ?? 'application/octet-stream',
        byteLength: obj.ContentLength ?? content.length,
        checksum,
        safeObjectKey,
        createdAt: new Date().toISOString(),
      };

      return { metadata, content };
    } catch (err) {
      if (this.isNotFoundError(err)) return null;
      throw new BlobStorageError(`S3 getObject failed: ${(err as Error).message}`);
    }
  }

  async exists(locator: BlobLocator): Promise<boolean> {
    const { s3Key } = this.resolveKey(locator);
    try {
      await this.client.headObject({ Bucket: this.bucket, Key: s3Key });
      return true;
    } catch (err) {
      if (this.isNotFoundError(err)) return false;
      throw new BlobStorageError(`S3 headObject failed: ${(err as Error).message}`);
    }
  }

  async delete(locator: BlobLocator): Promise<boolean> {
    const { s3Key } = this.resolveKey(locator);
    try {
      await this.client.deleteObject({ Bucket: this.bucket, Key: s3Key });
      return true;
    } catch (err) {
      if (this.isNotFoundError(err)) return false;
      throw new BlobStorageError(`S3 deleteObject failed: ${(err as Error).message}`);
    }
  }

  async getMetadata(locator: BlobLocator): Promise<BlobMetadata | null> {
    const { s3Key, safeObjectKey } = this.resolveKey(locator);
    try {
      const head = await this.client.headObject({ Bucket: this.bucket, Key: s3Key });
      const checksum = head.Metadata?.['checksum'] ?? head.Metadata?.['sha256'] ?? 'unknown';

      return {
        workspaceId: locator.workspaceId,
        projectId: locator.projectId,
        runId: locator.runId,
        artifactId: locator.artifactId,
        contentType: head.ContentType ?? 'application/octet-stream',
        byteLength: head.ContentLength ?? 0,
        checksum,
        safeObjectKey,
        createdAt: new Date().toISOString(),
      };
    } catch (err) {
      if (this.isNotFoundError(err)) return null;
      throw new BlobStorageError(`S3 headObject failed: ${(err as Error).message}`);
    }
  }

  async close(): Promise<void> {
    // S3 client connection pooling handled by driver
  }
}
