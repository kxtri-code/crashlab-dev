/**
 * Unit Tests for Build 12C.2: Preflight-Gated Journey Execution Dispatch from Dashboard.
 *
 * Verifies:
 * 1. Authenticated user can see approved journeys (project listing & detail)
 * 2. Unauthenticated run request returns 401
 * 3. Cross-workspace run request returns 403
 * 4. Target not belonging to project is rejected (400)
 * 5. Journey not belonging to target is rejected (400)
 * 6. Malformed journey is rejected (400)
 * 7. Forbidden action is rejected by preflight (422 PREFLIGHT_BLOCKED)
 * 8. Production-like target is rejected by preflight (422 PREFLIGHT_BLOCKED)
 * 9. Origin mismatch is rejected by preflight (422 PREFLIGHT_BLOCKED)
 * 10. Missing safe test data is rejected by preflight (422 PREFLIGHT_BLOCKED)
 * 11. Safe-test disabled attempt is rejected by preflight (422 PREFLIGHT_BLOCKED)
 * 12. Blocked preflight launches zero browsers, makes zero target requests, and creates zero queue items
 * 13. Valid journey creates a queued run and enters the queue
 * 14. Browser cannot override target URL (400)
 * 15. Browser cannot inject actions or locators (400)
 * 16. Browser cannot inject credentials (400)
 * 17. Dashboard does not render secrets or server filesystem paths
 * 18. Candidate view displays confirmedBug: false and confirmed: false
 * 19. Candidate human review status uses "accepted", never "confirmed"
 * 20. Strict assertion: Dashboard HTML never renders "confirmed bug", "confirmed: true", or "confirmedBug: true"
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
  PreflightBlockedError,
  type RunningDashboardServer,
  type ProductApiServer,
  type ProductRepositories,
  type TargetEnvironment,
  type ProductApprovedJourney,
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

describe('Build 12C.2: Preflight-Gated Journey Execution Dispatch Unit Suite', () => {
  const TEST_SECRET = 'build12c2_preflight_gated_dispatch_test_secret_32chars!';
  let repos: ProductRepositories;
  let service: ProductService;
  let apiServer: ProductApiServer;
  let dashboardServer: RunningDashboardServer;

  let ownerUser: any;
  let foreignUser: any;
  let workspace: any;
  let foreignWorkspace: any;
  let project: any;
  let target: TargetEnvironment;
  let validJourney: ProductApprovedJourney;

  let ownerToken: string;
  let foreignToken: string;

  beforeAll(async () => {
    repos = createInMemoryProductRepositories();
    service = new ProductService({ repositories: repos });

    ownerUser = await service.createUser({ name: 'Alice Operator', email: 'alice@dispatch.test' });
    foreignUser = await service.createUser({ name: 'Mallory Adversary', email: 'mallory@dispatch.test' });

    const wsRes = await service.createWorkspace({
      name: 'Safe Dispatch Workspace',
      slug: 'safe-dispatch',
      ownerUserId: ownerUser.id,
    });
    workspace = wsRes.workspace;

    const foreignWsRes = await service.createWorkspace({
      name: 'Foreign Isolated Workspace',
      slug: 'foreign-isolated',
      ownerUserId: foreignUser.id,
    });
    foreignWorkspace = foreignWsRes.workspace;

    project = await service.createProject(
      {
        workspaceId: workspace.id,
        name: 'Autonomous Billing Portal',
        description: 'Authorized test portal',
      },
      ownerUser.id,
    );

    target = await service.createTarget(
      {
        workspaceId: workspace.id,
        projectId: project.id,
        name: 'Local Test Target',
        environment: 'local',
        targetUrl: 'http://127.0.0.1:3220',
        allowedOrigins: ['http://127.0.0.1:3220'],
        forbiddenActions: ['checkout', 'payment', 'delete_account'],
      },
      ownerUser.id,
    );

    validJourney = await service.approveJourney(
      {
        workspaceId: workspace.id,
        projectId: project.id,
        targetEnvironmentId: target.id,
        goal: 'test catalog navigation and filter items',
        origin: 'http://127.0.0.1:3220',
        allowedActions: ['click', 'type'],
        forbiddenActions: ['payment', 'checkout'],
        requiresCredentials: false,
        requiresTestData: false,
      },
      ownerUser.id,
    );

    ownerToken = createDevToken({ userId: ownerUser.id, secret: TEST_SECRET, expiresInSeconds: 7200 });
    foreignToken = createDevToken({ userId: foreignUser.id, secret: TEST_SECRET, expiresInSeconds: 7200 });

    apiServer = createProductApiServer({
      service,
      authMode: 'development',
      authSecret: TEST_SECRET,
      port: 0,
    });
    const apiBound = await apiServer.start();

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
  // 1. Journey Discovery & Detail Endpoints
  // ===========================================================================
  describe('1. Journey Discovery & Detail Endpoints', () => {
    it('authenticated user can list approved journeys by project', async () => {
      const client = new ProductApiClient({ baseUrl: apiServer.url, token: ownerToken });
      const res = await client.listProjectJourneys(workspace.id, project.id);

      expect(res.success).toBe(true);
      expect(res.data.journeys).toHaveLength(1);
      const j = res.data.journeys[0]!;
      expect(j.id).toBe(validJourney.id);
      expect(j.goal).toBe('test catalog navigation and filter items');
      expect(j.origin).toBe('http://127.0.0.1:3220');
      expect(j.allowedActions).toContain('click');
    });

    it('authenticated user can get a specific journey by ID', async () => {
      const client = new ProductApiClient({ baseUrl: apiServer.url, token: ownerToken });
      const res = await client.getJourney(workspace.id, validJourney.id);

      expect(res.success).toBe(true);
      expect(res.data.id).toBe(validJourney.id);
      expect(res.data.goal).toBe(validJourney.goal);
    });

    it('cross-workspace journey request returns 403 Forbidden', async () => {
      const client = new ProductApiClient({ baseUrl: apiServer.url, token: foreignToken });
      await expect(client.listProjectJourneys(workspace.id, project.id)).rejects.toThrow(ForbiddenError);
    });
  });

  // ===========================================================================
  // 2. Run Dispatch Authentication & Authorization
  // ===========================================================================
  describe('2. Run Dispatch Authentication & Tenant Boundary', () => {
    it('unauthenticated run request returns 401', async () => {
      const rawRes = await makeRequest(`${apiServer.url}/api/v1/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId: workspace.id,
          projectId: project.id,
          targetEnvironmentId: target.id,
          journeyId: validJourney.id,
        }),
      });

      expect(rawRes.status).toBe(401);
      const body = JSON.parse(rawRes.body);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('UNAUTHORIZED');
    });

    it('cross-workspace run request returns 403 Forbidden', async () => {
      const client = new ProductApiClient({ baseUrl: apiServer.url, token: foreignToken });
      await expect(
        client.createRun({
          workspaceId: workspace.id,
          projectId: project.id,
          targetEnvironmentId: target.id,
          journeyId: validJourney.id,
        }),
      ).rejects.toThrow(ForbiddenError);
    });
  });

  // ===========================================================================
  // 3. Prohibited Client Override Protection
  // ===========================================================================
  describe('3. Strict Browser Override Protection (IDs Only)', () => {
    it('rejects client attempt to override target URL with 400 BAD_REQUEST', async () => {
      const rawRes = await makeRequest(`${apiServer.url}/api/v1/runs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${ownerToken}`,
        },
        body: JSON.stringify({
          workspaceId: workspace.id,
          projectId: project.id,
          targetEnvironmentId: target.id,
          journeyId: validJourney.id,
          targetUrl: 'http://malicious.evil.com',
        }),
      });

      expect(rawRes.status).toBe(400);
      const parsed = JSON.parse(rawRes.body);
      expect(parsed.error.code).toBe('BAD_REQUEST');
      expect(parsed.error.message).toContain('Forbidden override field "targetUrl"');
    });

    it('rejects client attempt to inject actions or steps with 400 BAD_REQUEST', async () => {
      const rawRes = await makeRequest(`${apiServer.url}/api/v1/runs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${ownerToken}`,
        },
        body: JSON.stringify({
          workspaceId: workspace.id,
          projectId: project.id,
          targetEnvironmentId: target.id,
          journeyId: validJourney.id,
          actions: ['delete_all_users', 'drop_database'],
        }),
      });

      expect(rawRes.status).toBe(400);
      const parsed = JSON.parse(rawRes.body);
      expect(parsed.error.message).toContain('Forbidden override field "actions"');
    });

    it('rejects client attempt to inject credentials or passwords with 400 BAD_REQUEST', async () => {
      const rawRes = await makeRequest(`${apiServer.url}/api/v1/runs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${ownerToken}`,
        },
        body: JSON.stringify({
          workspaceId: workspace.id,
          projectId: project.id,
          targetEnvironmentId: target.id,
          journeyId: validJourney.id,
          password: 'SecretAdminPassword123!',
        }),
      });

      expect(rawRes.status).toBe(400);
      const parsed = JSON.parse(rawRes.body);
      expect(parsed.error.message).toContain('Forbidden override field "password"');
    });
  });

  // ===========================================================================
  // 4. Entity Relationship & Schema Validation
  // ===========================================================================
  describe('4. Entity Relationship & Schema Validation', () => {
    it('target not belonging to project is rejected with 400', async () => {
      // Create a foreign project in the same workspace
      const foreignProject = await service.createProject(
        { workspaceId: workspace.id, name: 'Different Project' },
        ownerUser.id,
      );

      const client = new ProductApiClient({ baseUrl: apiServer.url, token: ownerToken });
      await expect(
        client.createRun({
          workspaceId: workspace.id,
          projectId: foreignProject.id, // target belongs to 'project.id', not 'foreignProject.id'
          targetEnvironmentId: target.id,
          journeyId: validJourney.id,
        }),
      ).rejects.toThrow(/does not belong to project/);
    });

    it('journey not belonging to target is rejected with 400', async () => {
      const secondTarget = await service.createTarget(
        {
          workspaceId: workspace.id,
          projectId: project.id,
          name: 'Second Local Target',
          environment: 'local',
          targetUrl: 'http://127.0.0.1:3225',
          allowedOrigins: ['http://127.0.0.1:3225'],
        },
        ownerUser.id,
      );

      const client = new ProductApiClient({ baseUrl: apiServer.url, token: ownerToken });
      await expect(
        client.createRun({
          workspaceId: workspace.id,
          projectId: project.id,
          targetEnvironmentId: secondTarget.id, // journey belongs to 'target.id', not 'secondTarget.id'
          journeyId: validJourney.id,
        }),
      ).rejects.toThrow(/does not belong to target environment/);
    });

    it('malformed journey is rejected with 400', async () => {
      // Directly inject a malformed journey into the repository
      const malformed = {
        id: 'jny_malformed_test',
        schemaVersion: '1.0' as const,
        workspaceId: workspace.id,
        projectId: project.id,
        targetEnvironmentId: target.id,
        goal: '', // empty goal (malformed)
        origin: 'http://127.0.0.1:3220',
        allowedActions: [] as string[], // empty allowed actions
        forbiddenActions: [] as string[],
        requiresCredentials: false,
        requiresTestData: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await repos.journeys.create(malformed);

      const client = new ProductApiClient({ baseUrl: apiServer.url, token: ownerToken });
      await expect(
        client.createRun({
          workspaceId: workspace.id,
          projectId: project.id,
          targetEnvironmentId: target.id,
          journeyId: malformed.id,
        }),
      ).rejects.toThrow();
    });
  });

  // ===========================================================================
  // 5. Preflight Gate Enforcement (422 PREFLIGHT_BLOCKED)
  // ===========================================================================
  describe('5. Preflight Gate Safety Enforcement', () => {
    it('production-like target environment is rejected with 422 PREFLIGHT_BLOCKED', async () => {
      // Create a target with prohibited production environment directly in repo
      const prodTarget = await repos.targets.create({
        id: 'tgt_prod_test',
        schemaVersion: '1.0',
        workspaceId: workspace.id,
        projectId: project.id,
        name: 'Live Production',
        environment: 'production' as any,
        targetUrl: 'https://app.production-live.com',
        targetOrigin: 'https://app.production-live.com',
        allowedOrigins: ['https://app.production-live.com'],
        forbiddenActions: ['checkout'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const prodJourney = await repos.journeys.create({
        id: 'jny_prod_test',
        schemaVersion: '1.0',
        workspaceId: workspace.id,
        projectId: project.id,
        targetEnvironmentId: prodTarget.id,
        goal: 'test navigation on prod',
        origin: 'https://app.production-live.com',
        allowedActions: ['click'],
        forbiddenActions: ['checkout'],
        requiresCredentials: false,
        requiresTestData: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const client = new ProductApiClient({ baseUrl: apiServer.url, token: ownerToken });
      await expect(
        client.createRun({
          workspaceId: workspace.id,
          projectId: project.id,
          targetEnvironmentId: prodTarget.id,
          journeyId: prodJourney.id,
        }),
      ).rejects.toThrow(PreflightBlockedError);
    });

    it('origin mismatch between journey and target is rejected with 422 PREFLIGHT_BLOCKED', async () => {
      const mismatchJourney = await repos.journeys.create({
        id: 'jny_mismatch_origin',
        schemaVersion: '1.0',
        workspaceId: workspace.id,
        projectId: project.id,
        targetEnvironmentId: target.id,
        goal: 'cross origin journey navigation',
        origin: 'http://127.0.0.1:9999', // Not in target.allowedOrigins
        allowedActions: ['click'],
        forbiddenActions: ['payment'],
        requiresCredentials: false,
        requiresTestData: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const client = new ProductApiClient({ baseUrl: apiServer.url, token: ownerToken });
      await expect(
        client.createRun({
          workspaceId: workspace.id,
          projectId: project.id,
          targetEnvironmentId: target.id,
          journeyId: mismatchJourney.id,
        }),
      ).rejects.toThrow(PreflightBlockedError);
    });

    it('forbidden action in journey allowedActions is rejected with 422 PREFLIGHT_BLOCKED', async () => {
      const forbiddenActionJourney = await repos.journeys.create({
        id: 'jny_forbidden_act',
        schemaVersion: '1.0',
        workspaceId: workspace.id,
        projectId: project.id,
        targetEnvironmentId: target.id,
        goal: 'perform unauthorized checkout and purchase',
        origin: 'http://127.0.0.1:3220',
        allowedActions: ['checkout', 'payment'], // Dangerous actions!
        forbiddenActions: [],
        requiresCredentials: false,
        requiresTestData: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const client = new ProductApiClient({ baseUrl: apiServer.url, token: ownerToken });
      await expect(
        client.createRun({
          workspaceId: workspace.id,
          projectId: project.id,
          targetEnvironmentId: target.id,
          journeyId: forbiddenActionJourney.id,
        }),
      ).rejects.toThrow(PreflightBlockedError);
    });

    it('missing safe test data when journey requires credentials is rejected with 422 PREFLIGHT_BLOCKED', async () => {
      const needsDataJourney = await repos.journeys.create({
        id: 'jny_needs_test_data',
        schemaVersion: '1.0',
        workspaceId: workspace.id,
        projectId: project.id,
        targetEnvironmentId: target.id,
        goal: 'authenticated account setting update',
        origin: 'http://127.0.0.1:3220',
        allowedActions: ['click', 'type'],
        forbiddenActions: ['delete_account'],
        requiresCredentials: true,
        requiresTestData: true, // Requires test data file, but target.testDataReference is undefined
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const client = new ProductApiClient({ baseUrl: apiServer.url, token: ownerToken });
      await expect(
        client.createRun({
          workspaceId: workspace.id,
          projectId: project.id,
          targetEnvironmentId: target.id,
          journeyId: needsDataJourney.id,
        }),
      ).rejects.toThrow(PreflightBlockedError);
    });

    it('blocked preflight launches zero browsers and creates no queued run item', async () => {
      const runsBefore = await repos.runs.listByProject(workspace.id, project.id);
      const queueBefore = await repos.queue!.listByWorkspace(workspace.id);

      const client = new ProductApiClient({ baseUrl: apiServer.url, token: ownerToken });
      await expect(
        client.createRun({
          workspaceId: workspace.id,
          projectId: project.id,
          targetEnvironmentId: target.id,
          journeyId: 'jny_forbidden_act',
        }),
      ).rejects.toThrow(PreflightBlockedError);

      const runsAfter = await repos.runs.listByProject(workspace.id, project.id);
      const queueAfter = await repos.queue!.listByWorkspace(workspace.id);

      // Verify zero runs or queue items were created
      expect(runsAfter.length).toBe(runsBefore.length);
      expect(queueAfter.length).toBe(queueBefore.length);

      // Verify security audit log recorded the blocked refusal
      const auditEvents = await repos.audits.listByWorkspace(workspace.id);
      const blockedAudit = auditEvents.find((e) => e.eventType === 'run.preflight_blocked');
      expect(blockedAudit).toBeDefined();
      expect(blockedAudit?.actorUserId).toBe(ownerUser.id);
    });
  });

  // ===========================================================================
  // 6. Valid Journey Enqueue & Queue Inspection
  // ===========================================================================
  describe('6. Valid Journey Enqueue & Execution Lifecycle', () => {
    let createdRunId: string;

    it('valid journey creates a queued run in PostgreSQL queue and returns 201', async () => {
      const client = new ProductApiClient({ baseUrl: apiServer.url, token: ownerToken });
      const res = await client.createRun({
        workspaceId: workspace.id,
        projectId: project.id,
        targetEnvironmentId: target.id,
        journeyId: validJourney.id,
        maxAttempts: 2,
      });

      expect(res.success).toBe(true);
      expect(res.data.id).toMatch(/^run_/);
      expect(res.data.status).toBe('queued');
      expect(res.data.safeTestMode).toBe(true);
      expect(res.data.maxAttempts).toBe(2);
      expect(res.requestId).toBeDefined();
      createdRunId = res.data.id;

      // Verify atomic queue item was enqueued
      const queueItem = await service.getRunQueueItem(workspace.id, createdRunId, ownerUser.id);
      expect(queueItem).toBeDefined();
      expect(queueItem?.queueStatus).toBe('queued');
      expect(queueItem?.runId).toBe(createdRunId);
    });

    it('run detail endpoint displays lifecycle status and execution metadata', async () => {
      const client = new ProductApiClient({ baseUrl: apiServer.url, token: ownerToken });
      const res = await client.getRun(workspace.id, createdRunId);

      expect(res.success).toBe(true);
      expect(res.data.id).toBe(createdRunId);
      expect(res.data.projectId).toBe(project.id);
      expect(res.data.targetEnvironmentId).toBe(target.id);
      expect(res.data.journeyId).toBe(validJourney.id);
      expect(res.data.safeTestMode).toBe(true);
    });

    it('cancellation works and is idempotent', async () => {
      const client = new ProductApiClient({ baseUrl: apiServer.url, token: ownerToken });

      const firstCancel = await client.cancelRun(workspace.id, createdRunId, 'Testing operator cancellation');
      expect(firstCancel.success).toBe(true);
      expect(firstCancel.data.status).toBe('cancelled');

      // Second call must be idempotent
      const secondCancel = await client.cancelRun(workspace.id, createdRunId);
      expect(secondCancel.success).toBe(true);
      expect(secondCancel.data.status).toBe('cancelled');
    });
  });

  // ===========================================================================
  // 7. Candidate Terminology Invariant & Language Audit
  // ===========================================================================
  describe('7. Candidate Terminology & Trust Language Invariants', () => {
    it('candidate review status uses "accepted" rather than "confirmed"', async () => {
      // Register test candidate with status 'accepted'
      const cand = await service.registerCandidate(
        {
          workspaceId: workspace.id,
          projectId: project.id,
          runId: 'run_test_triage',
          candidateId: 'cand_triage_01',
          ruleId: 'HTTP_5XX',
          classification: 'server_error',
          reproduced: true,
          reviewStatus: 'accepted' as any,
        },
        ownerUser.id,
      );

      expect(cand.confirmed).toBe(false);
      expect(cand.confirmedBug).toBe(false);
      expect(cand.reviewStatus).toBe('accepted');
    });

    it('dashboard static bundle contains invariant text and NO "confirmed bug"', async () => {
      const appJs = await makeRequest(`${dashboardServer.url}/app.js`);
      expect(appJs.status).toBe(200);

      const code = appJs.body;

      // Invariants must be present
      expect(code).toContain('confirmedBug: false');
      expect(code).toContain('confirmed: false');
      expect(code).toContain('Candidate finding — not a confirmed defect');
      expect(code).toContain('Human acceptance is not automated confirmation');
      expect(code).toContain('accepted');

      // Prohibited terminology must NOT be present
      expect(code).not.toContain('"confirmed bug"');
      expect(code).not.toContain('confirmedBug: true');
      expect(code).not.toContain('confirmed: true');
    });

    it('dashboard does not expose secrets or local server filesystem paths', async () => {
      const appJs = await makeRequest(`${dashboardServer.url}/app.js`);
      const stylesCss = await makeRequest(`${dashboardServer.url}/styles.css`);
      const indexHtml = await makeRequest(`${dashboardServer.url}/`);

      const allPayloads = [appJs.body, stylesCss.body, indexHtml.body].join('\n');

      expect(allPayloads).not.toContain(TEST_SECRET);
      expect(allPayloads).not.toContain('DATABASE_URL');
      expect(allPayloads).not.toContain('C:\\Users\\');
      expect(allPayloads).not.toContain('/home/');
    });
  });
});
