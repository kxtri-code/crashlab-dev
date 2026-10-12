/**
 * Unit Test Suite for Build 11: Hosted MVP Product Foundation.
 *
 * Verifies domain contracts, tenant isolation, RBAC permissions,
 * run lifecycle state machine, preflight safety gate reuse,
 * secret boundaries, repository adapters, and minimal product API.
 *
 * Guarantees ZERO browser launches, external networks, AI models, or cloud databases.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  ProductService,
  TenantAccessDeniedError,
  EntityNotFoundError,
} from '../../src/product/service/productService.js';
import { createInMemoryProductRepositories } from '../../src/product/repository/inMemory.js';
import { DeterministicIdGenerator } from '../../src/product/util/id.js';
import {
  canReadWorkspace,
  canManageMembers,
  canManageProject,
  canConfigureTargets,
  canRunProject,
  canReviewCandidate,
} from '../../src/product/auth/permissions.js';
import {
  validateRunTransition,
  TERMINAL_RUN_STATUSES,
} from '../../src/product/lifecycle/runStateMachine.js';
import {
  scanForSecrets,
  assertNoSecrets,
} from '../../src/product/secrets/sanitizer.js';
import { FakeSecretProvider } from '../../src/product/secrets/secretProvider.js';
import { createProductApiServer, type ProductApiServer } from '../../src/product/api/server.js';
import { runProductFoundationRehearsal } from '../../src/product/service/rehearsal.js';
import type { TestRun } from '../../src/product/types/run.js';
import type { WorkspaceMember } from '../../src/product/types/workspace.js';

describe('Build 11: Hosted MVP Product Foundation Unit Suite', () => {
  let repos: ReturnType<typeof createInMemoryProductRepositories>;
  let idGen: DeterministicIdGenerator;
  let service: ProductService;

  beforeEach(() => {
    repos = createInMemoryProductRepositories();
    idGen = new DeterministicIdGenerator('b11-test');
    service = new ProductService({ repositories: repos, idGenerator: idGen });
  });

  // ===========================================================================
  // 1. Workspace, Project & Membership Domain
  // ===========================================================================
  describe('1. Workspace, Project & Membership Domain', () => {
    it('creates workspace and automatically establishes creator as owner', async () => {
      const user = await service.createUser({ name: 'Alice Owner', email: 'alice@example.test' });
      expect(user.id).toMatch(/^usr_[a-f0-9]+$/);
      expect(user.email).toBe('alice@example.test');

      const { workspace, membership } = await service.createWorkspace({
        name: 'Acme QA',
        slug: 'acme-qa',
        ownerUserId: user.id,
      });

      expect(workspace.id).toMatch(/^ws_[a-f0-9]+$/);
      expect(workspace.slug).toBe('acme-qa');
      expect(workspace.ownerUserId).toBe(user.id);

      expect(membership.workspaceId).toBe(workspace.id);
      expect(membership.userId).toBe(user.id);
      expect(membership.role).toBe('owner');
    });

    it('rejects duplicate workspace slug or user email', async () => {
      const user1 = await service.createUser({ name: 'Alice', email: 'alice@example.test' });
      await expect(
        service.createUser({ name: 'Alice Clone', email: 'alice@example.test' }),
      ).rejects.toThrow(/already exists/);

      await service.createWorkspace({ name: 'Acme', slug: 'acme', ownerUserId: user1.id });
      await expect(
        service.createWorkspace({ name: 'Acme Two', slug: 'acme', ownerUserId: user1.id }),
      ).rejects.toThrow(/already exists/);
    });

    it('adds and lists workspace members with assigned roles', async () => {
      const owner = await service.createUser({ name: 'Owner', email: 'owner@example.test' });
      const dev = await service.createUser({ name: 'Dev', email: 'dev@example.test' });
      const { workspace } = await service.createWorkspace({ name: 'WS', slug: 'ws', ownerUserId: owner.id });

      const devMember = await service.addMember(
        { workspaceId: workspace.id, userId: dev.id, role: 'member' },
        owner.id,
      );
      expect(devMember.role).toBe('member');

      const members = await service.listMembers(workspace.id, owner.id);
      expect(members).toHaveLength(2);
      expect(members.map((m) => m.role)).toContain('owner');
      expect(members.map((m) => m.role)).toContain('member');
    });
  });

  // ===========================================================================
  // 2. Tenant Isolation & Cross-Workspace Refusal
  // ===========================================================================
  describe('2. Tenant Isolation & Cross-Workspace Refusal', () => {
    it('strictly refuses cross-workspace project access', async () => {
      const userA = await service.createUser({ name: 'Alice', email: 'alice@a.test' });
      const userB = await service.createUser({ name: 'Bob', email: 'bob@b.test' });

      const { workspace: wsA } = await service.createWorkspace({ name: 'WS A', slug: 'ws-a', ownerUserId: userA.id });
      const { workspace: wsB } = await service.createWorkspace({ name: 'WS B', slug: 'ws-b', ownerUserId: userB.id });

      const prjA = await service.createProject({ workspaceId: wsA.id, name: 'Project A' }, userA.id);

      // User B attempts to read Project A from Workspace A -> refused!
      await expect(service.getProject(wsA.id, prjA.id, userB.id)).rejects.toThrow(TenantAccessDeniedError);

      // User B attempts to read Project A by passing Workspace B -> entity not found in Workspace B!
      await expect(service.getProject(wsB.id, prjA.id, userB.id)).rejects.toThrow(EntityNotFoundError);
    });

    it('repository level strictly guarantees workspaceId query isolation', async () => {
      const user = await service.createUser({ name: 'Owner', email: 'owner@ws.test' });
      const { workspace: wsA } = await service.createWorkspace({ name: 'A', slug: 'a', ownerUserId: user.id });
      const { workspace: wsB } = await service.createWorkspace({ name: 'B', slug: 'b', ownerUserId: user.id });

      const prjA = await service.createProject({ workspaceId: wsA.id, name: 'Secret App A' }, user.id);

      // Querying with wsB ID returns null even though ID exists in database
      const foundInB = await repos.projects.findById(wsB.id, prjA.id);
      expect(foundInB).toBeNull();

      const foundInA = await repos.projects.findById(wsA.id, prjA.id);
      expect(foundInA).not.toBeNull();
      expect(foundInA?.id).toBe(prjA.id);
    });
  });

  // ===========================================================================
  // 3. RBAC & Role Permissions
  // ===========================================================================
  describe('3. Role-Based Access Control (RBAC)', () => {
    const makeMember = (role: WorkspaceMember['role'], wsId: string, uId: string): WorkspaceMember => ({
      id: 'mem_1',
      schemaVersion: '1.0',
      workspaceId: wsId,
      userId: uId,
      role,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    it('owner role has full management capabilities', () => {
      const m = makeMember('owner', 'ws_1', 'u_1');
      expect(canReadWorkspace(m, 'ws_1')).toBe(true);
      expect(canManageMembers(m, 'ws_1')).toBe(true);
      expect(canManageProject(m, { workspaceId: 'ws_1' })).toBe(true);
      expect(canConfigureTargets(m, { workspaceId: 'ws_1' })).toBe(true);
      expect(canRunProject(m, { workspaceId: 'ws_1' })).toBe(true);
      expect(canReviewCandidate(m, { workspaceId: 'ws_1' })).toBe(true);
    });

    it('member role can run tests but cannot manage members or targets', () => {
      const m = makeMember('member', 'ws_1', 'u_2');
      expect(canReadWorkspace(m, 'ws_1')).toBe(true);
      expect(canRunProject(m, { workspaceId: 'ws_1' })).toBe(true);
      expect(canManageMembers(m, 'ws_1')).toBe(false);
      expect(canConfigureTargets(m, { workspaceId: 'ws_1' })).toBe(false);
      expect(canReviewCandidate(m, { workspaceId: 'ws_1' })).toBe(false);
    });

    it('reviewer role can update triage state but cannot run tests', () => {
      const m = makeMember('reviewer', 'ws_1', 'u_3');
      expect(canReadWorkspace(m, 'ws_1')).toBe(true);
      expect(canReviewCandidate(m, { workspaceId: 'ws_1' })).toBe(true);
      expect(canRunProject(m, { workspaceId: 'ws_1' })).toBe(false);
      expect(canManageProject(m, { workspaceId: 'ws_1' })).toBe(false);
    });

    it('viewer role is strictly read-only and cannot review or run tests', () => {
      const m = makeMember('viewer', 'ws_1', 'u_4');
      expect(canReadWorkspace(m, 'ws_1')).toBe(true);
      expect(canReviewCandidate(m, { workspaceId: 'ws_1' })).toBe(false);
      expect(canRunProject(m, { workspaceId: 'ws_1' })).toBe(false);
      expect(canManageProject(m, { workspaceId: 'ws_1' })).toBe(false);
    });

    it('service enforces reviewer permission on candidate review', async () => {
      const owner = await service.createUser({ name: 'Owner', email: 'owner@rbac.test' });
      const viewer = await service.createUser({ name: 'Viewer', email: 'viewer@rbac.test' });
      const reviewer = await service.createUser({ name: 'Reviewer', email: 'rev@rbac.test' });

      const { workspace } = await service.createWorkspace({ name: 'RBAC WS', slug: 'rbac-ws', ownerUserId: owner.id });
      await service.addMember({ workspaceId: workspace.id, userId: viewer.id, role: 'viewer' }, owner.id);
      await service.addMember({ workspaceId: workspace.id, userId: reviewer.id, role: 'reviewer' }, owner.id);

      const project = await service.createProject({ workspaceId: workspace.id, name: 'Proj' }, owner.id);
      const target = await service.createTarget(
        {
          workspaceId: workspace.id,
          projectId: project.id,
          name: 'Local',
          environment: 'local',
          targetUrl: 'http://127.0.0.1:3000',
          allowedOrigins: ['http://127.0.0.1:3000'],
        },
        owner.id,
      );
      const journey = await service.approveJourney(
        {
          workspaceId: workspace.id,
          projectId: project.id,
          targetEnvironmentId: target.id,
          goal: 'test',
          origin: target.targetOrigin,
          allowedActions: ['navigate'],
        },
        owner.id,
      );
      const run = await service.createRun(
        {
          workspaceId: workspace.id,
          projectId: project.id,
          targetEnvironmentId: target.id,
          journeyId: journey.id,
        },
        owner.id,
      );

      const candidate = await service.registerCandidate(
        {
          workspaceId: workspace.id,
          projectId: project.id,
          runId: run.id,
          candidateId: 'cand-001',
          ruleId: 'HTTP_5XX',
          classification: 'novel',
          reproduced: true,
        },
        owner.id,
      );

      // Viewer cannot review -> TenantAccessDeniedError
      await expect(
        service.reviewCandidate(workspace.id, candidate.id, 'investigating', 'viewer notes', viewer.id),
      ).rejects.toThrow(TenantAccessDeniedError);

      // Reviewer can review -> succeeds
      const reviewed = await service.reviewCandidate(
        workspace.id,
        candidate.id,
        'investigating',
        'reviewer notes',
        reviewer.id,
      );
      expect(reviewed.reviewStatus).toBe('investigating');
    });
  });

  // ===========================================================================
  // 4. Run Lifecycle State Machine
  // ===========================================================================
  describe('4. Run Lifecycle State Machine', () => {
    function mockRun(status: TestRun['status'], overrides: Partial<TestRun> = {}): TestRun {
      return {
        id: 'run_test',
        schemaVersion: '1.0',
        workspaceId: 'ws_1',
        projectId: 'prj_1',
        targetEnvironmentId: 'tgt_1',
        journeyId: 'jny_1',
        status,
        safeTestMode: true,
        preflightStatus: 'ready',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...overrides,
      };
    }

    it('allows valid normal state progression: created -> preflight -> queued -> running -> completed', () => {
      let run = mockRun('created', { preflightStatus: 'pending' });

      // created -> preflight
      let res = validateRunTransition(run, 'preflight');
      expect(res.valid).toBe(true);

      // preflight -> queued (requires preflight ready)
      run = mockRun('preflight', { preflightStatus: 'ready' });
      res = validateRunTransition(run, 'queued', { preflightReady: true });
      expect(res.valid).toBe(true);

      // queued -> running
      run = mockRun('queued');
      res = validateRunTransition(run, 'running', { preflightReady: true });
      expect(res.valid).toBe(true);

      // running -> completed (requires execution evidence & passed steps)
      run = mockRun('running');
      res = validateRunTransition(run, 'completed', { hasExecutionEvidence: true, hasPassedSteps: true });
      expect(res.valid).toBe(true);
      expect(res.auditEventType).toBe('run.completed');
    });

    it('refuses completion when zero steps passed (must be partial)', () => {
      const run = mockRun('running');
      const res = validateRunTransition(run, 'completed', { hasExecutionEvidence: true, hasPassedSteps: false });
      expect(res.valid).toBe(false);
      expect(res.error).toContain('zero steps passed');
    });

    it('refuses queueing or running when preflight is not ready', () => {
      const run = mockRun('preflight', { preflightStatus: 'blocked' });
      const res = validateRunTransition(run, 'queued', { preflightReady: false });
      expect(res.valid).toBe(false);
      expect(res.error).toContain('preflight safety gate status is not "ready"');
    });

    it('enforces that terminal states are strictly immutable', () => {
      for (const terminal of TERMINAL_RUN_STATUSES) {
        const run = mockRun(terminal);
        const res = validateRunTransition(run, 'running');
        expect(res.valid).toBe(false);
        expect(res.error).toContain('Terminal states are immutable');
      }
    });

    it('blocked run cannot become completed', () => {
      const run = mockRun('blocked');
      const res = validateRunTransition(run, 'completed', { hasExecutionEvidence: true, hasPassedSteps: true });
      expect(res.valid).toBe(false);
    });

    it('failed run cannot become completed', () => {
      const run = mockRun('failed');
      const res = validateRunTransition(run, 'completed', { hasExecutionEvidence: true, hasPassedSteps: true });
      expect(res.valid).toBe(false);
    });

    it('cancelled run cannot become completed', () => {
      const run = mockRun('cancelled');
      const res = validateRunTransition(run, 'completed', { hasExecutionEvidence: true, hasPassedSteps: true });
      expect(res.valid).toBe(false);
    });
  });

  // ===========================================================================
  // 5. Preflight Safety Gate Integration
  // ===========================================================================
  describe('5. Preflight Safety Gate Integration', () => {
    it('blocks staging target when written authorization reference is missing', async () => {
      const user = await service.createUser({ name: 'Owner', email: 'preflight@test.com' });
      const { workspace } = await service.createWorkspace({ name: 'WS', slug: 'ws-pf', ownerUserId: user.id });
      const project = await service.createProject({ workspaceId: workspace.id, name: 'P' }, user.id);

      // Staging environment without authorizationReference
      const target = await service.createTarget(
        {
          workspaceId: workspace.id,
          projectId: project.id,
          name: 'Unauth Staging',
          environment: 'staging',
          targetUrl: 'https://staging.example.com/checkout',
          allowedOrigins: ['https://staging.example.com'],
          forbiddenActions: ['checkout', 'payment', 'delete_account', 'change_password'],
          // Missing authorizationReference
        },
        user.id,
      );

      const journey = await service.approveJourney(
        {
          workspaceId: workspace.id,
          projectId: project.id,
          targetEnvironmentId: target.id,
          goal: 'browse items',
          origin: target.targetOrigin,
          allowedActions: ['navigate'],
        },
        user.id,
      );

      await service.approveJourney(
        {
          workspaceId: workspace.id,
          projectId: project.id,
          targetEnvironmentId: target.id,
          goal: 'view product details',
          origin: target.targetOrigin,
          allowedActions: ['navigate', 'view'],
        },
        user.id,
      );

      const run = await service.createRun(
        {
          workspaceId: workspace.id,
          projectId: project.id,
          targetEnvironmentId: target.id,
          journeyId: journey.id,
        },
        user.id,
      );

      const { run: evaluatedRun, preflightResult } = await service.evaluateRunPreflight(
        workspace.id,
        run.id,
        user.id,
      );

      expect(preflightResult.status).toBe('blocked');
      expect(evaluatedRun.status).toBe('blocked');
      expect(evaluatedRun.blockedReason).toContain('AUTHORIZATION_REFERENCE');
    });

    it('allows local synthetic fixture without external authorization', async () => {
      const user = await service.createUser({ name: 'Owner', email: 'local@test.com' });
      const { workspace } = await service.createWorkspace({ name: 'WS', slug: 'ws-local', ownerUserId: user.id });
      const project = await service.createProject({ workspaceId: workspace.id, name: 'P' }, user.id);

      const target = await service.createTarget(
        {
          workspaceId: workspace.id,
          projectId: project.id,
          name: 'Local Loopback',
          environment: 'local',
          targetUrl: 'http://127.0.0.1:4000/app',
          allowedOrigins: ['http://127.0.0.1:4000'],
          forbiddenActions: ['payment', 'checkout', 'delete_account'],
        },
        user.id,
      );

      const journey = await service.approveJourney(
        {
          workspaceId: workspace.id,
          projectId: project.id,
          targetEnvironmentId: target.id,
          goal: 'view home',
          origin: target.targetOrigin,
          allowedActions: ['navigate'],
        },
        user.id,
      );

      const run = await service.createRun(
        {
          workspaceId: workspace.id,
          projectId: project.id,
          targetEnvironmentId: target.id,
          journeyId: journey.id,
        },
        user.id,
      );

      const { run: evaluatedRun, preflightResult } = await service.evaluateRunPreflight(
        workspace.id,
        run.id,
        user.id,
      );

      expect(preflightResult.status).toBe('ready');
      expect(evaluatedRun.status).toBe('queued');
      expect(evaluatedRun.preflightStatus).toBe('ready');
    });
  });

  // ===========================================================================
  // 6. Secret Boundaries & Sanitization
  // ===========================================================================
  describe('6. Secret Boundaries & Sanitization', () => {
    it('detects and rejects prohibited secret fields in payloads', () => {
      const safe = { targetUrl: 'https://example.com', allowedOrigins: ['https://example.com'] };
      expect(scanForSecrets(safe).containsSecrets).toBe(false);

      const withPassword = { targetUrl: 'https://example.com', password: 'plain-text-secret' };
      expect(scanForSecrets(withPassword).containsSecrets).toBe(true);

      const withBearer = { apiKey: 'secret-key-123' };
      expect(scanForSecrets(withBearer).containsSecrets).toBe(true);

      const withNestedCookie = { meta: { authCookie: 'session=123' } };
      expect(scanForSecrets(withNestedCookie).containsSecrets).toBe(true);

      expect(() => assertNoSecrets(withPassword)).toThrow(/violates secret boundary/);
    });

    it('fake secret provider safely resolves references in-memory', async () => {
      const provider = new FakeSecretProvider({
        'vault:test-creds': 'user:pass',
      });

      expect(await provider.hasSecret('vault:test-creds')).toBe(true);
      expect(await provider.hasSecret('vault:nonexistent')).toBe(false);
      expect(await provider.getSecret('vault:test-creds')).toBe('user:pass');
    });
  });

  // ===========================================================================
  // 7. Audit Trail Logging
  // ===========================================================================
  describe('7. Audit Trail Logging', () => {
    it('records immutable audit events for critical tenant lifecycle events', async () => {
      const user = await service.createUser({ name: 'Alice', email: 'alice@audit.test' });
      const { workspace } = await service.createWorkspace({ name: 'Audit WS', slug: 'audit-ws', ownerUserId: user.id });
      const project = await service.createProject({ workspaceId: workspace.id, name: 'Project 1' }, user.id);

      const audits = await service.listAuditEvents(workspace.id, user.id);
      expect(audits.length).toBeGreaterThanOrEqual(2);

      const eventTypes = audits.map((a) => a.eventType);
      expect(eventTypes).toContain('workspace.created');
      expect(eventTypes).toContain('project.created');

      // Verify audit events contain safe metadata only
      for (const a of audits) {
        expect(a.schemaVersion).toBe('1.0');
        expect(a.workspaceId).toBe(workspace.id);
        expect(a.actorUserId).toBe(user.id);
        expect(scanForSecrets(a.metadata).containsSecrets).toBe(false);
      }
    });
  });

  // ===========================================================================
  // 8. Product REST API Endpoints & Ownership Enforcement
  // ===========================================================================
  describe('8. Product REST API Endpoints & Ownership Enforcement', () => {
    let apiServer: ProductApiServer;
    let ownerUser: any;
    let foreignUser: any;
    let workspace: any;
    let project: any;

    beforeEach(async () => {
      ownerUser = await service.createUser({ name: 'API Owner', email: 'api-owner@example.test' });
      foreignUser = await service.createUser({ name: 'Foreign User', email: 'foreign@example.test' });

      const wsRes = await service.createWorkspace({
        name: 'API Workspace',
        slug: 'api-ws',
        ownerUserId: ownerUser.id,
      });
      workspace = wsRes.workspace;

      project = await service.createProject(
        { workspaceId: workspace.id, name: 'API Storefront' },
        ownerUser.id,
      );

      apiServer = createProductApiServer({
        service,
        port: 0,
        defaultUserId: ownerUser.id,
      });
      await apiServer.start();
    });

    afterEach(async () => {
      await apiServer.stop();
    });

    it('GET /health returns 200 OK with expected version and mode', async () => {
      const res = await fetch(`${apiServer.url}/health`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe('ok');
      expect(data.mode).toBe('hosted-mvp-foundation');
    });

    it('GET /api/v1/workspaces lists workspaces for authenticated user', async () => {
      const res = await fetch(`${apiServer.url}/api/v1/workspaces`, {
        headers: { 'X-User-Id': ownerUser.id },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.workspaces).toHaveLength(1);
      expect(json.data.workspaces[0].id).toBe(workspace.id);
    });

    it('POST /api/v1/workspaces creates a new workspace', async () => {
      const res = await fetch(`${apiServer.url}/api/v1/workspaces`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Id': ownerUser.id,
        },
        body: JSON.stringify({ name: 'New WS', slug: 'new-ws' }),
      });
      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.slug).toBe('new-ws');
    });

    it('GET /api/v1/projects lists projects for workspace', async () => {
      const res = await fetch(`${apiServer.url}/api/v1/projects?workspaceId=${workspace.id}`, {
        headers: { 'X-User-Id': ownerUser.id },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.projects).toHaveLength(1);
      expect(json.data.projects[0].name).toBe('API Storefront');
    });

    it('refuses cross-workspace access via API with 403 Forbidden', async () => {
      // Foreign user attempts to list projects from API Workspace
      const res = await fetch(`${apiServer.url}/api/v1/projects?workspaceId=${workspace.id}`, {
        headers: { 'X-User-Id': foreignUser.id },
      });
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('FORBIDDEN');
    });

    it('refuses requests missing actor identity with 401 Unauthorized', async () => {
      // Create server without defaultUserId
      const strictServer = createProductApiServer({ service, port: 0 });
      await strictServer.start();
      try {
        const res = await fetch(`${strictServer.url}/api/v1/workspaces`);
        expect(res.status).toBe(401);
      } finally {
        await strictServer.stop();
      }
    });
  });

  // ===========================================================================
  // 9. Rehearsal Demonstration & Zero Browser Invariants
  // ===========================================================================
  describe('9. Rehearsal Demonstration & Zero Browser Invariants', () => {
    it('executes end-to-end product foundation rehearsal without launching a browser', async () => {
      const result = await runProductFoundationRehearsal();
      expect(result.success).toBe(true);
      expect(result.workspace.name).toBe('Acme QA Workspace');
      expect(result.project.name).toBe('Storefront Web App');
      expect(result.target.environment).toBe('local');
      expect(result.preflight.status).toBe('ready');
      expect(result.run.status).toBe('queued');
      expect(result.run.preflightStatus).toBe('ready');
      expect(result.auditEvents.length).toBeGreaterThanOrEqual(4);
    });

    it('rehearsal correctly refuses non-local target when authorization is missing', async () => {
      const result = await runProductFoundationRehearsal({ forceRefusal: true });
      expect(result.success).toBe(false);
      expect(result.preflight.status).toBe('blocked');
      expect(result.run.status).toBe('blocked');
      expect(result.run.blockedReason).toContain('AUTHORIZATION_REFERENCE');
    });
  });

  // ===========================================================================
  // 10. Non-Negotiable Trust Invariants
  // ===========================================================================
  describe('10. Non-Negotiable Trust Invariants', () => {
    it('guarantees candidate references strictly preserve confirmed: false and confirmedBug: false', async () => {
      const user = await service.createUser({ name: 'Owner', email: 'inv@test.com' });
      const { workspace } = await service.createWorkspace({ name: 'WS', slug: 'ws-inv', ownerUserId: user.id });
      const project = await service.createProject({ workspaceId: workspace.id, name: 'P' }, user.id);
      const target = await service.createTarget(
        {
          workspaceId: workspace.id,
          projectId: project.id,
          name: 'T',
          environment: 'local',
          targetUrl: 'http://127.0.0.1:4000',
          allowedOrigins: ['http://127.0.0.1:4000'],
        },
        user.id,
      );
      const journey = await service.approveJourney(
        {
          workspaceId: workspace.id,
          projectId: project.id,
          targetEnvironmentId: target.id,
          goal: 'g',
          origin: target.targetOrigin,
          allowedActions: ['navigate'],
        },
        user.id,
      );
      const run = await service.createRun(
        {
          workspaceId: workspace.id,
          projectId: project.id,
          targetEnvironmentId: target.id,
          journeyId: journey.id,
        },
        user.id,
      );

      const candidate = await service.registerCandidate(
        {
          workspaceId: workspace.id,
          projectId: project.id,
          runId: run.id,
          candidateId: 'cand-001',
          ruleId: 'HTTP_5XX',
          classification: 'novel',
          reproduced: true,
        },
        user.id,
      );

      expect(candidate.confirmed).toBe(false);
      expect(candidate.confirmedBug).toBe(false);

      // Verify safe-test mode invariant on run
      expect(run.safeTestMode).toBe(true);
    });
  });
});
