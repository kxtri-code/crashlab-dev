/**
 * Provider-Neutral Blob Storage Contract — Build 12B.2A: Secure Artifact Blob Storage.
 *
 * Defines the physical storage boundary for durable test execution payloads
 * (screenshots, traces, HARs, reports, JSON evidence).
 *
 * Enforces:
 * - Deterministic, tenant-scoped storage paths
 * - Cryptographic checksum verification (SHA-256)
 * - Path traversal prevention
 * - Secret-free audit and error reporting
 * - Immutability of stored evidence artifacts
 */

export interface BlobLocator {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly artifactId: string;
}

export interface PutBlobInput extends BlobLocator {
  readonly contentType: string;
  readonly content: Buffer | Uint8Array | string;
  readonly expectedByteLength?: number;
  readonly expectedSha256?: string;
}

export interface BlobMetadata {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly artifactId: string;
  readonly contentType: string;
  readonly byteLength: number;
  readonly checksum: string; // SHA-256 hex
  readonly safeObjectKey: string;
  readonly createdAt: string;
}

export interface BlobPayload {
  readonly metadata: BlobMetadata;
  readonly content: Buffer;
}

export interface BlobStore {
  put(input: PutBlobInput): Promise<BlobMetadata>;
  get(locator: BlobLocator): Promise<BlobPayload | null>;
  exists(locator: BlobLocator): Promise<boolean>;
  delete(locator: BlobLocator): Promise<boolean>;
  getMetadata(locator: BlobLocator): Promise<BlobMetadata | null>;
  close(): Promise<void>;
}

// =============================================================================
// Error Definitions
// =============================================================================

export class BlobStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlobStorageError';
  }
}

export class BlobNotFoundError extends BlobStorageError {
  constructor(message: string) {
    super(message);
    this.name = 'BlobNotFoundError';
  }
}

export class PathTraversalError extends BlobStorageError {
  constructor(message: string) {
    super(message);
    this.name = 'PathTraversalError';
  }
}

export class ArtifactImmutableConflictError extends BlobStorageError {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactImmutableConflictError';
  }
}

export class ChecksumMismatchError extends BlobStorageError {
  constructor(message: string) {
    super(message);
    this.name = 'ChecksumMismatchError';
  }
}

// =============================================================================
// Security & Path Validation Helpers
// =============================================================================

/** Strict regex allowing only alphanumeric characters, underscores, hyphens, and dots. */
const SAFE_ID_SEGMENT_REGEX = /^[a-zA-Z0-9_\-\.]+$/;

/**
 * Validates that an ID segment contains no traversal characters, slashes, or control characters.
 */
export function assertSafeIdSegment(value: string, segmentName: string): void {
  if (!value || typeof value !== 'string') {
    throw new PathTraversalError(`Invalid ${segmentName}: value must be a non-empty string.`);
  }

  // Check for control characters, null bytes, or slashes
  if (/[\x00-\x1f\x7f/\\:\0]/.test(value)) {
    throw new PathTraversalError(
      `Invalid ${segmentName} "${value}": contains prohibited path separators or control characters.`,
    );
  }

  // Prohibit dot directory navigation
  if (value === '.' || value === '..' || value.includes('..')) {
    throw new PathTraversalError(`Invalid ${segmentName} "${value}": directory traversal tokens are rejected.`);
  }

  if (!SAFE_ID_SEGMENT_REGEX.test(value)) {
    throw new PathTraversalError(
      `Invalid ${segmentName} "${value}": must contain only alphanumeric, dash, dot, or underscore characters.`,
    );
  }
}

/**
 * Validates every component of a BlobLocator for safety.
 */
export function validateBlobLocator(locator: BlobLocator): void {
  if (!locator || typeof locator !== 'object') {
    throw new PathTraversalError('BlobLocator must be a valid object.');
  }
  assertSafeIdSegment(locator.workspaceId, 'workspaceId');
  assertSafeIdSegment(locator.projectId, 'projectId');
  assertSafeIdSegment(locator.runId, 'runId');
  assertSafeIdSegment(locator.artifactId, 'artifactId');
}

/**
 * Constructs a deterministic, tenant-isolated safe object key.
 * Format: workspace/<workspaceId>/project/<projectId>/run/<runId>/artifact/<artifactId>
 */
export function buildBlobStorageKey(locator: BlobLocator): string {
  validateBlobLocator(locator);
  return `workspace/${locator.workspaceId}/project/${locator.projectId}/run/${locator.runId}/artifact/${locator.artifactId}`;
}
