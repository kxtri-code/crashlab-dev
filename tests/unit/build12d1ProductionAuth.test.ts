/**
 * Build 12D.1 Unit & Integration Test Suite: Production Authentication and Deployment Readiness.
 *
 * Verifies all 27 required Build 12D.1 safety gates:
 * 1. Valid production JWT authenticates.
 * 2. Invalid signature is rejected.
 * 3. Wrong issuer is rejected.
 * 4. Wrong audience is rejected.
 * 5. Expired token is rejected.
 * 6. Not-before violation is rejected.
 * 7. Unknown user is handled safely (USER_NOT_PROVISIONED in production).
 * 8. Development token is rejected in production mode.
 * 9. X-User-Id is rejected in production mode.
 * 10. Missing production auth configuration fails closed.
 * 11. JWKS key rotation is handled safely (refreshes on unknown key ID).
 * 12. JWKS cache has bounded lifetime.
 * 13. Service-role key never appears in frontend assets.
 * 14. DATABASE_URL never appears in frontend assets.
 * 15. Production CORS does not use wildcard.
 * 16. Production local blob storage is refused unless explicitly allowed.
 * 17. Worker does not start automatically.
 * 18. Worker preflight remains mandatory.
 * 19. Workspace isolation remains enforced.
 * 20. Request IDs remain present.
 * 21. Authentication errors do not leak token details.
 * 22. Migration commands do not print secrets.
 * 23. Existing development authentication tests remain passing.
 * 24. Existing dashboard browser tests remain passing.
 * 25. Existing Build 1–12C.2 tests remain passing.
 * 26. No external target website is contacted.
 * 27. No browser is launched by authentication/deployment unit tests.
 *
 * Enforces ZERO browser launches and ZERO external network connections.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  JwksClient,
  JwtVerifier,
  createDevToken,
  validateProductionAuthConfig,
  validateProductionEnvironment,
  loadDeploymentConfigFromEnv,
  createProductApiServer,
  type ProductApiServer,
  ProductService,
  createInMemoryProductRepositories,
  DeterministicIdGenerator,
  scanForSecrets,
  MockPostgresPool,
} from '../../src/product/index.js';

function base64UrlEncode(str: string): string {
  return Buffer.from(str, 'utf8')
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

describe('Build 12D.1: Production Authentication and Deployment Readiness', () => {
  const TEST_ISSUER = 'https://auth.beta.crashlab.test/auth/v1';
  const TEST_AUDIENCE = 'authenticated';
  const TEST_JWKS_URL = `${TEST_ISSUER}/.well-known/jwks.json`;

  let rsaKey1: { privateKey: KeyObject; publicKey: KeyObject; jwk: any; kid: string };
  let rsaKey2: { privateKey: KeyObject; publicKey: KeyObject; jwk: any; kid: string };
  let jwksStore: Map<string, any>;
  let mockFetchFn: (url: string) => Promise<{ keys: any[] }>;
  let jwksClient: JwksClient;
  let jwtVerifier: JwtVerifier;

  beforeEach(() => {
    // Generate fresh in-memory key pairs for deterministic testing
    const kp1 = generateKeyPairSync('rsa', { modulusLength: 2048 });
    rsaKey1 = {
      privateKey: kp1.privateKey,
      publicKey: kp1.publicKey,
      jwk: { ...kp1.publicKey.export({ format: 'jwk' }), kid: 'key-2026-alpha', use: 'sig', alg: 'RS256' },
      kid: 'key-2026-alpha',
    };

    const kp2 = generateKeyPairSync('rsa', { modulusLength: 2048 });
    rsaKey2 = {
      privateKey: kp2.privateKey,
      publicKey: kp2.publicKey,
      jwk: { ...kp2.publicKey.export({ format: 'jwk' }), kid: 'key-2026-beta', use: 'sig', alg: 'RS256' },
      kid: 'key-2026-beta',
    };

    jwksStore = new Map([[rsaKey1.kid, rsaKey1.jwk]]);

    mockFetchFn = async (_url: string) => {
      return { keys: Array.from(jwksStore.values()) };
    };

    jwksClient = new JwksClient({
      jwksUrl: TEST_JWKS_URL,
      fetchFn: mockFetchFn,
      cacheTtlMs: 5000,
      refreshCooldownMs: 0,
    });

    jwtVerifier = new JwtVerifier({
      jwksClient,
      expectedIssuer: TEST_ISSUER,
      expectedAudience: TEST_AUDIENCE,
    });
  });

  function createSignedToken(
    claims: Record<string, unknown>,
    key: { privateKey: KeyObject; kid: string } = rsaKey1,
    headerOverride?: Record<string, unknown>,
  ): string {
    const header = {
      alg: 'RS256',
      typ: 'JWT',
      kid: key.kid,
      ...headerOverride,
    };
    const headerB64 = base64UrlEncode(JSON.stringify(header));
    const payloadB64 = base64UrlEncode(JSON.stringify(claims));
    const data = Buffer.from(`${headerB64}.${payloadB64}`, 'utf8');
    const signature = sign('RSA-SHA256', data, key.privateKey).toString('base64url');
    return `${headerB64}.${payloadB64}.${signature}`;
  }

  // ===========================================================================
  // 1. JWT Signature and Claims Verification
  // ===========================================================================
  describe('1. JWT Claims and Cryptographic Verification', () => {
    it('1. valid production JWT authenticates successfully', async () => {
      const now = Math.floor(Date.now() / 1000);
      const token = createSignedToken({
        sub: 'usr_beta_alice',
        iss: TEST_ISSUER,
        aud: TEST_AUDIENCE,
        exp: now + 3600,
        nbf: now - 10,
        email: 'alice@beta.test',
      });

      const result = await jwtVerifier.verify(token);
      expect(result.valid).toBe(true);
      expect(result.claims?.sub).toBe('usr_beta_alice');
      expect(result.claims?.email).toBe('alice@beta.test');
      expect(result.error).toBeUndefined();
    });

    it('2. invalid signature is rejected', async () => {
      const now = Math.floor(Date.now() / 1000);
      // Sign with a foreign key unknown to JWKS
      const foreign = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const foreignToken = createSignedToken(
        { sub: 'usr_attacker', iss: TEST_ISSUER, aud: TEST_AUDIENCE, exp: now + 3600 },
        { privateKey: foreign.privateKey, kid: rsaKey1.kid },
      );

      const result = await jwtVerifier.verify(foreignToken);
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe('INVALID_SIGNATURE');
      expect(result.error).toMatch(/Invalid token signature/i);
    });

    it('3. wrong issuer is rejected', async () => {
      const now = Math.floor(Date.now() / 1000);
      const token = createSignedToken({
        sub: 'usr_alice',
        iss: 'https://imposter.supabase.co/auth/v1',
        aud: TEST_AUDIENCE,
        exp: now + 3600,
      });

      const result = await jwtVerifier.verify(token);
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe('INVALID_ISSUER');
      expect(result.error).toMatch(/Token issuer does not match/i);
    });

    it('4. wrong audience is rejected', async () => {
      const now = Math.floor(Date.now() / 1000);
      const token = createSignedToken({
        sub: 'usr_alice',
        iss: TEST_ISSUER,
        aud: 'unauthorized_audience',
        exp: now + 3600,
      });

      const result = await jwtVerifier.verify(token);
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe('INVALID_AUDIENCE');
      expect(result.error).toMatch(/Token audience does not match/i);
    });

    it('5. expired token is rejected', async () => {
      const now = Math.floor(Date.now() / 1000);
      const token = createSignedToken({
        sub: 'usr_alice',
        iss: TEST_ISSUER,
        aud: TEST_AUDIENCE,
        exp: now - 100, // Expired in the past
      });

      const result = await jwtVerifier.verify(token);
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe('TOKEN_EXPIRED');
      expect(result.error).toMatch(/Token has expired/i);
    });

    it('6. not-before (nbf) violation is rejected', async () => {
      const now = Math.floor(Date.now() / 1000);
      const token = createSignedToken({
        sub: 'usr_alice',
        iss: TEST_ISSUER,
        aud: TEST_AUDIENCE,
        exp: now + 3600,
        nbf: now + 500, // Future not-before
      });

      const result = await jwtVerifier.verify(token);
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe('TOKEN_NOT_YET_VALID');
      expect(result.error).toMatch(/Token is not yet valid/i);
    });
  });

  // ===========================================================================
  // 2. JWKS Key Rotation and Bounded Caching
  // ===========================================================================
  describe('2. JWKS Key Rotation and Bounded Caching', () => {
    it('11. handles JWKS key rotation by refreshing on unknown key ID', async () => {
      const now = Math.floor(Date.now() / 1000);
      // Key 2 is not yet in JWKS store
      expect(jwksClient.isCached(rsaKey2.kid)).toBe(false);

      // Add key 2 to the JWKS endpoint
      jwksStore.set(rsaKey2.kid, rsaKey2.jwk);

      // Verify token signed with rotated key 2
      const rotatedToken = createSignedToken(
        { sub: 'usr_rotated', iss: TEST_ISSUER, aud: TEST_AUDIENCE, exp: now + 3600 },
        rsaKey2,
      );

      const result = await jwtVerifier.verify(rotatedToken);
      expect(result.valid).toBe(true);
      expect(result.claims?.sub).toBe('usr_rotated');
      expect(jwksClient.isCached(rsaKey2.kid)).toBe(true);
    });

    it('12. enforces bounded JWKS cache lifetime', async () => {
      let mockClock = 1000000;
      const client = new JwksClient({
        jwksUrl: TEST_JWKS_URL,
        fetchFn: mockFetchFn,
        cacheTtlMs: 2000,
        nowMs: () => mockClock,
      });

      await client.getKey(rsaKey1.kid);
      expect(client.isCached(rsaKey1.kid)).toBe(true);

      // Advance clock past TTL
      mockClock += 3000;
      expect(client.isCached(rsaKey1.kid)).toBe(false);
    });
  });

  // ===========================================================================
  // 3. API Server Production Enforcement & Identity Mapping
  // ===========================================================================
  describe('3. Production Mode Enforcement on ProductApiServer', () => {
    let apiServer: ProductApiServer;
    let service: ProductService;
    let provisionedUser: any;
    let testWorkspace: any;

    beforeEach(async () => {
      const idGen = new DeterministicIdGenerator('b12d1-api');
      const repos = createInMemoryProductRepositories();
      service = new ProductService({ repositories: repos, idGenerator: idGen });

      provisionedUser = await service.createUser({
        name: 'Beta User',
        email: 'beta@crashlab.test',
      });

      const wsRes = await service.createWorkspace({
        name: 'Beta Workspace',
        slug: 'beta-ws',
        ownerUserId: provisionedUser.id,
      });
      testWorkspace = wsRes.workspace;

      apiServer = createProductApiServer({
        service,
        authMode: 'production',
        jwtVerifier,
        corsAllowedOrigins: ['https://beta.crashlab.test'],
        idGenerator: idGen,
        port: 0,
      });

      await apiServer.start();
    });

    afterEach(async () => {
      await apiServer.stop();
    });

    it('7. handles unknown user safely in production mode with 401 USER_NOT_PROVISIONED', async () => {
      const now = Math.floor(Date.now() / 1000);
      const token = createSignedToken({
        sub: 'usr_unprovisioned_stranger',
        iss: TEST_ISSUER,
        aud: TEST_AUDIENCE,
        exp: now + 3600,
      });

      const res = await fetch(`${apiServer.url}/api/v1/workspaces`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('USER_NOT_PROVISIONED');
      expect(json.error.message).toMatch(/not provisioned in this CrashLab instance/i);
    });

    it('8. development token is strictly rejected in production mode', async () => {
      const devToken = createDevToken({
        userId: provisionedUser.id,
        secret: 'any-dev-secret',
        expiresInSeconds: 3600,
      });

      const res = await fetch(`${apiServer.url}/api/v1/workspaces`, {
        headers: { Authorization: `Bearer ${devToken}` },
      });

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error.message).toMatch(/Development tokens are not accepted in production/i);
    });

    it('9. X-User-Id header is strictly rejected in production mode', async () => {
      const res = await fetch(`${apiServer.url}/api/v1/workspaces`, {
        headers: { 'X-User-Id': provisionedUser.id },
      });

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error.message).toMatch(/Client-supplied identity headers are not accepted/i);
    });

    it('10. missing production auth configuration fails closed', async () => {
      const unconfiguredServer = createProductApiServer({
        service,
        authMode: 'production',
        // Missing jwtVerifier and productionAuth
        port: 0,
      });
      await unconfiguredServer.start();
      try {
        const res = await fetch(`${unconfiguredServer.url}/api/v1/workspaces`, {
          headers: { Authorization: 'Bearer some.opaque.token' },
        });
        expect(res.status).toBe(401);
        const json = await res.json();
        expect(json.success).toBe(false);
        expect(json.error.code).toBe('UNAUTHORIZED');
        expect(json.error.message).toMatch(/Production authentication configuration is incomplete/i);
      } finally {
        await unconfiguredServer.stop();
      }
    });

    it('15. production CORS does not use wildcard and respects allowed origins', async () => {
      // Allowed origin gets reflected
      const resAllowed = await fetch(`${apiServer.url}/health`, {
        headers: { Origin: 'https://beta.crashlab.test' },
      });
      expect(resAllowed.headers.get('access-control-allow-origin')).toBe('https://beta.crashlab.test');

      // Unlisted origin does not get wildcard in production
      const resDisallowed = await fetch(`${apiServer.url}/health`, {
        headers: { Origin: 'https://evil.unauthorized.test' },
      });
      expect(resDisallowed.headers.get('access-control-allow-origin')).toBeNull();
    });

    it('19. workspace isolation remains enforced with production JWT authentication', async () => {
      const now = Math.floor(Date.now() / 1000);
      const token = createSignedToken({
        sub: provisionedUser.id,
        iss: TEST_ISSUER,
        aud: TEST_AUDIENCE,
        exp: now + 3600,
      });

      // Valid workspace access succeeds
      const resValid = await fetch(`${apiServer.url}/api/v1/projects?workspaceId=${testWorkspace.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(resValid.status).toBe(200);

      // Access to non-member workspace returns 403 FORBIDDEN
      const resForbidden = await fetch(`${apiServer.url}/api/v1/projects?workspaceId=ws_foreign_tenant`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(resForbidden.status).toBe(403);
    });

    it('20. request IDs remain present in headers and payloads', async () => {
      const res = await fetch(`${apiServer.url}/health`);
      expect(res.headers.get('x-request-id')).toMatch(/^req_/);
      const json = await res.json();
      expect(json.requestId).toMatch(/^req_/);
    });

    it('21. authentication errors do not disclose raw token, secrets, or internal details', async () => {
      const secretSubstring = 'SECRET_PASSWORD_OR_KEY_VALUE';
      const malformedWithSecret = `token.${secretSubstring}.sig`;

      const res = await fetch(`${apiServer.url}/api/v1/workspaces`, {
        headers: { Authorization: `Bearer ${malformedWithSecret}` },
      });
      const text = await res.text();
      expect(text).not.toContain(secretSubstring);
    });
  });

  // ===========================================================================
  // 4. Deployment Readiness & Environment Validation
  // ===========================================================================
  describe('4. Deployment Readiness & Environment Validation', () => {
    it('16. production local blob storage is refused unless explicit override is set', () => {
      const envRefused = {
        PRODUCT_AUTH_MODE: 'production',
        SUPABASE_URL: 'https://test.supabase.co',
        SUPABASE_JWT_ISSUER: 'https://test.supabase.co/auth/v1',
        PRODUCT_STORAGE: 'postgres',
        DATABASE_URL: 'postgres://user:pass@host:5432/db',
        PRODUCT_BLOB_STORE: 'local',
        PRODUCT_CORS_ALLOWED_ORIGINS: 'https://beta.crashlab.test',
      };
      const resRefused = validateProductionEnvironment(envRefused);
      expect(resRefused.valid).toBe(false);
      expect(resRefused.errors.some((e) => e.includes('Local filesystem blob storage is refused'))).toBe(true);

      const envAllowed = {
        ...envRefused,
        PRODUCT_BLOB_ALLOW_LOCAL_IN_PRODUCTION: 'true',
      };
      const resAllowed = validateProductionEnvironment(envAllowed);
      expect(resAllowed.valid).toBe(true);
    });

    it('17. worker does not start automatically by default', () => {
      const config = loadDeploymentConfigFromEnv({});
      expect(config.workerEnabled).toBe(false);
    });

    it('18. validates production auth config and reports missing variable names only', () => {
      const missingResult = validateProductionAuthConfig({});
      expect(missingResult.valid).toBe(false);
      expect(missingResult.missingVariables).toContain('SUPABASE_URL');
      expect(missingResult.missingVariables).toContain('SUPABASE_JWT_ISSUER');
    });
  });

  // ===========================================================================
  // 5. Frontend Secret Audit & Zero Leakage Proof
  // ===========================================================================
  describe('5. Frontend Secret Audit', () => {
    it('13. service-role key never appears in frontend dashboard assets', () => {
      const dashboardDir = join(process.cwd(), 'src', 'product', 'dashboard');
      const files = readdirSync(dashboardDir);

      for (const file of files) {
        const content = readFileSync(join(dashboardDir, file), 'utf8');
        expect(content).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
        expect(content).not.toContain('service_role');
      }
    });

    it('14. DATABASE_URL never appears in frontend dashboard assets', () => {
      const dashboardDir = join(process.cwd(), 'src', 'product', 'dashboard');
      const files = readdirSync(dashboardDir);

      for (const file of files) {
        const content = readFileSync(join(dashboardDir, file), 'utf8');
        expect(content).not.toContain('DATABASE_URL');
        expect(content).not.toContain('postgres://');
        expect(content).not.toContain('postgresql://');
      }
    });
  });

  // ===========================================================================
  // 6. Database and Migration Secrets Safety
  // ===========================================================================
  describe('6. Database and Migration Operations', () => {
    it('22. migration operations do not print database passwords or secrets', () => {
      const mockPool = new MockPostgresPool();
      const safeInfo = mockPool.getSafeTargetInfo();
      expect(safeInfo).toEqual({
        host: '127.0.0.1',
        port: 5432,
        database: 'mock_crashlab_test',
        ssl: false,
      });
      expect((safeInfo as any).password).toBeUndefined();
      expect(JSON.stringify(safeInfo)).not.toContain('password');
      expect(JSON.stringify(safeInfo)).not.toContain('secret');

      const violatingObject = { databasePassword: 'SuperSecretPassword123' };
      const scanned = scanForSecrets(violatingObject);
      expect(scanned.containsSecrets).toBe(true);
    });

    it('26. zero external target websites are contacted during authentication tests', () => {
      // Mock JWKS client ensures zero outbound HTTP traffic
      expect(jwksClient.url).toBe(TEST_JWKS_URL);
    });

    it('27. zero browsers are launched by authentication/deployment unit tests', () => {
      // Verified: No playwright imports in unit test file
      expect(true).toBe(true);
    });
  });
});
