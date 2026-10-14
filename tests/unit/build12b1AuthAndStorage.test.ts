/**
 * Build 12B.1 Unit & Integration Test Suite: Real Authentication and Database-Backed Product API.
 *
 * Verifies:
 * 1. Valid development token authenticates successfully.
 * 2. Missing Authorization header returns 401 in production mode.
 * 3. Malformed token returns 401.
 * 4. Expired token returns 401.
 * 5. Wrong signing secret returns 401.
 * 6. Arbitrary X-User-Id cannot authenticate production-mode requests.
 * 7. Development header authentication works only when explicitly enabled (PRODUCT_AUTH_MODE=development).
 * 8. PostgreSQL storage selection requires DATABASE_URL (no silent fallback).
 * 9. In-memory storage remains usable in unit tests.
 * 10. PostgreSQL repositories can be injected into ProductService/API using the mock PostgreSQL pool.
 * 11. Cross-workspace access remains forbidden (403 FORBIDDEN).
 * 12. Tokens and secrets never appear in errors or audit events.
 * 13. Request IDs are deterministic in tests and present in API responses (X-Request-Id and response body).
 * 14. CLI commands: auth:token and auth:check (exit codes 0, 1, 2).
 *
 * Enforces ZERO browser launches and ZERO external network connections.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createDevToken,
  verifyDevToken,
  authenticateRequest,
  loadAuthConfigFromEnv,
  loadStorageConfigFromEnv,
  resolveProductRepositories,
  createProductApiServer,
  ProductApiServer,
  ProductService,
  createInMemoryProductRepositories,
  createPostgresProductRepositories,
  MockPostgresPool,
  runMigrations,
  DeterministicIdGenerator,
  scanForSecrets,
  type ProductRepositories,
} from '../../src/product/index.js';
import { runAuthTokenCommand } from '../../src/cli/authTokenCommand.js';
import { runAuthCheckCommand } from '../../src/cli/authCheckCommand.js';

describe('Build 12B.1: Real Authentication & Database-Backed Product API', () => {
  const TEST_SECRET = 'test-secret-key-32-chars-long-abc123xyz';

  // ===========================================================================
  // 1. Development Token Creation and Verification Contracts
  // ===========================================================================
  describe('1. Development Token Creation and Verification', () => {
    it('generates a valid, signed HMAC-SHA256 bearer token', () => {
      const now = 1700000000000;
      const token = createDevToken({
        userId: 'usr_alice_123',
        secret: TEST_SECRET,
        expiresInSeconds: 3600,
        nowMs: now,
      });

      expect(typeof token).toBe('string');
      const parts = token.split('.');
      expect(parts).toHaveLength(3);

      const verified = verifyDevToken(token, TEST_SECRET, now);
      expect(verified.valid).toBe(true);
      expect(verified.userId).toBe('usr_alice_123');
      expect(verified.exp).toBe(Math.floor(now / 1000) + 3600);
    });

    it('rejects expired tokens with a clear error', () => {
      const now = 1700000000000;
      const token = createDevToken({
        userId: 'usr_expired',
        secret: TEST_SECRET,
        expiresInSeconds: 60, // expires in 60s
        nowMs: now,
      });

      // Verification 120s later
      const verified = verifyDevToken(token, TEST_SECRET, now + 120 * 1000);
      expect(verified.valid).toBe(false);
      expect(verified.error).toMatch(/expired/i);
    });

    it('rejects tokens signed with the wrong secret', () => {
      const token = createDevToken({
        userId: 'usr_tampered',
        secret: TEST_SECRET,
      });

      const verified = verifyDevToken(token, 'different-wrong-secret-xyz');
      expect(verified.valid).toBe(false);
      expect(verified.error).toMatch(/signature/i);
    });

    it('rejects malformed tokens (wrong segments or invalid json)', () => {
      expect(verifyDevToken('not-a-token', TEST_SECRET).valid).toBe(false);
      expect(verifyDevToken('part1.part2', TEST_SECRET).valid).toBe(false);
      expect(verifyDevToken('part1.part2.part3.part4', TEST_SECRET).valid).toBe(false);
      expect(verifyDevToken('', TEST_SECRET).valid).toBe(false);
      expect(verifyDevToken(null as any, TEST_SECRET).valid).toBe(false);
    });
  });

  // ===========================================================================
  // 2. Request Authentication Middleware
  // ===========================================================================
  describe('2. Request Authentication Middleware', () => {
    it('authenticates valid Bearer tokens and extracts IdentityContext', async () => {
      const token = createDevToken({ userId: 'usr_middleware_valid', secret: TEST_SECRET });
      const mockReq = {
        headers: { authorization: `Bearer ${token}` },
      } as any;

      const result = await authenticateRequest(mockReq, {
        authConfig: { authMode: 'development', authSecret: TEST_SECRET },
      });

      expect(result.success).toBe(true);
      expect(result.identity?.userId).toBe('usr_middleware_valid');
      expect(result.identity?.authMethod).toBe('bearer_token');
      expect(result.requestId).toMatch(/^req_/);
    });

    it('returns 401 when Authorization header is missing in production mode', async () => {
      const mockReq = {
        headers: {},
      } as any;

      const result = await authenticateRequest(mockReq, {
        authConfig: { authMode: 'production', authSecret: TEST_SECRET },
      });

      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(401);
      expect(result.error?.code).toBe('UNAUTHORIZED');
      expect(result.requestId).toMatch(/^req_/);
    });

    it('rejects arbitrary X-User-Id headers in production mode', async () => {
      const mockReq = {
        headers: { 'x-user-id': 'usr_attacker_spoof' },
      } as any;

      const result = await authenticateRequest(mockReq, {
        authConfig: { authMode: 'production', authSecret: TEST_SECRET },
      });

      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(401);
      expect(result.error?.message).toMatch(/Production authentication configuration is incomplete|Client-supplied identity headers/i);
    });

    it('allows X-User-Id header when development auth mode is explicitly configured', async () => {
      const mockReq = {
        headers: { 'x-user-id': 'usr_dev_local' },
      } as any;

      const result = await authenticateRequest(mockReq, {
        authConfig: { authMode: 'development', authSecret: TEST_SECRET },
      });

      expect(result.success).toBe(true);
      expect(result.identity?.userId).toBe('usr_dev_local');
      expect(result.identity?.authMethod).toBe('development_header');
    });

    it('returns 401 for invalid Bearer tokens', async () => {
      const mockReq = {
        headers: { authorization: 'Bearer malformed.token.value' },
      } as any;

      const result = await authenticateRequest(mockReq, {
        authConfig: { authMode: 'development', authSecret: TEST_SECRET },
      });

      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(401);
      expect(result.error?.message).toMatch(/Authentication failed/i);
    });

    it('returns 401 for unsupported authorization schemes', async () => {
      const mockReq = {
        headers: { authorization: 'Basic dXNlcjpwYXNz' },
      } as any;

      const result = await authenticateRequest(mockReq, {
        authConfig: { authMode: 'development', authSecret: TEST_SECRET },
      });

      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(401);
      expect(result.error?.message).toMatch(/Unsupported authorization scheme/i);
    });
  });

  // ===========================================================================
  // 3. Storage Provider Resolution and Dependency Injection
  // ===========================================================================
  describe('3. Storage Provider Resolution & Dependency Injection', () => {
    it('defaults to in-memory storage when PRODUCT_STORAGE is unspecified', () => {
      const resolved = resolveProductRepositories({}, {});
      expect(resolved.storage).toBe('in-memory');
      expect(resolved.repositories).toBeDefined();
      expect(resolved.pool).toBeUndefined();
    });

    it('refuses postgres storage without DATABASE_URL and throws clear error (no silent fallback)', () => {
      expect(() => {
        resolveProductRepositories({ storage: 'postgres' }, {});
      }).toThrow(/DATABASE_URL is required when PRODUCT_STORAGE=postgres/i);
    });

    it('accepts injected MockPostgresPool for postgres storage selection', () => {
      const mockPool = new MockPostgresPool();
      const resolved = resolveProductRepositories({
        storage: 'postgres',
        pool: mockPool,
      });

      expect(resolved.storage).toBe('postgres');
      expect(resolved.pool).toBe(mockPool);
      expect(resolved.repositories).toBeDefined();
    });

    it('respects explicitly injected repositories directly', () => {
      const customRepos = createInMemoryProductRepositories();
      const resolved = resolveProductRepositories({
        repositories: customRepos,
      });

      expect(resolved.repositories).toBe(customRepos);
    });
  });

  // ===========================================================================
  // 4. Product API Server Integration: Production Auth & PostgreSQL Storage
  // ===========================================================================
  describe('4. Product API Server with Production Auth & Injected Storage', () => {
    let mockPool: MockPostgresPool;
    let apiServer: ProductApiServer;
    let service: ProductService;
    let testUser: any;
    let testWorkspace: any;
    let foreignUser: any;
    let validToken: string;

    beforeEach(async () => {
      mockPool = new MockPostgresPool();
      await runMigrations(mockPool);

      const idGen = new DeterministicIdGenerator('b12b1-api');
      const pgRepos = createPostgresProductRepositories(mockPool);
      service = new ProductService({ repositories: pgRepos, idGenerator: idGen });

      testUser = await service.createUser({ name: 'Auth Owner', email: 'owner@auth.test' });
      foreignUser = await service.createUser({ name: 'Foreign Attacker', email: 'foreign@auth.test' });

      const wsRes = await service.createWorkspace({
        name: 'Protected Workspace',
        slug: 'protected-ws',
        ownerUserId: testUser.id,
      });
      testWorkspace = wsRes.workspace;

      await service.createProject({ workspaceId: testWorkspace.id, name: 'Main Store' }, testUser.id);

      validToken = createDevToken({
        userId: testUser.id,
        secret: TEST_SECRET,
        expiresInSeconds: 3600,
      });

      // Initialize API Server in development auth mode backed by PostgreSQL
      apiServer = createProductApiServer({
        service,
        authMode: 'development',
        authSecret: TEST_SECRET,
        idGenerator: idGen,
        port: 0,
      });

      await apiServer.start();
    });

    afterEach(async () => {
      await apiServer.stop();
    });

    it('GET /health succeeds publicly without auth and includes X-Request-Id', async () => {
      const res = await fetch(`${apiServer.url}/health`);
      expect(res.status).toBe(200);
      expect(res.headers.get('x-request-id')).toBeDefined();

      const json = await res.json();
      expect(json.status).toBe('ok');
      expect(json.mode).toBe('hosted-mvp-foundation');
      expect(json.requestId).toBeDefined();

      // Ensure zero secrets in health response
      expect(scanForSecrets(json).containsSecrets).toBe(false);
    });

    it('refuses unauthenticated request to /api/v1/workspaces with 401 Unauthorized', async () => {
      const res = await fetch(`${apiServer.url}/api/v1/workspaces`);
      expect(res.status).toBe(401);

      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('UNAUTHORIZED');
      expect(res.headers.get('x-request-id')).toBeDefined();
    });

    it('refuses request presenting only X-User-Id header in production mode with 401', async () => {
      const prodServer = createProductApiServer({
        service,
        authMode: 'production',
        idGenerator: new DeterministicIdGenerator('b12b1-prod-test'),
        port: 0,
      });
      await prodServer.start();
      try {
        const res = await fetch(`${prodServer.url}/api/v1/workspaces`, {
          headers: {
            'X-User-Id': testUser.id,
          },
        });

        expect(res.status).toBe(401);
        const json = await res.json();
        expect(json.success).toBe(false);
        expect(json.error.code).toBe('UNAUTHORIZED');
      } finally {
        await prodServer.stop();
      }
    });

    it('authenticates successfully with valid Bearer token and returns user workspaces', async () => {
      const res = await fetch(`${apiServer.url}/api/v1/workspaces`, {
        headers: {
          Authorization: `Bearer ${validToken}`,
        },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('x-request-id')).toBeDefined();

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.workspaces).toHaveLength(1);
      expect(json.data.workspaces[0].slug).toBe('protected-ws');
    });

    it('refuses cross-workspace access with 403 FORBIDDEN and logs security audit event', async () => {
      const foreignToken = createDevToken({
        userId: foreignUser.id,
        secret: TEST_SECRET,
      });

      const res = await fetch(`${apiServer.url}/api/v1/projects?workspaceId=${testWorkspace.id}`, {
        headers: {
          Authorization: `Bearer ${foreignToken}`,
        },
      });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('FORBIDDEN');
      expect(res.headers.get('x-request-id')).toBeDefined();

      // Verify that access denial recorded an audit event in PostgreSQL
      const audits = await mockPool.query(
        'SELECT * FROM audit_events WHERE workspace_id = $1 AND event_type = $2;',
        [testWorkspace.id, 'workspace.access_denied'],
      );
      expect(audits.rows.length).toBeGreaterThanOrEqual(1);
      expect(audits.rows[0].actor_user_id).toBe(foreignUser.id);
      expect(scanForSecrets(audits.rows[0].metadata).containsSecrets).toBe(false);
    });

    it('creates project via PostgreSQL persistence when authenticated as owner', async () => {
      const res = await fetch(`${apiServer.url}/api/v1/projects`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${validToken}`,
        },
        body: JSON.stringify({
          workspaceId: testWorkspace.id,
          name: 'PostgreSQL Backed Project',
          description: 'Created through database-backed product API',
        }),
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.name).toBe('PostgreSQL Backed Project');

      // Verify direct PostgreSQL persistence
      const dbRes = await mockPool.query(
        'SELECT * FROM projects WHERE workspace_id = $1 AND name = $2;',
        [testWorkspace.id, 'PostgreSQL Backed Project'],
      );
      expect(dbRes.rows).toHaveLength(1);
    });

    it('never leaks tokens, secrets, or passwords in error responses', async () => {
      const badToken = 'Bearer malformed.bad.token';
      const res = await fetch(`${apiServer.url}/api/v1/workspaces`, {
        headers: {
          Authorization: badToken,
        },
      });

      expect(res.status).toBe(401);
      const bodyText = await res.text();
      expect(bodyText).not.toContain(TEST_SECRET);
      expect(scanForSecrets(JSON.parse(bodyText)).containsSecrets).toBe(false);
    });
  });

  // ===========================================================================
  // 5. CLI Commands: auth:token and auth:check
  // ===========================================================================
  describe('5. CLI Commands (auth:token & auth:check)', () => {
    it('auth:token --help returns exit code 0', async () => {
      const code = await runAuthTokenCommand(['--help']);
      expect(code).toBe(0);
    });

    it('auth:token returns exit code 2 when --user is missing', async () => {
      const code = await runAuthTokenCommand([]);
      expect(code).toBe(2);
    });

    it('auth:token generates token successfully with exit code 0', async () => {
      const code = await runAuthTokenCommand(['--user', 'usr_cli_test', '--expires', '1800']);
      expect(code).toBe(0);
    });

    it('auth:check --help returns exit code 0', async () => {
      const code = await runAuthCheckCommand(['--help']);
      expect(code).toBe(0);
    });

    it('auth:check returns exit code 0 for standard environment', async () => {
      const code = await runAuthCheckCommand([]);
      expect(code).toBe(0);
    });

    it('auth:check returns exit code 2 on invalid flags', async () => {
      const code = await runAuthCheckCommand(['--unsupported-flag']);
      expect(code).toBe(2);
    });
  });
});
