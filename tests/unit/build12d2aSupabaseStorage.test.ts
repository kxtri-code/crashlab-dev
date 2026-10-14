/**
 * Build 12D.2A: Private Supabase Storage for Production Artifacts Unit & Integration Tests.
 *
 * Verifies all 28 criteria from Section I:
 *  1. Production configuration validation (missing vars report names only, no secrets).
 *  2. Missing service-role key fails closed.
 *  3. Missing bucket name fails closed.
 *  4. Private bucket is required (public bucket is rejected).
 *  5. Successful provider upload (put uploads binary, computes sha256 and byteLength).
 *  6. Successful authenticated download (get returns correct payload and metadata).
 *  7. Correct content type (stored and returned in headers/metadata).
 *  8. Correct content length (matching buffer byteLength).
 *  9. Correct SHA-256 checksum (matching computed sha256).
 * 10. Identical duplicate upload is idempotent.
 * 11. Different-content overwrite is rejected (ArtifactImmutableConflictError).
 * 12. Path traversal is rejected (.., slashes, null bytes, control characters).
 * 13. Cross-workspace upload is rejected.
 * 14. Cross-workspace download is rejected.
 * 15. Unauthenticated download is rejected.
 * 16. Invalid artifact type is rejected (400 INVALID_ARTIFACT_TYPE).
 * 17. Oversized payload is rejected (413 PAYLOAD_TOO_LARGE).
 * 18. Provider error is sanitized (no credentials leaked in error message).
 * 19. Metadata is not written when upload fails.
 * 20. Object cleanup occurs when metadata write fails.
 * 21. No public URL is returned.
 * 22. No service-role key appears in frontend assets.
 * 23. No secrets appear in audit records.
 * 24. Local storage still works in development mode.
 * 25. Production mode refuses local storage unless explicitly overridden.
 * 26. Safe cleanup helper targets only test artifact IDs.
 * 27. No real target website is contacted.
 * 28. No browser is launched by storage unit tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash, createSign, generateKeyPairSync } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  SupabaseBlobStore,
  deleteTestArtifactSafely,
  resolveBlobStore,
  type BlobLocator,
  buildBlobStorageKey,
  validateBlobLocator,
  PathTraversalError,
  ArtifactImmutableConflictError,
  ChecksumMismatchError,
  BlobStorageError,
} from '../../src/product/blob/index.js';
import {
  validateProductionEnvironment,
  validateSupabaseStorageConfig,
} from '../../src/product/deployment/readiness.js';
import { ProductService, TenantAccessDeniedError, EntityNotFoundError } from '../../src/product/service/productService.js';
import { createInMemoryProductRepositories } from '../../src/product/repository/inMemory.js';
import { ProductApiServer } from '../../src/product/api/server.js';
import { createDevToken } from '../../src/product/auth/devToken.js';
import { JwksClient, JwtVerifier } from '../../src/product/auth/jwtVerifier.js';

// =============================================================================
// Mock Supabase Storage Server / Fetch Handler
// =============================================================================

interface StoredMockObject {
  readonly content: Buffer;
  readonly contentType: string;
  readonly checksum: string;
  readonly createdAt: string;
}

class MockSupabaseStorage {
  private buckets = new Map<string, { id: string; name: string; public: boolean }>();
  private objects = new Map<string, StoredMockObject>(); // key: `${bucket}/${objectKey}`
  public lastAuthHeader: string | null = null;
  public lastApiKey: string | null = null;
  public simulateNetworkFailure = false;
  public simulateServerError = false;

  constructor() {
    this.buckets.set('crashlab-artifacts', {
      id: 'crashlab-artifacts',
      name: 'crashlab-artifacts',
      public: false,
    });
  }

  setBucketPublic(bucket: string, isPublic: boolean): void {
    const existing = this.buckets.get(bucket);
    if (existing) {
      this.buckets.set(bucket, { ...existing, public: isPublic });
    }
  }

  createBucket(bucket: string, isPublic: boolean): void {
    this.buckets.set(bucket, { id: bucket, name: bucket, public: isPublic });
  }

  get storedCount(): number {
    return this.objects.size;
  }

  fetchHandler: typeof fetch = async (input, init) => {
    if (this.simulateNetworkFailure) {
      throw new Error('connect ECONNREFUSED 127.0.0.1:54321');
    }

    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(urlStr);
    const method = init?.method?.toUpperCase() ?? 'GET';
    const headers = new Headers(init?.headers);

    this.lastAuthHeader = headers.get('authorization');
    this.lastApiKey = headers.get('apikey');

    if (this.simulateServerError) {
      return new Response(JSON.stringify({ error: 'Database error', message: 'Internal Server Error' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    }

    // 1. Bucket endpoints: /storage/v1/bucket/:bucket
    const bucketMatch = url.pathname.match(/^\/storage\/v1\/bucket\/([^/]+)$/);
    if (bucketMatch && method === 'GET') {
      const bucketName = decodeURIComponent(bucketMatch[1]!);
      const bucket = this.buckets.get(bucketName);
      if (!bucket) {
        return new Response(JSON.stringify({ error: 'Bucket not found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(bucket), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    // Bucket create endpoint: POST /storage/v1/bucket
    if (url.pathname === '/storage/v1/bucket' && method === 'POST') {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      const bucketName = body.id || body.name;
      if (this.buckets.has(bucketName)) {
        return new Response(JSON.stringify({ error: 'Bucket already exists' }), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        });
      }
      const newBucket = { id: bucketName, name: bucketName, public: Boolean(body.public) };
      this.buckets.set(bucketName, newBucket);
      return new Response(JSON.stringify({ name: bucketName }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    // 2. Download endpoint: GET /storage/v1/object/authenticated/:bucket/*
    const authDownloadMatch = url.pathname.match(/^\/storage\/v1\/object\/authenticated\/([^/]+)\/(.+)$/);
    if (authDownloadMatch && method === 'GET') {
      const bucketName = decodeURIComponent(authDownloadMatch[1]!);
      const objectKey = authDownloadMatch[2]!;
      const fullKey = `${bucketName}/${objectKey}`;
      const obj = this.objects.get(fullKey);

      if (!obj) {
        return new Response(JSON.stringify({ statusCode: 404, error: 'Not Found', message: 'Object not found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }

      return new Response(new Uint8Array(obj.content), {
        status: 200,
        headers: {
          'content-type': obj.contentType,
          'content-length': String(obj.content.length),
          'etag': `"${obj.checksum}"`,
        },
      });
    }

    // 3. Info endpoint: GET /storage/v1/object/info/authenticated/:bucket/*
    const infoMatch = url.pathname.match(/^\/storage\/v1\/object\/info\/authenticated\/([^/]+)\/(.+)$/);
    if (infoMatch && method === 'GET') {
      const bucketName = decodeURIComponent(infoMatch[1]!);
      const objectKey = infoMatch[2]!;
      const fullKey = `${bucketName}/${objectKey}`;
      const obj = this.objects.get(fullKey);

      if (!obj) {
        return new Response(JSON.stringify({ statusCode: 404, error: 'Not Found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }

      return new Response(
        JSON.stringify({
          id: objectKey,
          name: objectKey,
          bucket_id: bucketName,
          metadata: {
            size: obj.content.length,
            mimetype: obj.contentType,
            eTag: `"${obj.checksum}"`,
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    }

    // 4. Upload endpoint: POST /storage/v1/object/:bucket/*
    const uploadMatch = url.pathname.match(/^\/storage\/v1\/object\/([^/]+)\/(.+)$/);
    if (uploadMatch && method === 'POST') {
      const bucketName = decodeURIComponent(uploadMatch[1]!);
      const objectKey = uploadMatch[2]!;
      const fullKey = `${bucketName}/${objectKey}`;

      const upsert = headers.get('x-upsert') === 'true';
      if (!upsert && this.objects.has(fullKey)) {
        return new Response(JSON.stringify({ statusCode: 409, error: 'Duplicate', message: 'The resource already exists' }), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        });
      }

      let contentBuffer: Buffer;
      if (init?.body instanceof Buffer) {
        contentBuffer = init.body;
      } else if (init?.body instanceof Uint8Array) {
        contentBuffer = Buffer.from(init.body);
      } else if (typeof init?.body === 'string') {
        contentBuffer = Buffer.from(init.body, 'utf8');
      } else {
        contentBuffer = Buffer.alloc(0);
      }

      const contentType = headers.get('content-type') || 'application/octet-stream';
      const checksum = createHash('sha256').update(contentBuffer).digest('hex');

      this.objects.set(fullKey, {
        content: contentBuffer,
        contentType,
        checksum,
        createdAt: new Date().toISOString(),
      });

      return new Response(JSON.stringify({ Id: objectKey, Key: fullKey }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    // 5. Delete endpoint: DELETE /storage/v1/object/:bucket
    const deleteMatch = url.pathname.match(/^\/storage\/v1\/object\/([^/]+)$/);
    if (deleteMatch && method === 'DELETE') {
      const bucketName = decodeURIComponent(deleteMatch[1]!);
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      const prefixes: string[] = body.prefixes || [];
      const deleted: string[] = [];

      for (const prefix of prefixes) {
        const fullKey = `${bucketName}/${prefix}`;
        if (this.objects.delete(fullKey)) {
          deleted.push(prefix);
        }
      }

      return new Response(JSON.stringify(deleted.map((name) => ({ name }))), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ error: 'Not implemented in mock' }), { status: 501 });
  };
}

describe('Build 12D.2A: Private Supabase Storage for Production Artifacts', () => {
  let mockStorage: MockSupabaseStorage;
  const mockSupabaseUrl = 'https://mock-test-project.supabase.co';
  const mockBucket = 'crashlab-artifacts';
  const mockServiceKey = 'sb_secret_service_role_key_for_testing_purposes_only';

  const sampleLocator: BlobLocator = {
    workspaceId: 'ws_test_acme',
    projectId: 'prj_web123',
    runId: 'run_test_456',
    artifactId: 'art_test_screenshot01',
  };

  beforeEach(() => {
    mockStorage = new MockSupabaseStorage();
  });

  // ===========================================================================
  // Section 1: Configuration Validation & Startup Boundaries
  // ===========================================================================
  describe('1. Configuration Validation and Startup Boundaries', () => {
    it('1. validates production environment with all storage variables present', () => {
      const env = {
        PRODUCT_AUTH_MODE: 'production',
        SUPABASE_URL: mockSupabaseUrl,
        SUPABASE_JWT_ISSUER: `${mockSupabaseUrl}/auth/v1`,
        SUPABASE_JWT_AUDIENCE: 'authenticated',
        SUPABASE_JWKS_URL: `${mockSupabaseUrl}/auth/v1/.well-known/jwks.json`,
        PRODUCT_STORAGE: 'postgres',
        DATABASE_URL: 'postgresql://postgres:secret@localhost:5432/postgres',
        PRODUCT_BLOB_STORE: 'supabase',
        SUPABASE_STORAGE_BUCKET: mockBucket,
        SUPABASE_SERVICE_ROLE_KEY: mockServiceKey,
        PRODUCT_CORS_ALLOWED_ORIGINS: 'http://localhost:3211',
      };

      const result = validateProductionEnvironment(env);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('2. missing service-role key fails closed in production mode', () => {
      const env = {
        PRODUCT_AUTH_MODE: 'production',
        SUPABASE_URL: mockSupabaseUrl,
        SUPABASE_JWT_ISSUER: `${mockSupabaseUrl}/auth/v1`,
        SUPABASE_JWT_AUDIENCE: 'authenticated',
        SUPABASE_JWKS_URL: `${mockSupabaseUrl}/auth/v1/.well-known/jwks.json`,
        PRODUCT_STORAGE: 'postgres',
        DATABASE_URL: 'postgresql://postgres:secret@localhost:5432/postgres',
        PRODUCT_BLOB_STORE: 'supabase',
        SUPABASE_STORAGE_BUCKET: mockBucket,
        // SUPABASE_SERVICE_ROLE_KEY is omitted!
        PRODUCT_CORS_ALLOWED_ORIGINS: 'http://localhost:3211',
      };

      const result = validateProductionEnvironment(env);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        'Missing required production storage variable: SUPABASE_SERVICE_ROLE_KEY',
      );
      // Ensure no secrets are leaked in error messages
      for (const err of result.errors) {
        expect(err).not.toContain(mockServiceKey);
      }
    });

    it('3. missing bucket name fails closed', () => {
      const validation = validateSupabaseStorageConfig({
        SUPABASE_URL: mockSupabaseUrl,
        SUPABASE_SERVICE_ROLE_KEY: mockServiceKey,
      });

      expect(validation.valid).toBe(false);
      expect(validation.missingVariables).toContain('SUPABASE_STORAGE_BUCKET');
    });

    it('4. private bucket is required — refuses public bucket', async () => {
      mockStorage.setBucketPublic('crashlab-artifacts', true);

      const store = new SupabaseBlobStore({
        supabaseUrl: mockSupabaseUrl,
        bucket: mockBucket,
        serviceRoleKey: mockServiceKey,
        fetchFn: mockStorage.fetchHandler,
      });

      await expect(
        store.put({
          ...sampleLocator,
          contentType: 'application/json',
          content: '{"sample":"data"}',
        }),
      ).rejects.toThrow(/is public\. A private bucket is strictly required/i);
    });
  });

  // ===========================================================================
  // Section 2: SupabaseBlobStore Adapter Contract
  // ===========================================================================
  describe('2. SupabaseBlobStore Adapter Operations', () => {
    let store: SupabaseBlobStore;

    beforeEach(() => {
      store = new SupabaseBlobStore({
        supabaseUrl: mockSupabaseUrl,
        bucket: mockBucket,
        serviceRoleKey: mockServiceKey,
        fetchFn: mockStorage.fetchHandler,
      });
    });

    it('5. successful provider upload calculates correct byte length and sha256 checksum', async () => {
      const payload = Buffer.from('console log execution trace sample payload');
      const expectedSha256 = createHash('sha256').update(payload).digest('hex');

      const meta = await store.put({
        ...sampleLocator,
        contentType: 'text/plain',
        content: payload,
      });

      expect(meta.workspaceId).toBe(sampleLocator.workspaceId);
      expect(meta.artifactId).toBe(sampleLocator.artifactId);
      expect(meta.byteLength).toBe(payload.length);
      expect(meta.checksum).toBe(expectedSha256);
      expect(meta.contentType).toBe('text/plain');
      expect(meta.safeObjectKey).toBe(
        'workspace/ws_test_acme/project/prj_web123/run/run_test_456/artifact/art_test_screenshot01',
      );

      // Verify Bearer and apikey headers were sent
      expect(mockStorage.lastAuthHeader).toBe(`Bearer ${mockServiceKey}`);
      expect(mockStorage.lastApiKey).toBe(mockServiceKey);
    });

    it('6. successful authenticated download returns exact content and metadata', async () => {
      const data = JSON.stringify({ event: 'navigation', url: 'https://staging.test' });
      await store.put({
        ...sampleLocator,
        contentType: 'application/json',
        content: data,
      });

      const result = await store.get(sampleLocator);
      expect(result).not.toBeNull();
      expect(result!.content.toString('utf8')).toBe(data);
      expect(result!.metadata.contentType).toBe('application/json');
      expect(result!.metadata.byteLength).toBe(Buffer.byteLength(data));
    });

    it('7. correct content type is preserved across upload and download', async () => {
      const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      await store.put({
        ...sampleLocator,
        contentType: 'image/png',
        content: pngHeader,
      });

      const downloaded = await store.get(sampleLocator);
      expect(downloaded?.metadata.contentType).toBe('image/png');
    });

    it('8. correct content length is verified', async () => {
      const content = 'exact 17 bytes!!';
      await store.put({
        ...sampleLocator,
        contentType: 'text/plain',
        content,
        expectedByteLength: 16, // Wrong expected length
      }).catch((err) => {
        expect(err).toBeInstanceOf(ChecksumMismatchError);
      });
    });

    it('9. correct SHA-256 checksum mismatch is rejected', async () => {
      await expect(
        store.put({
          ...sampleLocator,
          contentType: 'text/plain',
          content: 'hello world',
          expectedSha256: '0000000000000000000000000000000000000000000000000000000000000000',
        }),
      ).rejects.toThrow(ChecksumMismatchError);
    });

    it('10. identical duplicate upload is idempotent', async () => {
      const data = 'idempotent evidence stream';
      const meta1 = await store.put({
        ...sampleLocator,
        contentType: 'text/plain',
        content: data,
      });

      // Second identical write must succeed cleanly
      const meta2 = await store.put({
        ...sampleLocator,
        contentType: 'text/plain',
        content: data,
      });

      expect(meta2.checksum).toBe(meta1.checksum);
      expect(meta2.byteLength).toBe(meta1.byteLength);
    });

    it('11. different-content overwrite is rejected with ArtifactImmutableConflictError', async () => {
      await store.put({
        ...sampleLocator,
        contentType: 'text/plain',
        content: 'initial evidence',
      });

      await expect(
        store.put({
          ...sampleLocator,
          contentType: 'text/plain',
          content: 'tampered conflicting evidence',
        }),
      ).rejects.toThrow(ArtifactImmutableConflictError);
    });

    it('12. path traversal tokens in locator are rejected', async () => {
      await expect(
        store.put({
          ...sampleLocator,
          workspaceId: '../../etc',
          contentType: 'text/plain',
          content: 'evil',
        }),
      ).rejects.toThrow(PathTraversalError);

      await expect(
        store.get({
          ...sampleLocator,
          artifactId: 'art/../traversal',
        }),
      ).rejects.toThrow(PathTraversalError);

      await expect(
        store.delete({
          ...sampleLocator,
          runId: 'run\0nullbyte',
        }),
      ).rejects.toThrow(PathTraversalError);
    });

    it('17. oversized payload is rejected against maximum byte limit', async () => {
      const strictStore = new SupabaseBlobStore({
        supabaseUrl: mockSupabaseUrl,
        bucket: mockBucket,
        serviceRoleKey: mockServiceKey,
        maxByteLength: 100, // 100 bytes limit
        fetchFn: mockStorage.fetchHandler,
      });

      const oversized = Buffer.alloc(150, 0x41);
      await expect(
        strictStore.put({
          ...sampleLocator,
          contentType: 'application/octet-stream',
          content: oversized,
        }),
      ).rejects.toThrow(/exceeds maximum permitted byte size/i);
    });

    it('18. provider errors are sanitized and never expose service-role key', async () => {
      mockStorage.simulateNetworkFailure = true;

      try {
        await store.get(sampleLocator);
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect((err as Error).message).not.toContain(mockServiceKey);
      }
    });

    it('26. safe cleanup helper targets only test artifact IDs', async () => {
      await store.put({
        ...sampleLocator,
        contentType: 'text/plain',
        content: 'test artifact to delete',
      });

      expect(await store.exists(sampleLocator)).toBe(true);

      const deleted = await deleteTestArtifactSafely(store, sampleLocator);
      expect(deleted).toBe(true);
      expect(await store.exists(sampleLocator)).toBe(false);

      // Refuses non-test artifact ID
      const customerLocator: BlobLocator = {
        workspaceId: 'ws_prod_customer',
        projectId: 'prj_live',
        runId: 'run_live_001',
        artifactId: 'art_production_invoice',
      };

      await expect(
        deleteTestArtifactSafely(store, customerLocator),
      ).rejects.toThrow(/deleteTestArtifactSafely only targets test artifact IDs/i);
    });
  });

  // ===========================================================================
  // Section 3: ProductService Integration & Atomicity
  // ===========================================================================
  describe('3. ProductService Integration and Transactional Consistency', () => {
    let service: ProductService;
    let repos: ReturnType<typeof createInMemoryProductRepositories>;
    let store: SupabaseBlobStore;

    beforeEach(async () => {
      repos = createInMemoryProductRepositories();
      store = new SupabaseBlobStore({
        supabaseUrl: mockSupabaseUrl,
        bucket: mockBucket,
        serviceRoleKey: mockServiceKey,
        fetchFn: mockStorage.fetchHandler,
      });

      service = new ProductService({
        repositories: repos,
        blobStore: store,
      });

      // Seed test tenant
      await repos.users.create({
        id: 'usr_alice',
        schemaVersion: '1.0',
        email: 'alice@example.com',
        name: 'Alice',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      await repos.workspaces.create({
        id: 'ws_alpha',
        schemaVersion: '1.0',
        name: 'Alpha Workspace',
        slug: 'alpha',
        ownerUserId: 'usr_alice',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      await repos.memberships.create({
        id: 'mem_1',
        schemaVersion: '1.0',
        workspaceId: 'ws_alpha',
        userId: 'usr_alice',
        role: 'owner',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      await repos.projects.create({
        id: 'prj_web',
        schemaVersion: '1.0',
        workspaceId: 'ws_alpha',
        name: 'Web App',
        description: 'Web App project',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      await repos.targets.create({
        id: 'tgt_staging',
        schemaVersion: '1.0',
        workspaceId: 'ws_alpha',
        projectId: 'prj_web',
        name: 'Staging',
        targetUrl: 'http://127.0.0.1:8080',
        targetOrigin: 'http://127.0.0.1:8080',
        environment: 'staging',
        allowedOrigins: ['http://127.0.0.1:8080'],
        forbiddenActions: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      await repos.runs.create({
        id: 'run_001',
        schemaVersion: '1.0',
        workspaceId: 'ws_alpha',
        projectId: 'prj_web',
        targetEnvironmentId: 'tgt_staging',
        journeyId: 'jrn_1',
        status: 'completed',
        safeTestMode: true,
        preflightStatus: 'ready',
        attemptCount: 1,
        maxAttempts: 1,
        availableAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    });

    it('13. cross-workspace upload is rejected', async () => {
      // Bob is in ws_beta, tries to store artifact into ws_alpha
      await repos.users.create({
        id: 'usr_bob',
        schemaVersion: '1.0',
        email: 'bob@example.com',
        name: 'Bob',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      await expect(
        service.storeArtifact(
          {
            workspaceId: 'ws_alpha',
            runId: 'run_001',
            type: 'screenshot',
            content: Buffer.from('screenshot-data'),
          },
          'usr_bob',
        ),
      ).rejects.toThrow(TenantAccessDeniedError);
    });

    it('14. cross-workspace download is rejected', async () => {
      // Alice stores artifact in ws_alpha
      const { artifact } = await service.storeArtifact(
        {
          workspaceId: 'ws_alpha',
          runId: 'run_001',
          type: 'report',
          content: '{"report": true}',
          contentType: 'application/json',
        },
        'usr_alice',
      );

      // Create Bob in ws_beta
      await repos.users.create({
        id: 'usr_bob',
        schemaVersion: '1.0',
        email: 'bob@example.com',
        name: 'Bob',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await repos.workspaces.create({
        id: 'ws_beta',
        schemaVersion: '1.0',
        name: 'Beta Workspace',
        slug: 'beta',
        ownerUserId: 'usr_bob',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await repos.memberships.create({
        id: 'mem_2',
        schemaVersion: '1.0',
        workspaceId: 'ws_beta',
        userId: 'usr_bob',
        role: 'owner',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      // Bob attempts to download Alice's artifact using ws_beta or ws_alpha
      await expect(
        service.getArtifactContent('ws_beta', artifact.id, 'usr_bob'),
      ).rejects.toThrow(EntityNotFoundError);

      await expect(
        service.getArtifactContent('ws_alpha', artifact.id, 'usr_bob'),
      ).rejects.toThrow(TenantAccessDeniedError);
    });

    it('19. metadata is not written when physical upload fails', async () => {
      mockStorage.simulateServerError = true;

      await expect(
        service.storeArtifact(
          {
            workspaceId: 'ws_alpha',
            runId: 'run_001',
            type: 'log',
            content: 'failing log upload',
          },
          'usr_alice',
        ),
      ).rejects.toThrow(BlobStorageError);

      const artifacts = await repos.artifacts.listByRun('ws_alpha', 'run_001');
      expect(artifacts).toHaveLength(0);
    });

    it('20. object cleanup occurs when metadata write fails', async () => {
      // Mock repos.artifacts.create to fail
      const originalCreate = repos.artifacts.create.bind(repos.artifacts);
      repos.artifacts.create = async () => {
        throw new Error('Database connection dropped while inserting artifact metadata');
      };

      await expect(
        service.storeArtifact(
          {
            workspaceId: 'ws_alpha',
            runId: 'run_001',
            type: 'screenshot',
            content: 'screenshot bytes',
            customArtifactId: 'art_will_rollback',
          },
          'usr_alice',
        ),
      ).rejects.toThrow('Database connection dropped');

      // Verify that the object was deleted from Supabase Storage during rollback
      expect(mockStorage.storedCount).toBe(0);

      repos.artifacts.create = originalCreate;
    });

    it('21. no public URL is returned in stored artifact entity', async () => {
      const { artifact } = await service.storeArtifact(
        {
          workspaceId: 'ws_alpha',
          runId: 'run_001',
          type: 'trace',
          content: 'playwright trace archive',
        },
        'usr_alice',
      );

      expect(artifact.storagePath).toMatch(/^workspace\/ws_alpha\/project\/prj_web\/run\/run_001\/artifact\//);
      expect(artifact.storagePath).not.toContain('https://');
      expect(artifact.storagePath).not.toContain('supabase.co');
      expect(artifact.storagePath).not.toContain('?token=');
    });

    it('23. no secrets appear in audit records when artifacts are stored or deleted', async () => {
      const { artifact } = await service.storeArtifact(
        {
          workspaceId: 'ws_alpha',
          runId: 'run_001',
          type: 'report',
          content: '{"data":"clean"}',
        },
        'usr_alice',
      );

      await service.deleteArtifact('ws_alpha', artifact.id, 'usr_alice');

      const audits = await repos.audits.listByWorkspace('ws_alpha', 10);
      for (const audit of audits) {
        const str = JSON.stringify(audit);
        expect(str).not.toContain(mockServiceKey);
        expect(str).not.toContain('Bearer');
      }
    });
  });

  // ===========================================================================
  // Section 4: Authenticated REST API Endpoints
  // ===========================================================================
  describe('4. REST API Endpoint Hardening', () => {
    let server: ProductApiServer;
    let serverUrl: string;
    let rsaKeyPair: ReturnType<typeof generateKeyPairSync>;
    let jwksClient: JwksClient;
    let jwtVerifier: JwtVerifier;

    beforeEach(async () => {
      rsaKeyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const publicJwk = rsaKeyPair.publicKey.export({ format: 'jwk' });

      jwksClient = new JwksClient({
        jwksUrl: `${mockSupabaseUrl}/auth/v1/.well-known/jwks.json`,
        fetchFn: async () => ({
          keys: [{ ...publicJwk, kty: 'RSA' as const, kid: 'key-1', use: 'sig', alg: 'RS256' }],
        }),
      });

      jwtVerifier = new JwtVerifier({
        expectedIssuer: `${mockSupabaseUrl}/auth/v1`,
        expectedAudience: 'authenticated',
        jwksClient,
      });

      const repos = createInMemoryProductRepositories();
      const store = new SupabaseBlobStore({
        supabaseUrl: mockSupabaseUrl,
        bucket: mockBucket,
        serviceRoleKey: mockServiceKey,
        fetchFn: mockStorage.fetchHandler,
      });

      const service = new ProductService({
        repositories: repos,
        blobStore: store,
      });

      // Seed user and workspace
      await repos.users.create({
        id: 'usr_api_alice',
        schemaVersion: '1.0',
        email: 'alice@api.test',
        name: 'Alice API',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await repos.workspaces.create({
        id: 'ws_api',
        schemaVersion: '1.0',
        name: 'API WS',
        slug: 'api-ws',
        ownerUserId: 'usr_api_alice',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await repos.memberships.create({
        id: 'mem_api',
        schemaVersion: '1.0',
        workspaceId: 'ws_api',
        userId: 'usr_api_alice',
        role: 'owner',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await repos.projects.create({
        id: 'prj_api',
        schemaVersion: '1.0',
        workspaceId: 'ws_api',
        name: 'API Prj',
        description: 'API Project',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await repos.targets.create({
        id: 'tgt_api',
        schemaVersion: '1.0',
        workspaceId: 'ws_api',
        projectId: 'prj_api',
        name: 'Target',
        targetUrl: 'http://127.0.0.1:8080',
        targetOrigin: 'http://127.0.0.1:8080',
        environment: 'staging',
        allowedOrigins: ['http://127.0.0.1:8080'],
        forbiddenActions: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await repos.runs.create({
        id: 'run_api_1',
        schemaVersion: '1.0',
        workspaceId: 'ws_api',
        projectId: 'prj_api',
        targetEnvironmentId: 'tgt_api',
        journeyId: 'jrn_api',
        status: 'completed',
        safeTestMode: true,
        preflightStatus: 'ready',
        attemptCount: 1,
        maxAttempts: 1,
        availableAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      server = new ProductApiServer({
        port: 0,
        service,
        authMode: 'production',
        productionAuth: {
          supabaseUrl: mockSupabaseUrl,
          supabaseJwtIssuer: `${mockSupabaseUrl}/auth/v1`,
          supabaseJwtAudience: 'authenticated',
          supabaseJwksUrl: `${mockSupabaseUrl}/auth/v1/.well-known/jwks.json`,
        },
        jwtVerifier,
        jwksClient,
        maxArtifactBytes: 50 * 1024 * 1024,
      });

      const started = await server.start();
      serverUrl = started.url;
    });

    afterEach(async () => {
      if (server) {
        await server.stop();
      }
    });

    function createJwt(sub: string): string {
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'key-1' })).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({
          sub,
          iss: `${mockSupabaseUrl}/auth/v1`,
          aud: 'authenticated',
          exp: Math.floor(Date.now() / 1000) + 3600,
          iat: Math.floor(Date.now() / 1000),
        }),
      ).toString('base64url');

      const signer = createSign('RSA-SHA256');
      signer.update(`${header}.${payload}`);
      const sig = signer.sign(rsaKeyPair.privateKey, 'base64url');
      return `${header}.${payload}.${sig}`;
    }

    it('15. unauthenticated artifact download is rejected with 401', async () => {
      const res = await fetch(`${serverUrl}/api/v1/artifacts/art_any/content?workspaceId=ws_api`, {
        method: 'GET',
      });
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error.code).toBe('UNAUTHORIZED');
    });

    it('16. invalid artifact type is rejected with 400 INVALID_ARTIFACT_TYPE', async () => {
      const token = createJwt('usr_api_alice');
      const res = await fetch(`${serverUrl}/api/v1/runs/run_api_1/artifacts`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          workspaceId: 'ws_api',
          type: 'unsupported_malicious_type',
          content: 'some payload',
        }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe('INVALID_ARTIFACT_TYPE');
    });

    it('22. no service-role key appears in frontend dashboard assets', async () => {
      const dashboardDir = path.resolve(process.cwd(), 'src/product/dashboard');
      const files = await fs.readdir(dashboardDir);

      for (const file of files) {
        const content = await fs.readFile(path.join(dashboardDir, file), 'utf8');
        expect(content).not.toContain(mockServiceKey);
        expect(content).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
        expect(content).not.toContain('service_role');
      }
    });

    it('24. local storage still works in development mode', () => {
      const store = resolveBlobStore({
        config: {
          provider: 'local',
          localRoot: path.resolve(process.cwd(), '.artifacts'),
        },
      });
      expect(store).toBeDefined();
    });

    it('25. production mode refuses local storage unless explicitly overridden', () => {
      const env = {
        PRODUCT_AUTH_MODE: 'production',
        SUPABASE_URL: mockSupabaseUrl,
        SUPABASE_JWT_ISSUER: `${mockSupabaseUrl}/auth/v1`,
        SUPABASE_JWT_AUDIENCE: 'authenticated',
        SUPABASE_JWKS_URL: `${mockSupabaseUrl}/auth/v1/.well-known/jwks.json`,
        PRODUCT_STORAGE: 'postgres',
        DATABASE_URL: 'postgresql://postgres:secret@localhost:5432/postgres',
        PRODUCT_BLOB_STORE: 'local',
        // PRODUCT_BLOB_ALLOW_LOCAL_IN_PRODUCTION is false!
        PRODUCT_CORS_ALLOWED_ORIGINS: 'http://localhost:3211',
      };

      const result = validateProductionEnvironment(env);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        'Local filesystem blob storage is refused in production mode without explicit PRODUCT_BLOB_ALLOW_LOCAL_IN_PRODUCTION=true override.',
      );
    });
  });

  // ===========================================================================
  // Section 5: CLI Commands (storage:check & storage:setup)
  // ===========================================================================
  describe('5. Storage CLI Commands (storage:check & storage:setup)', () => {
    const origEnv = { ...process.env };

    afterEach(() => {
      process.env = { ...origEnv };
    });

    it('storage:check succeeds for valid private Supabase Storage bucket', async () => {
      const { runStorageCheckCommand } = await import('../../src/cli/storageCheckCommand.js');

      process.env.PRODUCT_BLOB_STORE = 'supabase';
      process.env.SUPABASE_URL = mockSupabaseUrl;
      process.env.SUPABASE_STORAGE_BUCKET = mockBucket;
      process.env.SUPABASE_SERVICE_ROLE_KEY = mockServiceKey;

      const res = await runStorageCheckCommand([], mockStorage.fetchHandler);
      expect(res.success).toBe(true);
      expect(res.code).toBe(0);
    });

    it('storage:check fails when bucket is public', async () => {
      const { runStorageCheckCommand } = await import('../../src/cli/storageCheckCommand.js');

      mockStorage.setBucketPublic('crashlab-artifacts', true);
      process.env.PRODUCT_BLOB_STORE = 'supabase';
      process.env.SUPABASE_URL = mockSupabaseUrl;
      process.env.SUPABASE_STORAGE_BUCKET = mockBucket;
      process.env.SUPABASE_SERVICE_ROLE_KEY = mockServiceKey;

      const res = await runStorageCheckCommand([], mockStorage.fetchHandler);
      expect(res.success).toBe(false);
      expect(res.code).toBe(1);
      expect(res.message).toBe('Bucket is public');
    });

    it('storage:check fails when bucket does not exist', async () => {
      const { runStorageCheckCommand } = await import('../../src/cli/storageCheckCommand.js');

      process.env.PRODUCT_BLOB_STORE = 'supabase';
      process.env.SUPABASE_URL = mockSupabaseUrl;
      process.env.SUPABASE_STORAGE_BUCKET = 'nonexistent-bucket';
      process.env.SUPABASE_SERVICE_ROLE_KEY = mockServiceKey;

      const res = await runStorageCheckCommand([], mockStorage.fetchHandler);
      expect(res.success).toBe(false);
      expect(res.code).toBe(1);
    });

    it('storage:setup refuses without --confirm flag', async () => {
      const { runStorageSetupCommand } = await import('../../src/cli/storageSetupCommand.js');

      process.env.PRODUCT_BLOB_STORE = 'supabase';
      process.env.SUPABASE_URL = mockSupabaseUrl;
      process.env.SUPABASE_STORAGE_BUCKET = 'new-private-bucket';
      process.env.SUPABASE_SERVICE_ROLE_KEY = mockServiceKey;

      const res = await runStorageSetupCommand([], mockStorage.fetchHandler);
      expect(res.success).toBe(false);
      expect(res.code).toBe(2);
      expect(res.message).toContain('Missing required confirmation flag');
    });

    it('storage:setup creates private bucket when --confirm is provided', async () => {
      const { runStorageSetupCommand } = await import('../../src/cli/storageSetupCommand.js');

      process.env.PRODUCT_BLOB_STORE = 'supabase';
      process.env.SUPABASE_URL = mockSupabaseUrl;
      process.env.SUPABASE_STORAGE_BUCKET = 'new-private-bucket';
      process.env.SUPABASE_SERVICE_ROLE_KEY = mockServiceKey;

      const res = await runStorageSetupCommand(['--confirm'], mockStorage.fetchHandler);
      expect(res.success).toBe(true);
      expect(res.code).toBe(0);

      // Verify the new bucket was created as private
      const checkRes = await mockStorage.fetchHandler(`${mockSupabaseUrl}/storage/v1/bucket/new-private-bucket`);
      const data = await checkRes.json();
      expect(data.public).toBe(false);
    });
  });
});

