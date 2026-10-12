/**
 * Secure Local Filesystem Blob Store — Build 12B.2A: Secure Artifact Blob Storage.
 *
 * Implements durable, tenant-isolated local filesystem storage for test artifacts:
 * - Strict confinement inside configured root directory
 * - Prohibits directory traversal, absolute paths, and path separators in IDs
 * - Atomic writes via temporary files and rename
 * - SHA-256 checksum and byte size verification
 * - Artifact immutability (prohibits conflicting overwrites; allows idempotent duplicate writes)
 * - Prohibits symlinks escaping the storage root
 * - Zero secret leakage in errors
 */

import { promises as fs, constants } from 'node:fs';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type {
  BlobStore,
  BlobLocator,
  PutBlobInput,
  BlobMetadata,
  BlobPayload,
} from './interfaces.js';
import {
  PathTraversalError,
  ArtifactImmutableConflictError,
  ChecksumMismatchError,
  buildBlobStorageKey,
  validateBlobLocator,
} from './interfaces.js';

export interface LocalBlobStoreOptions {
  readonly rootDirectory: string;
}

export class LocalBlobStore implements BlobStore {
  readonly rootDirectory: string;

  constructor(options: LocalBlobStoreOptions) {
    if (!options?.rootDirectory || typeof options.rootDirectory !== 'string') {
      throw new PathTraversalError('LocalBlobStore requires an explicit rootDirectory string.');
    }
    const resolved = path.resolve(options.rootDirectory);
    const root = path.parse(resolved).root;
    if (resolved === root) {
      throw new PathTraversalError(`Root directory cannot be the filesystem root: "${resolved}".`);
    }
    this.rootDirectory = resolved;
  }

  /**
   * Resolves a locator to a strictly validated, absolute path inside the storage root.
   */
  private resolvePath(locator: BlobLocator): { fullPath: string; relKey: string } {
    validateBlobLocator(locator);
    const relKey = buildBlobStorageKey(locator);

    // Resolve path relative to rootDirectory
    const segments = relKey.split('/');
    const fullPath = path.resolve(this.rootDirectory, ...segments);

    // Ensure path remains strictly within rootDirectory
    const rootWithSep = this.rootDirectory.endsWith(path.sep)
      ? this.rootDirectory
      : this.rootDirectory + path.sep;

    if (!fullPath.startsWith(rootWithSep)) {
      throw new PathTraversalError(
        `Resolved path traverses outside storage root boundary. Target: "${fullPath}"`,
      );
    }

    return { fullPath, relKey };
  }

  private async assertNotEscapedSymlink(targetPath: string): Promise<void> {
    try {
      const stats = await fs.lstat(targetPath);
      if (stats.isSymbolicLink()) {
        const real = await fs.realpath(targetPath);
        const rootWithSep = this.rootDirectory.endsWith(path.sep)
          ? this.rootDirectory
          : this.rootDirectory + path.sep;
        if (!real.startsWith(rootWithSep)) {
          throw new PathTraversalError('Prohibited symbolic link pointing outside storage root.');
        }
      }
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code !== 'ENOENT') {
        throw err;
      }
    }
  }

  private async pathExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  private toBuffer(content: Buffer | Uint8Array | string): Buffer {
    if (Buffer.isBuffer(content)) return content;
    if (typeof content === 'string') return Buffer.from(content, 'utf8');
    return Buffer.from(content);
  }

  async put(input: PutBlobInput): Promise<BlobMetadata> {
    const { fullPath, relKey } = this.resolvePath(input);
    await this.assertNotEscapedSymlink(fullPath);

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

    // Check if target already exists
    if (await this.pathExists(fullPath)) {
      const existingBuffer = await fs.readFile(fullPath);
      const existingChecksum = createHash('sha256').update(existingBuffer).digest('hex');

      if (existingChecksum === checksum) {
        // Idempotent rewrite of identical content
        const metaPath = `${fullPath}.meta.json`;
        if (await this.pathExists(metaPath)) {
          try {
            const rawMeta = await fs.readFile(metaPath, 'utf8');
            return JSON.parse(rawMeta) as BlobMetadata;
          } catch {
            // Fall through to regenerate metadata
          }
        }
        return {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          runId: input.runId,
          artifactId: input.artifactId,
          contentType: input.contentType,
          byteLength,
          checksum,
          safeObjectKey: relKey,
          createdAt: new Date().toISOString(),
        };
      }

      throw new ArtifactImmutableConflictError(
        `Artifact "${input.artifactId}" in run "${input.runId}" already exists with different content. Overwrite prohibited.`,
      );
    }

    // Ensure target directory exists
    const targetDir = path.dirname(fullPath);
    await fs.mkdir(targetDir, { recursive: true });

    const nonce = randomBytes(8).toString('hex');
    const tmpDataPath = `${fullPath}.tmp.${nonce}`;
    const tmpMetaPath = `${fullPath}.meta.tmp.${nonce}`;
    const metaPath = `${fullPath}.meta.json`;

    const metadata: BlobMetadata = {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      runId: input.runId,
      artifactId: input.artifactId,
      contentType: input.contentType,
      byteLength,
      checksum,
      safeObjectKey: relKey,
      createdAt: new Date().toISOString(),
    };

    try {
      // Write to temp files
      await fs.writeFile(tmpDataPath, buffer);
      await fs.writeFile(tmpMetaPath, JSON.stringify(metadata, null, 2), 'utf8');

      // Atomic renames
      await fs.rename(tmpDataPath, fullPath);
      await fs.rename(tmpMetaPath, metaPath);

      return metadata;
    } catch (err) {
      // Cleanup orphan temp files if write/rename failed
      try {
        await fs.unlink(tmpDataPath);
      } catch {}
      try {
        await fs.unlink(tmpMetaPath);
      } catch {}
      throw err;
    }
  }

  async get(locator: BlobLocator): Promise<BlobPayload | null> {
    const { fullPath } = this.resolvePath(locator);
    await this.assertNotEscapedSymlink(fullPath);

    if (!(await this.pathExists(fullPath))) {
      return null;
    }

    const content = await fs.readFile(fullPath);
    const metadata = await this.getMetadata(locator);

    if (!metadata) {
      return null;
    }

    return { metadata, content };
  }

  async exists(locator: BlobLocator): Promise<boolean> {
    const { fullPath } = this.resolvePath(locator);
    await this.assertNotEscapedSymlink(fullPath);
    return this.pathExists(fullPath);
  }

  async delete(locator: BlobLocator): Promise<boolean> {
    const { fullPath } = this.resolvePath(locator);
    await this.assertNotEscapedSymlink(fullPath);

    if (!(await this.pathExists(fullPath))) {
      return false;
    }

    const metaPath = `${fullPath}.meta.json`;
    await fs.unlink(fullPath);
    try {
      await fs.unlink(metaPath);
    } catch {}

    return true;
  }

  async getMetadata(locator: BlobLocator): Promise<BlobMetadata | null> {
    const { fullPath, relKey } = this.resolvePath(locator);
    await this.assertNotEscapedSymlink(fullPath);

    if (!(await this.pathExists(fullPath))) {
      return null;
    }

    const metaPath = `${fullPath}.meta.json`;
    if (await this.pathExists(metaPath)) {
      try {
        const raw = await fs.readFile(metaPath, 'utf8');
        return JSON.parse(raw) as BlobMetadata;
      } catch {
        // Fall back to computing from raw file
      }
    }

    const stats = await fs.stat(fullPath);
    const content = await fs.readFile(fullPath);
    const checksum = createHash('sha256').update(content).digest('hex');

    return {
      workspaceId: locator.workspaceId,
      projectId: locator.projectId,
      runId: locator.runId,
      artifactId: locator.artifactId,
      contentType: 'application/octet-stream',
      byteLength: stats.size,
      checksum,
      safeObjectKey: relKey,
      createdAt: stats.birthtime.toISOString(),
    };
  }

  async close(): Promise<void> {
    // No background handles to release for filesystem
  }
}
