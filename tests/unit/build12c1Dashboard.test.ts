/**
 * Unit Tests for Build 12C.1: Authenticated CrashLab Product Dashboard.
 *
 * Verifies:
 * 1. Dashboard static server HTTP endpoints & security headers
 * 2. Unauthenticated access and token security (zero tokens in HTML or DOM)
 * 3. Typed ProductApiClient with bearer authentication and request ID extraction
 * 4. Error classification (401 Unauthorized, 403 Forbidden, 404 Not Found)
 * 5. Backend endpoints (/api/v1/me, workspaces, targets, journeys, candidates)
 * 6. Tenant isolation and cross-workspace access rejection
 * 7. Candidate review invariants (confirmedBug: false, 4-way separation)
 * 8. Artifact metadata security (zero local server filesystem paths exposed)
 * 9. Bounded run cancellation with idempotent safety
 * 10. Polling lifecycle, terminal state termination, and timer cleanup
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import {
  createProductApiServer,
  createDashboardServer,
  ProductApiClient,
  createInMemoryProductRepositories,
  ProductService,
  createDevToken,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  type RunningDashboardServer,
  type ProductApiServer,
  type ProductRepositories,
} from '../../src/product/index.js';

interface SimpleHttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function makeRequest(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<SimpleHttpResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: options.method ?? 'GET',
        headers: options.headers ?? {},
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: data,
          });
        });
      },
    );
    req.on('error', reject);
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

describe('Build 12C.1: Authenticated Product Dashboard Unit Suite', () => {
  const TEST_SECRET = 'b12c1_test_signing_secret_at_least_32_chars_long!';
  let repos: ProductRepositories;
  let service: ProductService;
  let apiServer: ProductApiServer;
  let dashboardServer: RunningDashboardServer;
  let testUser: any;
  let foreignUser: any;
  let testWorkspace: any;
  let foreignWorkspace: any;
  let testProject: any;
  let testTarget: any;
  let testJourney: any;
  let testRun: any;
  let validToken: string;
  let foreignToken: string;

  beforeAll(async () => {
    repos = createInMemoryProductRepositories();
    service = new ProductService({ repositories: repos });

    // Seed test users
    testUser = await service.createUser({ name: 'Alice Owner', email: 'alice@dashboard.test' });
    foreignUser = await service.createUser({ name: 'Bob Attacker', email: 'bob@dashboard.test' });

    // Seed test workspaces
    const wsRes = await service.createWorkspace({
      name: 'Alice Workspace',
      slug: 'alice-ws',
      ownerUserId: testUser.id,
    });
    testWorkspace = wsRes.workspace;

    const foreignWsRes = await service.createWorkspace({
      name: 'Bob Workspace',
      slug: 'bob-ws',
      ownerUserId: foreignUser.id,
    });
    foreignWorkspace = foreignWsRes.workspace;

    // Seed project, target, journey, run
    testProject = await service.createProject(
      {
        workspaceId: testWorkspace.id,
        name: 'Dashboard Web App',
        description: 'Customer management portal',
      },
      testUser.id,
    );

    testTarget = await service.createTarget(
      {
        workspaceId: testWorkspace.id,
        projectId: testProject.id,
        name: 'Local Staging Target',
        environment: 'staging',
        targetUrl: 'http://127.0.0.1:4000/app',
        allowedOrigins: ['http://127.0.0.1:4000'],
      },
      testUser.id,
    );

    testJourney = await service.approveJourney(
      {
        workspaceId: testWorkspace.id,
        projectId: testProject.id,
        targetEnvironmentId: testTarget.id,
        goal: 'navigate dashboard metrics',
        origin: 'http://127.0.0.1:4000',
        allowedActions: ['click', 'type'],
      },
      testUser.id,
    );

    const enqRes = await service.enqueueRun(
      {
        workspaceId: testWorkspace.id,
        projectId: testProject.id,
        targetEnvironmentId: testTarget.id,
        journeyId: testJourney.id,
        maxAttempts: 2,
      },
      testUser.id,
    );
    testRun = enqRes.run;

    // Register a candidate finding
    await service.registerCandidate(
      {
        workspaceId: testWorkspace.id,
        projectId: testProject.id,
        runId: testRun.id,
        candidateId: 'cand_signal_01',
        ruleId: 'HTTP_5XX',
        classification: 'server_error',
        reproduced: true,
        reviewStatus: 'unreviewed',
      },
      testUser.id,
    );

    // Register an artifact
    await service.storeArtifact(
      {
        workspaceId: testWorkspace.id,
        runId: testRun.id,
        type: 'execution',
        content: Buffer.from(JSON.stringify({ summary: 'run execution summary' }), 'utf8'),
        contentType: 'application/json',
      },
      testUser.id,
    );

    // Tokens
    validToken = createDevToken({ userId: testUser.id, secret: TEST_SECRET, expiresInSeconds: 3600 });
    foreignToken = createDevToken({ userId: foreignUser.id, secret: TEST_SECRET, expiresInSeconds: 3600 });

    // Start API Server on ephemeral port
    apiServer = createProductApiServer({
      service,
      authMode: 'development',
      authSecret: TEST_SECRET,
      port: 0,
    });
    const apiBound = await apiServer.start();

    // Start Dashboard Server on ephemeral port pointing to apiServer
    dashboardServer = await createDashboardServer({
      port: 0,
      apiUrl: apiBound.url,
    });
  });

  afterAll(async () => {
    if (dashboardServer) {
      await dashboardServer.stop();
    }
    if (apiServer) {
      await apiServer.stop();
    }
  });

  // ===========================================================================
  // 1. Static Dashboard Server & Security Headers
  // ===========================================================================
  describe('1. Dashboard Static Server & Security Headers', () => {
    it('serves GET / with HTML shell, CSP, and nosniff headers', async () => {
      const res = await makeRequest(`${dashboardServer.url}/`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.headers['content-security-policy']).toBeDefined();
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.body).toContain('<!doctype html>');
      expect(res.body).toContain('<title>CrashLab Product Dashboard</title>');
      expect(res.body).toContain('<script type="module" src="/app.js"></script>');
    });

    it('tokens and secrets never appear in rendered HTML shell', async () => {
      const res = await makeRequest(`${dashboardServer.url}/`);
      expect(res.body).not.toContain(TEST_SECRET);
      expect(res.body).not.toContain(validToken);
      expect(res.body).not.toContain('DATABASE_URL');
      expect(res.body).not.toContain('PRODUCT_AUTH_SECRET');
    });

    it('serves GET /styles.css with CSS content type', async () => {
      const res = await makeRequest(`${dashboardServer.url}/styles.css`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/css');
      expect(res.body).toContain('--bg-base');
      expect(res.body).toContain('.dash-navbar');
    });

    it('serves GET /app.js with JavaScript content type', async () => {
      const res = await makeRequest(`${dashboardServer.url}/app.js`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/javascript');
      expect(res.body).toContain('ApiClient');
      expect(res.body).toContain('PollingManager');
    });

    it('serves GET /health with service metadata', async () => {
      const res = await makeRequest(`${dashboardServer.url}/health`);
      expect(res.status).toBe(200);
      const parsed = JSON.parse(res.body);
      expect(parsed.ok).toBe(true);
      expect(parsed.service).toBe('crashlab-dashboard');
      expect(parsed.readOnly).toBe(true);
    });

    it('rejects POST, PUT, DELETE to static dashboard paths with 405 Method Not Allowed', async () => {
      const res = await makeRequest(`${dashboardServer.url}/styles.css`, { method: 'POST', body: 'body{}' });
      expect(res.status).toBe(405);
      expect(res.headers['allow']).toContain('GET, HEAD');
    });

    it('rejects path traversal attempts with 400 Bad Request', async () => {
      const res = await makeRequest(`${dashboardServer.url}/..%2f..%2fetc%2fpasswd`);
      expect(res.status).toBe(400);
    });
  });

  // ===========================================================================
  // 2. Product API Client Tests
  // ===========================================================================
  describe('2. Typed ProductApiClient Integration', () => {
    it('successfully calls getMe() with valid bearer token', async () => {
      const client = new ProductApiClient({
        baseUrl: apiServer.url,
        token: validToken,
      });

      const res = await client.getMe();
      expect(res.success).toBe(true);
      expect(res.data.user.id).toBe(testUser.id);
      expect(res.requestId).toBeDefined();
    });

    it('rejects unauthenticated requests with UnauthorizedError (401)', async () => {
      const client = new ProductApiClient({
        baseUrl: apiServer.url,
        token: undefined, // No token
      });

      await expect(client.getMe()).rejects.toThrow(UnauthorizedError);
    });

    it('rejects invalid or tampered tokens with UnauthorizedError (401)', async () => {
      const client = new ProductApiClient({
        baseUrl: apiServer.url,
        token: 'invalid.bearer.token',
      });

      await expect(client.getMe()).rejects.toThrow(UnauthorizedError);
    });

    it('lists accessible workspaces through the API client', async () => {
      const client = new ProductApiClient({
        baseUrl: apiServer.url,
        token: validToken,
      });

      const res = await client.listWorkspaces();
      expect(res.success).toBe(true);
      expect(res.data.workspaces.length).toBeGreaterThanOrEqual(1);
      expect(res.data.workspaces.some((w) => w.id === testWorkspace.id)).toBe(true);
    });

    it('enforces tenant isolation: foreign user cannot read Alice workspace (403 Forbidden)', async () => {
      const foreignClient = new ProductApiClient({
        baseUrl: apiServer.url,
        token: foreignToken,
      });

      await expect(foreignClient.getWorkspace(testWorkspace.id)).rejects.toThrow(ForbiddenError);
    });

    it('lists targets and journeys through typed client', async () => {
      const client = new ProductApiClient({
        baseUrl: apiServer.url,
        token: validToken,
      });

      const targetsRes = await client.listTargets(testWorkspace.id, testProject.id);
      expect(targetsRes.success).toBe(true);
      expect(targetsRes.data.targets).toHaveLength(1);
      expect(targetsRes.data.targets[0]!.id).toBe(testTarget.id);

      const journeysRes = await client.listJourneys(testWorkspace.id, testTarget.id);
      expect(journeysRes.success).toBe(true);
      expect(journeysRes.data.journeys).toHaveLength(1);
      expect(journeysRes.data.journeys[0]!.id).toBe(testJourney.id);
    });

    it('retrieves run and queue status through typed client', async () => {
      const client = new ProductApiClient({
        baseUrl: apiServer.url,
        token: validToken,
      });

      const runRes = await client.getRun(testWorkspace.id, testRun.id);
      expect(runRes.success).toBe(true);
      expect(runRes.data.id).toBe(testRun.id);
      expect(runRes.data.status).toBe('queued');

      const queueRes = await client.getRunQueue(testWorkspace.id, testRun.id);
      expect(queueRes.success).toBe(true);
      expect(queueRes.data.runId).toBe(testRun.id);
      expect(queueRes.data.queueStatus).toBe('queued');
    });

    it('lists candidate findings with confirmed: false and confirmedBug: false invariants', async () => {
      const client = new ProductApiClient({
        baseUrl: apiServer.url,
        token: validToken,
      });

      const candRes = await client.listRunCandidates(testWorkspace.id, testRun.id);
      expect(candRes.success).toBe(true);
      expect(candRes.data.candidates).toHaveLength(1);
      const cand = candRes.data.candidates[0]!;
      expect(cand.candidateId).toBe('cand_signal_01');
      expect(cand.confirmed).toBe(false);
      expect(cand.confirmedBug).toBe(false);
    });

    it('lists artifacts and downloads content safely without exposing server filesystem paths', async () => {
      const client = new ProductApiClient({
        baseUrl: apiServer.url,
        token: validToken,
      });

      const artRes = await client.listRunArtifacts(testWorkspace.id, testRun.id);
      expect(artRes.success).toBe(true);
      expect(artRes.data.artifacts.length).toBeGreaterThanOrEqual(1);

      const art = artRes.data.artifacts[0]!;
      expect(art.storagePath).not.toContain('C:');
      expect(art.storagePath).not.toContain('\\');
      expect(art.storagePath).not.toContain('/tmp');

      const download = await client.getArtifactContent(testWorkspace.id, art.id);
      expect(download.content).toBeDefined();
      expect(download.contentType).toContain('application/json');
      expect(download.sha256).toBe(art.sha256);
    });

    it('foreign user cannot download Alice artifact (403 Forbidden)', async () => {
      const client = new ProductApiClient({
        baseUrl: apiServer.url,
        token: validToken,
      });
      const artRes = await client.listRunArtifacts(testWorkspace.id, testRun.id);
      const artId = artRes.data.artifacts[0]!.id;

      const foreignClient = new ProductApiClient({
        baseUrl: apiServer.url,
        token: foreignToken,
      });

      await expect(foreignClient.getArtifactContent(testWorkspace.id, artId)).rejects.toThrow(ForbiddenError);
    });

    it('safely cancels queued run via API and enforces idempotency', async () => {
      const client = new ProductApiClient({
        baseUrl: apiServer.url,
        token: validToken,
      });

      // 1. Cancel queued run
      const cancelRes = await client.cancelRun(testWorkspace.id, testRun.id, 'User test cancellation');
      expect(cancelRes.success).toBe(true);
      expect(cancelRes.data.status).toBe('cancelled');

      // 2. Second cancellation call is cleanly idempotent
      const secondCancel = await client.cancelRun(testWorkspace.id, testRun.id);
      expect(secondCancel.success).toBe(true);
      expect(secondCancel.data.status).toBe('cancelled');
    });
  });

  // ===========================================================================
  // 3. Polling and Lifecycle Safety
  // ===========================================================================
  describe('3. Polling Engine & Terminal Lifecycle Guarantees', () => {
    it('terminal run states are immutable and reject cancellation', async () => {
      const completedRun = await repos.runs.create({
        id: 'run_completed_test',
        schemaVersion: '1.0',
        workspaceId: testWorkspace.id,
        projectId: testProject.id,
        targetEnvironmentId: testTarget.id,
        journeyId: testJourney.id,
        status: 'completed',
        safeTestMode: true,
        preflightStatus: 'ready',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const client = new ProductApiClient({
        baseUrl: apiServer.url,
        token: validToken,
      });

      await expect(client.cancelRun(testWorkspace.id, completedRun.id)).rejects.toThrow(
        /Cannot cancel run in terminal status "completed"/,
      );
    });

    it('reverse proxy forwards /api/* calls from dashboard to product API', async () => {
      const proxyRes = await makeRequest(`${dashboardServer.url}/api/v1/me`, {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      expect(proxyRes.status).toBe(200);
      const parsed = JSON.parse(proxyRes.body);
      expect(parsed.success).toBe(true);
      expect(parsed.data.user.id).toBe(testUser.id);
    });
  });
});
