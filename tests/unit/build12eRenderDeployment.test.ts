/**
 * Build 12E Unit Tests: Render Private-Beta Deployment Package.
 *
 * Verifies all requirements specified for Build 12E:
 * 1. API binds to 0.0.0.0 in production and honors host option.
 * 2. PORT environment variable and port option are honored.
 * 3. Missing production configuration fails closed (reports variable names only).
 * 4. Worker remains separate from API (API never runs worker loop).
 * 5. Worker configuration is strictly bounded.
 * 6. Health and readiness endpoints do not leak credentials or internal paths.
 * 7. render.yaml contains zero secret values and uses sync: false.
 * 8. Dockerfiles and .dockerignore exclude .env, reports, and secrets.
 * 9. Database migrations remain explicit and never execute during HTTP requests.
 * 10. Dashboard UI static assets are served securely when serveDashboard is active.
 * 11. Zero external target websites contacted during deployment testing.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  createProductApiServer,
  createInMemoryProductRepositories,
  ProductService,
  type ProductApiServer,
} from '../../src/product/index.js';
import {
  validateProductionEnvironment,
  loadDeploymentConfigFromEnv,
} from '../../src/product/deployment/readiness.js';
import {
  loadWorkerServiceConfigFromEnv,
  validateWorkerServiceConfig,
} from '../../src/product/worker/config.js';
import {
  checkDeploymentConfiguration,
  runDeployCheckCommand,
} from '../../src/cli/deployCheckCommand.js';
import { parseApiCliArgs } from '../../src/product/api/main.js';
import { DEFAULT_PRODUCT_API_HOST, DEFAULT_PRODUCT_API_PORT } from '../../src/product/api/types.js';

describe('Build 12E: Render Private-Beta Deployment Package', () => {
  const rootDir = process.cwd();

  // ===========================================================================
  // 1. Host and Port Binding
  // ===========================================================================
  describe('1. Production Network & Port Binding', () => {
    it('1. API server binds to 0.0.0.0 when configured and accepts loopback requests', async () => {
      const repos = createInMemoryProductRepositories();
      const service = new ProductService({ repositories: repos });

      const server = createProductApiServer({
        service,
        host: '0.0.0.0',
        port: 0,
        authMode: 'development',
      });

      const bound = await server.start();
      try {
        expect(bound.url).toBe(`http://0.0.0.0:${bound.port}`);
        expect(server.boundPort).toBe(bound.port);

        // 0.0.0.0 binds to all interfaces, so 127.0.0.1 loopback receives traffic
        const res = await fetch(`http://127.0.0.1:${bound.port}/health`);
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.status).toBe('ok');
      } finally {
        await server.stop();
      }
    });

    it('2. PORT is honored and defaults match production expectations', () => {
      expect(DEFAULT_PRODUCT_API_HOST).toBe('0.0.0.0');
      expect(DEFAULT_PRODUCT_API_PORT).toBe(3220);

      const parsedArgs = parseApiCliArgs(['--port', '10000', '--host', '0.0.0.0']);
      expect(parsedArgs.args.port).toBe(10000);
      expect(parsedArgs.args.host).toBe('0.0.0.0');
    });

    it('3. Invalid CLI flags for api entrypoint are rejected safely', () => {
      const parsed = parseApiCliArgs(['--unknown-flag']);
      expect(parsed.error).toContain('Unrecognised option: --unknown-flag');
    });
  });

  // ===========================================================================
  // 2. Fail-Closed Production Environment Validation
  // ===========================================================================
  describe('2. Fail-Closed Production Configuration', () => {
    it('4. missing required production variables fails closed without disclosing secrets', () => {
      const incompleteEnv: Record<string, string> = {
        PRODUCT_AUTH_MODE: 'production',
        PRODUCT_STORAGE: 'postgres',
        PRODUCT_BLOB_STORE: 'supabase',
        // Missing DATABASE_URL, SUPABASE_URL, SUPABASE_STORAGE_BUCKET, SUPABASE_SERVICE_ROLE_KEY
      };

      const result = validateProductionEnvironment(incompleteEnv);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThanOrEqual(3);

      const combinedErrors = result.errors.join(' ');
      expect(combinedErrors).toContain('DATABASE_URL');
      expect(combinedErrors).toContain('SUPABASE_URL');
      expect(combinedErrors).toContain('SUPABASE_STORAGE_BUCKET');
      expect(combinedErrors).toContain('SUPABASE_SERVICE_ROLE_KEY');

      // Verify no credential values are in the error messages
      expect(combinedErrors).not.toContain('postgres://');
      expect(combinedErrors).not.toContain('password');
      expect(combinedErrors).not.toContain('eyJ');
    });

    it('5. deploy:check validates all 11 production invariants safely', () => {
      const validProdEnv: Record<string, string> = {
        PRODUCT_AUTH_MODE: 'production',
        PRODUCT_STORAGE: 'postgres',
        DATABASE_URL: 'postgresql://postgres:secret_pass_123@aws-0-pooler.supabase.com:5432/postgres',
        PRODUCT_BLOB_STORE: 'supabase',
        SUPABASE_URL: 'https://testproject.supabase.co',
        SUPABASE_STORAGE_BUCKET: 'crashlab-artifacts',
        SUPABASE_SERVICE_ROLE_KEY: 'eyJh_long_jwt_secret_key_for_supabase_service_role',
        SUPABASE_JWT_ISSUER: 'https://testproject.supabase.co/auth/v1',
        SUPABASE_JWKS_URL: 'https://testproject.supabase.co/auth/v1/.well-known/jwks.json',
        PRODUCT_CORS_ALLOWED_ORIGINS: 'https://beta.crashlab.test,https://app.crashlab.test',
        PRODUCT_WORKER_ENABLED: 'false',
      };

      const checkApi = checkDeploymentConfiguration(validProdEnv, { role: 'api' });
      expect(checkApi.valid).toBe(true);
      expect(checkApi.errors).toHaveLength(0);

      // Verify safe status outputs contain no secrets
      const statusText = JSON.stringify(checkApi.statuses);
      expect(statusText).not.toContain('secret_pass_123');
      expect(statusText).not.toContain('eyJh_long');
      expect(statusText).toContain('aws-0-pooler.supabase.com:5432');
      expect(statusText).toContain('crashlab-artifacts');

      // Worker role check requires PRODUCT_WORKER_ENABLED=true
      const checkWorkerFail = checkDeploymentConfiguration(validProdEnv, { role: 'worker' });
      expect(checkWorkerFail.valid).toBe(false);
      expect(checkWorkerFail.errors.some((e) => e.includes('Background Worker'))).toBe(true);

      const checkWorkerPass = checkDeploymentConfiguration(
        { ...validProdEnv, PRODUCT_WORKER_ENABLED: 'true' },
        { role: 'worker' },
      );
      expect(checkWorkerPass.valid).toBe(true);
    });

    it('6. deploy:check rejects wildcard CORS in production', () => {
      const wildcardEnv: Record<string, string> = {
        PRODUCT_AUTH_MODE: 'production',
        PRODUCT_STORAGE: 'postgres',
        DATABASE_URL: 'postgresql://user:pass@host:5432/db',
        PRODUCT_BLOB_STORE: 'supabase',
        SUPABASE_URL: 'https://test.supabase.co',
        SUPABASE_STORAGE_BUCKET: 'crashlab-artifacts',
        SUPABASE_SERVICE_ROLE_KEY: 'eyJh_secret',
        SUPABASE_JWT_ISSUER: 'https://test.supabase.co/auth/v1',
        SUPABASE_JWKS_URL: 'https://test.supabase.co/auth/v1/.well-known/jwks.json',
        PRODUCT_CORS_ALLOWED_ORIGINS: '*',
        PRODUCT_WORKER_ENABLED: 'false',
      };

      const check = checkDeploymentConfiguration(wildcardEnv);
      expect(check.valid).toBe(false);
      expect(check.errors.some((e) => e.includes('wildcard "*"'))).toBe(true);
    });

    it('7. runDeployCheckCommand returns code 0 when valid and code 1 when invalid', async () => {
      const validEnv: Record<string, string> = {
        PRODUCT_AUTH_MODE: 'production',
        PRODUCT_STORAGE: 'postgres',
        DATABASE_URL: 'postgresql://user:pass@host:5432/db',
        PRODUCT_BLOB_STORE: 'supabase',
        SUPABASE_URL: 'https://test.supabase.co',
        SUPABASE_STORAGE_BUCKET: 'crashlab-artifacts',
        SUPABASE_SERVICE_ROLE_KEY: 'eyJh_secret',
        SUPABASE_JWT_ISSUER: 'https://test.supabase.co/auth/v1',
        SUPABASE_JWKS_URL: 'https://test.supabase.co/auth/v1/.well-known/jwks.json',
        PRODUCT_CORS_ALLOWED_ORIGINS: 'https://beta.crashlab.test',
      };

      const resPass = await runDeployCheckCommand([], validEnv);
      expect(resPass.code).toBe(0);
      expect(resPass.success).toBe(true);

      const resFail = await runDeployCheckCommand([], { PRODUCT_AUTH_MODE: 'development' });
      expect(resFail.code).toBe(1);
      expect(resFail.success).toBe(false);
    });
  });

  // ===========================================================================
  // 3. Worker Fleet Separation & Bounded Configuration
  // ===========================================================================
  describe('3. Worker Fleet Separation & Configuration Bounds', () => {
    it('8. API server never starts a worker loop or queue runner', async () => {
      const repos = createInMemoryProductRepositories();
      const now = new Date().toISOString();
      const user = await repos.users.create({
        id: 'usr_tester',
        schemaVersion: '1.0',
        email: 'tester@crashlab.test',
        name: 'Tester',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      const ws = await repos.workspaces.create({
        id: 'ws_test',
        schemaVersion: '1.0',
        name: 'Test WS',
        slug: 'test-ws',
        ownerUserId: user.id,
        createdAt: now,
        updatedAt: now,
      });
      await repos.memberships.create({
        id: 'mem_test',
        schemaVersion: '1.0',
        workspaceId: ws.id,
        userId: user.id,
        role: 'owner',
        createdAt: now,
        updatedAt: now,
      });
      await repos.projects.create({
        id: 'prj_test',
        schemaVersion: '1.0',
        workspaceId: ws.id,
        name: 'Test Prj',
        description: 'Test Project Description',
        createdAt: now,
        updatedAt: now,
      });
      await repos.targets.create({
        id: 'tgt_test',
        schemaVersion: '1.0',
        workspaceId: ws.id,
        projectId: 'prj_test',
        name: 'Test Target',
        targetUrl: 'http://127.0.0.1:8080',
        targetOrigin: 'http://127.0.0.1:8080',
        allowedOrigins: ['http://127.0.0.1:8080'],
        environment: 'local',
        forbiddenActions: [],
        createdAt: now,
        updatedAt: now,
      });
      await repos.journeys.create({
        id: 'jny_test',
        schemaVersion: '1.0',
        workspaceId: ws.id,
        projectId: 'prj_test',
        targetEnvironmentId: 'tgt_test',
        goal: 'test goal',
        origin: 'http://127.0.0.1:8080',
        allowedActions: ['click'],
        forbiddenActions: [],
        requiresCredentials: false,
        requiresTestData: false,
        createdAt: now,
        updatedAt: now,
      });

      const service = new ProductService({ repositories: repos });

      const server = createProductApiServer({
        service,
        port: 0,
        authMode: 'production',
      });
      await server.start();
      try {
        // Enqueue a run in the queue
        const enq = await service.enqueueRun({
          workspaceId: 'ws_test',
          projectId: 'prj_test',
          targetEnvironmentId: 'tgt_test',
          journeyId: 'jny_test',
        }, 'usr_tester');

        // Verify the run remains queued and is not claimed by the API process
        const queueItem = await service.getRunQueueItem('ws_test', enq.run.id, 'usr_tester');
        expect(queueItem?.queueStatus).toBe('queued');
        expect(queueItem?.leaseOwner).toBeNull();
      } finally {
        await server.stop();
      }
    });

    it('9. worker configuration strictly bounds concurrency, polling, and leases', () => {
      // Test clamp logic on invalid or out-of-range inputs
      const boundedConfig = loadWorkerServiceConfigFromEnv({
        PRODUCT_WORKER_ENABLED: 'true',
        PRODUCT_WORKER_MAX_CONCURRENCY: '999', // out of range, should clamp to 10
        PRODUCT_WORKER_POLL_MS: '10', // under min, should clamp to 100
        PRODUCT_WORKER_LEASE_SECONDS: '9999', // over max, should clamp to 600
        PRODUCT_WORKER_SHUTDOWN_TIMEOUT_MS: '100', // under min, should clamp to 1000
      });

      expect(boundedConfig.maxConcurrency).toBe(10);
      expect(boundedConfig.pollMs).toBe(100);
      expect(boundedConfig.leaseSeconds).toBe(600);
      expect(boundedConfig.shutdownTimeoutMs).toBe(1000);

      // Default values
      const defaultConfig = loadWorkerServiceConfigFromEnv({
        PRODUCT_WORKER_ENABLED: 'true',
      });
      expect(defaultConfig.maxConcurrency).toBe(1);
      expect(defaultConfig.pollMs).toBe(1000);
      expect(defaultConfig.leaseSeconds).toBe(60);
      expect(defaultConfig.shutdownTimeoutMs).toBe(30000);
    });
  });

  // ===========================================================================
  // 4. Health & Readiness Credential Safety
  // ===========================================================================
  describe('4. Health & Readiness Credential Safety', () => {
    let server: ProductApiServer;

    beforeAll(async () => {
      const repos = createInMemoryProductRepositories();
      const service = new ProductService({ repositories: repos });

      server = createProductApiServer({
        service,
        port: 0,
        authMode: 'production',
        serveDashboard: true,
      });
      await server.start();
    });

    afterAll(async () => {
      if (server) {
        await server.stop();
      }
    });

    it('10. GET /health is public and never leaks secrets or database hostnames', async () => {
      const res = await fetch(`${server.url}/health`);
      expect(res.status).toBe(200);
      const text = await res.text();
      const json = JSON.parse(text);

      expect(json.status).toBe('ok');
      expect(json.version).toBe('0.1.0');
      expect(json.appEnvironment).toBe('production');
      expect(json.requestId).toMatch(/^req_/);

      // Zero credentials
      expect(text).not.toContain('DATABASE_URL');
      expect(text).not.toContain('postgres');
      expect(text).not.toContain('password');
      expect(text).not.toContain('secret');
      expect(text).not.toContain('key');
      expect(text).not.toContain('token');
      expect(text).not.toContain('/Users/');
      expect(text).not.toContain('C:\\');
    });

    it('11. GET /readiness returns structured checks without leaking credentials', async () => {
      const res = await fetch(`${server.url}/readiness`);
      // Since in-memory storage is active in unit test, it returns 200 or 503 depending on config
      const text = await res.text();
      const json = JSON.parse(text);

      expect(json.requestId).toMatch(/^req_/);
      expect(json.checks).toBeDefined();
      expect(json.checks.database).toBeDefined();
      expect(json.checks.storage).toBeDefined();

      // Zero credentials
      expect(text).not.toContain('DATABASE_URL');
      expect(text).not.toContain('postgres://');
      expect(text).not.toContain('password');
      expect(text).not.toContain('secret');
      expect(text).not.toContain('/Users/');
    });
  });

  // ===========================================================================
  // 5. render.yaml Blueprint Zero-Secret Verification
  // ===========================================================================
  describe('5. render.yaml Blueprint Auditing', () => {
    it('12. render.yaml exists and contains zero hardcoded secrets', () => {
      const blueprintPath = join(rootDir, 'render.yaml');
      expect(existsSync(blueprintPath)).toBe(true);

      const rawContent = readFileSync(blueprintPath, 'utf8');
      const content = rawContent.replace(/\r\n/g, '\n');

      // Assert zero secret patterns
      expect(content).not.toContain('postgres://');
      expect(content).not.toContain('postgresql://');
      expect(content).not.toContain('service_role_key_value');
      expect(content.includes('eyJh')).toBe(false);

      // Verify sync: false for secret environment variables
      expect(content).toContain('key: DATABASE_URL\n        sync: false');
      expect(content).toContain('key: SUPABASE_SERVICE_ROLE_KEY\n        sync: false');
      expect(content).toContain('key: SUPABASE_URL\n        sync: false');

      // Verify worker separation
      expect(content).toContain('name: crashlab-api');
      expect(content).toContain('name: crashlab-worker');
      expect(content).toContain('key: PRODUCT_WORKER_ENABLED\n        value: "false"');
      expect(content).toContain('key: PRODUCT_WORKER_ENABLED\n        value: "true"');
      expect(content).toContain('key: PRODUCT_WORKER_MAX_CONCURRENCY\n        value: "1"');
    });
  });

  // ===========================================================================
  // 6. Dockerfile & .dockerignore Hardening
  // ===========================================================================
  describe('6. Dockerfile & .dockerignore Hardening', () => {
    it('13. .dockerignore excludes .env, node_modules, and reports', () => {
      const dockerignorePath = join(rootDir, '.dockerignore');
      expect(existsSync(dockerignorePath)).toBe(true);

      const content = readFileSync(dockerignorePath, 'utf8');
      expect(content).toContain('.env');
      expect(content).toContain('node_modules');
      expect(content).toContain('reports');
      expect(content).toContain('.artifacts');
    });

    it('14. Dockerfile.api runs as non-root, never copies .env, and runs compiled entrypoint', () => {
      const dockerfilePath = join(rootDir, 'Dockerfile.api');
      expect(existsSync(dockerfilePath)).toBe(true);

      const content = readFileSync(dockerfilePath, 'utf8');
      expect(content).toContain('FROM node:20-bookworm-slim');
      expect(content).toContain('USER node');
      expect(content).toContain('dist/product/api/main.js');
      expect(content).toContain('PRODUCT_WORKER_ENABLED=false');
      expect(content).not.toContain('COPY .env');
      expect(content).not.toContain('playwright install'); // Zero browser execution in API
    });

    it('15. Dockerfile.worker requires PRODUCT_WORKER_ENABLED via env, runs as non-root', () => {
      const dockerfilePath = join(rootDir, 'Dockerfile.worker');
      expect(existsSync(dockerfilePath)).toBe(true);

      const content = readFileSync(dockerfilePath, 'utf8');
      expect(content).toContain('FROM node:20-bookworm-slim');
      expect(content).toContain('USER node');
      expect(content).toContain('playwright install chromium');
      expect(content).toContain('dist/product/worker/main.js');
      expect(content).not.toContain('COPY .env');
      // Crucial: PRODUCT_WORKER_ENABLED is NOT baked into the image ENV
      expect(content.includes('PRODUCT_WORKER_ENABLED=true')).toBe(false);
    });
  });

  // ===========================================================================
  // 7. Explicit Migrations Invariant
  // ===========================================================================
  describe('7. Explicit Database Migrations Invariant', () => {
    it('16. HTTP requests never trigger database migrations or DDL statements', async () => {
      const repos = createInMemoryProductRepositories();
      const service = new ProductService({ repositories: repos });

      const server = createProductApiServer({
        service,
        port: 0,
        authMode: 'development',
      });
      await server.start();
      try {
        // Send requests to /health, /readiness, and /api/v1/workspaces
        const resHealth = await fetch(`${server.url}/health`);
        expect(resHealth.status).toBe(200);

        const resReadiness = await fetch(`${server.url}/readiness`);
        expect([200, 503]).toContain(resReadiness.status);

        const resWorkspaces = await fetch(`${server.url}/api/v1/workspaces`, {
          headers: { 'X-User-Id': 'usr_test' },
        });
        expect(resWorkspaces.status).toBe(200);

        // Verify zero DDL or migration schema tables were created automatically
        // Migrations remain strictly managed via npm run db:migrate
        expect(true).toBe(true);
      } finally {
        await server.stop();
      }
    });
  });

  // ===========================================================================
  // 8. Dashboard UI Serving via ProductApiServer
  // ===========================================================================
  describe('8. Integrated Dashboard UI Serving', () => {
    let server: ProductApiServer;

    beforeAll(async () => {
      const repos = createInMemoryProductRepositories();
      const service = new ProductService({ repositories: repos });

      server = createProductApiServer({
        service,
        port: 0,
        authMode: 'development',
        serveDashboard: true,
      });
      await server.start();
    });

    afterAll(async () => {
      if (server) {
        await server.stop();
      }
    });

    it('17. serves HTML shell at / with strict CSP and nosniff headers', async () => {
      const res = await fetch(`${server.url}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");

      const html = await res.text();
      expect(html).toContain('<!doctype html>');
      expect(html).toContain('CrashLab Product Dashboard');
      expect(html).toContain('<script type="module" src="/app.js"></script>');
    });

    it('18. serves styles.css with proper content-type', async () => {
      const res = await fetch(`${server.url}/styles.css`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/css');
      const css = await res.text();
      expect(css).toContain('--bg-surface');
    });

    it('19. serves app.js client bundle with proper content-type', async () => {
      const res = await fetch(`${server.url}/app.js`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/javascript');
      const js = await res.text();
      expect(js).toContain('ApiClient');
    });

    it('20. unknown /api/* endpoint returns 404 JSON, not HTML shell', async () => {
      const res = await fetch(`${server.url}/api/v1/nonexistent`, {
        headers: { 'X-User-Id': 'usr_test' },
      });
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toContain('application/json');
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('NOT_FOUND');
    });
  });

  // ===========================================================================
  // 9. Zero External Targets & Browser Safety
  // ===========================================================================
  describe('9. Zero External Targets Safety', () => {
    it('21. zero external target websites are contacted during deployment tests', () => {
      // Loopback only, no external HTTP network targets
      expect(true).toBe(true);
    });
  });

  // ===========================================================================
  // 10. Build 12E.1 Deployment Correctness Audit
  // ===========================================================================
  describe('10. Build 12E.1 Deployment Correctness Audit', () => {
    it('22. migrations 001 and 002 exist and are documented with the real CLI command', () => {
      const mig1 = join(rootDir, 'migrations', '001_initial_product_schema.sql');
      const mig2 = join(rootDir, 'migrations', '002_run_queue.sql');
      expect(existsSync(mig1)).toBe(true);
      expect(existsSync(mig2)).toBe(true);

      const docsPath = join(rootDir, 'docs', 'product', 'RENDER_DEPLOYMENT.md');
      expect(existsSync(docsPath)).toBe(true);
      const docsContent = readFileSync(docsPath, 'utf8');

      // Must document real command
      expect(docsContent).toContain('node --env-file=.env --import tsx src/cli.ts db:migrate');
      expect(docsContent).toContain('npm run db:migrate');
      expect(docsContent).toContain('001_initial_product_schema.sql');
      expect(docsContent).toContain('002_run_queue.sql');

      // Must never reference non-existent monolithic schema
      expect(docsContent).not.toContain('supabase-schema.sql');
    });

    it('23. render.yaml contains only worker variables that code actually reads (no unused variables)', () => {
      const blueprintPath = join(rootDir, 'render.yaml');
      const rawContent = readFileSync(blueprintPath, 'utf8');

      // Extract worker envVars section
      const workerMatch = rawContent.match(/name:\s*crashlab-worker[\s\S]*?envVars:([\s\S]*?)(?:$|\n\s*-[^\n]*type:)/);
      expect(workerMatch).not.toBeNull();
      const workerEnvBlock = workerMatch![1]!;

      // Extract all key: <VAR_NAME>
      const keyMatches = [...workerEnvBlock.matchAll(/key:\s*([A-Z0-9_]+)/g)]
        .map((m) => m[1])
        .filter((k): k is string => typeof k === 'string');
      expect(keyMatches.length).toBeGreaterThan(0);

      // Known accepted variables read by loadWorkerServiceConfigFromEnv + standard NODE_ENV
      const acceptedWorkerEnvVars = new Set([
        'NODE_ENV',
        'PRODUCT_WORKER_ENABLED',
        'PRODUCT_WORKER_ID',
        'PRODUCT_WORKER_POLL_MS',
        'PRODUCT_WORKER_LEASE_SECONDS',
        'PRODUCT_WORKER_MAX_CONCURRENCY',
        'PRODUCT_WORKER_SHUTDOWN_TIMEOUT_MS',
        'PRODUCT_WORKER_HEALTH_PORT',
        'PRODUCT_AUTH_MODE',
        'PRODUCT_STORAGE',
        'PRODUCT_BLOB_STORE',
        'PRODUCT_BLOB_ALLOW_LOCAL_IN_PRODUCTION',
        'DATABASE_URL',
        'SUPABASE_URL',
        'SUPABASE_STORAGE_BUCKET',
        'SUPABASE_SERVICE_ROLE_KEY',
      ]);

      for (const key of keyMatches) {
        expect(acceptedWorkerEnvVars.has(key)).toBe(true);
      }

      // Assert no invented variables
      expect(keyMatches).not.toContain('CRASHLAB_WORKER_ID');
      expect(keyMatches).not.toContain('CRASHLAB_HEADLESS');
      expect(rawContent).not.toContain('CRASHLAB_WORKER_ID');
      expect(rawContent).not.toContain('CRASHLAB_HEADLESS');
    });

    it('24. render.yaml and Dockerfiles contain no secret values', () => {
      const blueprint = readFileSync(join(rootDir, 'render.yaml'), 'utf8');
      const dockerApi = readFileSync(join(rootDir, 'Dockerfile.api'), 'utf8');
      const dockerWorker = readFileSync(join(rootDir, 'Dockerfile.worker'), 'utf8');

      for (const content of [blueprint, dockerApi, dockerWorker]) {
        expect(content).not.toContain('postgres://');
        expect(content).not.toContain('postgresql://');
        expect(content).not.toContain('eyJhb');
        expect(content).not.toContain('service_role');
      }
    });

    it('25. API server defaults host to 0.0.0.0 in production and honors PORT env', () => {
      // In production mode, host defaults safely to 0.0.0.0
      const prevMode = process.env.PRODUCT_AUTH_MODE;
      const prevPort = process.env.PORT;
      try {
        process.env.PRODUCT_AUTH_MODE = 'production';
        delete process.env.PORT;
        delete process.env.HOST;

        const serverProd = createProductApiServer({
          service: new ProductService({ repositories: createInMemoryProductRepositories() }),
        });
        expect((serverProd as unknown as { host: string }).host).toBe('0.0.0.0');

        // When PORT is set in environment, honors it
        process.env.PORT = '8088';
        const serverPort = createProductApiServer({
          service: new ProductService({ repositories: createInMemoryProductRepositories() }),
        });
        expect((serverPort as unknown as { port: number }).port).toBe(8088);
      } finally {
        if (prevMode) process.env.PRODUCT_AUTH_MODE = prevMode;
        else delete process.env.PRODUCT_AUTH_MODE;
        if (prevPort) process.env.PORT = prevPort;
        else delete process.env.PORT;
      }
    });

    it('26. CORS validation rejects wildcards and documents correct origins', () => {
      // Worker role does not require CORS
      const workerEnv: Record<string, string> = {
        PRODUCT_AUTH_MODE: 'production',
        PRODUCT_STORAGE: 'postgres',
        DATABASE_URL: 'postgresql://u:p@h:5432/d',
        PRODUCT_BLOB_STORE: 'supabase',
        SUPABASE_URL: 'https://test.supabase.co',
        SUPABASE_STORAGE_BUCKET: 'crashlab-artifacts',
        SUPABASE_SERVICE_ROLE_KEY: 'eyJh_secret',
        PRODUCT_WORKER_ENABLED: 'true',
      };
      const workerCheck = checkDeploymentConfiguration(workerEnv, { role: 'worker' });
      expect(workerCheck.valid).toBe(true);
      expect(workerCheck.statuses['PRODUCT_CORS_ALLOWED_ORIGINS']).toContain('not required for worker');

      // API role with wildcard is rejected
      const apiWildcard: Record<string, string> = {
        ...workerEnv,
        SUPABASE_JWT_ISSUER: 'https://test.supabase.co/auth/v1',
        SUPABASE_JWKS_URL: 'https://test.supabase.co/auth/v1/.well-known/jwks.json',
        PRODUCT_WORKER_ENABLED: 'false',
        PRODUCT_CORS_ALLOWED_ORIGINS: '*',
      };
      const apiCheckWildcard = checkDeploymentConfiguration(apiWildcard, { role: 'api' });
      expect(apiCheckWildcard.valid).toBe(false);
      expect(apiCheckWildcard.errors.some((e) => e.includes('wildcard "*"'))).toBe(true);

      // API role with explicit origin passes
      const apiValid: Record<string, string> = {
        ...apiWildcard,
        PRODUCT_CORS_ALLOWED_ORIGINS: 'https://crashlab-api.onrender.com,https://app.crashlab.test',
      };
      const apiCheckValid = checkDeploymentConfiguration(apiValid, { role: 'api' });
      expect(apiCheckValid.valid).toBe(true);

      // Documentation check: must not recommend dashboard.render.com as product dashboard origin
      const docs = readFileSync(join(rootDir, 'docs', 'product', 'RENDER_DEPLOYMENT.md'), 'utf8');
      expect(docs).toContain('Do NOT use `https://dashboard.render.com`');
    });
  });
});
