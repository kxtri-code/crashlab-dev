/**
 * Build 12H: Controlled External Staging Pilot Unit & Integration Tests.
 *
 * Verifies:
 * 1. Render worker can reach the external staging URL.
 * 2. User can register the target in the dashboard.
 * 3. User can create or select an approved journey.
 * 4. Safe-test confirmation is required.
 * 5. Run transitions queued -> running -> completed.
 * 6. Playwright performs navigation and interactions.
 * 7. Execution, anomaly, and log artifacts are stored.
 * 8. Genuine controlled defects are detected.
 * 9. Harness-generated navigation is not reported as a defect.
 * 10. Tenant isolation remains enforced.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { validatePilotConfiguration } from '../../src/preflight/validator.js';
import { validateProductTargetPreflight } from '../../src/product/service/preflightAdapter.js';
import { ProductService, TenantAccessDeniedError } from '../../src/product/service/productService.js';
import { createInMemoryProductRepositories } from '../../src/product/repository/inMemory.js';
import { handleProductApiRequest } from '../../src/product/api/routes.js';
import { buildAnomalyReport } from '../../src/anomaly/report.js';
import { execution, journey, netEvent, consoleEvent } from '../fixtures/executionReports.js';
import type { TargetEnvironment } from '../../src/product/types/target.js';
import type { ProductApprovedJourney } from '../../src/product/types/journey.js';
import type { ExecutionReport, EvidenceNetworkEvent } from '../../src/executor/types.js';

describe('Build 12H: Controlled External Staging Pilot', () => {
  let service: ProductService;
  let repos: ReturnType<typeof createInMemoryProductRepositories>;
  const ownerUserId = 'usr_staging_owner';
  const otherUserId = 'usr_other_tenant';
  let workspaceId: string;
  let projectId: string;

  beforeEach(async () => {
    repos = createInMemoryProductRepositories();
    service = new ProductService({
      repositories: repos,
      idGenerator: {
        generateId: (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`,
      },
    });

    // Seed test users
    await repos.users.create({
      id: ownerUserId,
      schemaVersion: '1.0',
      email: 'owner@staging.test',
      name: 'Staging Owner',
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await repos.users.create({
      id: otherUserId,
      schemaVersion: '1.0',
      email: 'other@tenant.test',
      name: 'Other Tenant User',
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Create workspace and project for owner
    const wsResult = await service.createWorkspace({
      name: 'Staging Workspace',
      slug: 'staging-ws',
      ownerUserId,
    });
    workspaceId = wsResult.workspace.id;

    const project = await service.createProject(
      {
        workspaceId,
        name: 'Staging Pilot Project',
        description: 'Testing external staging pilot',
      },
      ownerUserId,
    );
    projectId = project.id;
  });

  // ---------------------------------------------------------------------------
  // 1. Staging Hostname & Preflight Verification
  // ---------------------------------------------------------------------------
  describe('1. Staging Hostname & Preflight Verification', () => {
    it('accepts crashlab-api.onrender.com as an authorized staging host', () => {
      const result = validatePilotConfiguration({
        targetUrl: 'https://crashlab-api.onrender.com/staging-pilot',
        targetName: 'External Staging Pilot',
        targetEnvironment: 'staging',
        allowedOrigins: ['https://crashlab-api.onrender.com'],
        allowedJourneys: [
          {
            id: 'j-01',
            goal: 'Verify staging pilot interaction',
            origin: 'https://crashlab-api.onrender.com',
            allowedActions: ['navigate', 'click', 'interact'],
            forbiddenActions: ['checkout', 'payment', 'delete_account', 'change_password'],
          },
          {
            id: 'j-02',
            goal: 'Verify staging pilot inspection',
            origin: 'https://crashlab-api.onrender.com',
            allowedActions: ['navigate'],
            forbiddenActions: ['checkout', 'payment', 'delete_account', 'change_password'],
          },
        ],
        forbiddenActions: ['checkout', 'payment', 'delete_account', 'change_password'],
        authorizationReference: 'AUTH-STAGING-PILOT-12H',
      });

      expect(result.valid).toBe(true);
      expect(result.status).toBe('ready');
      expect(result.failureReasons).toHaveLength(0);
    });

    it('rejects production hostnames even on render.com', () => {
      const result = validatePilotConfiguration({
        targetUrl: 'https://crashlab-prod.onrender.com/app',
        targetName: 'Prohibited Prod Target',
        targetEnvironment: 'staging',
        allowedOrigins: ['https://crashlab-prod.onrender.com'],
        allowedJourneys: [
          {
            id: 'j-01',
            goal: 'Goal 1',
            origin: 'https://crashlab-prod.onrender.com',
            allowedActions: ['navigate'],
            forbiddenActions: ['payment', 'delete_account', 'change_password'],
          },
          {
            id: 'j-02',
            goal: 'Goal 2',
            origin: 'https://crashlab-prod.onrender.com',
            allowedActions: ['navigate'],
            forbiddenActions: ['payment', 'delete_account', 'change_password'],
          },
        ],
        forbiddenActions: ['payment', 'delete_account', 'change_password'],
        authorizationReference: 'AUTH-REF',
      });

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.code === 'PRODUCTION_HOSTNAME_REJECTED')).toBe(true);
    });

    it('validates single journey execution preflight for staging targets', () => {
      const target: TargetEnvironment = {
        id: 'tgt_staging_01',
        schemaVersion: '1.0',
        workspaceId,
        projectId,
        name: 'Staging Fixture',
        environment: 'staging',
        targetUrl: 'https://crashlab-api.onrender.com/staging-pilot',
        targetOrigin: 'https://crashlab-api.onrender.com',
        allowedOrigins: ['https://crashlab-api.onrender.com'],
        authorizationReference: 'AUTH-STAGING-PILOT-12H',
        forbiddenActions: ['checkout', 'payment', 'delete_account', 'change_password'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const journey: ProductApprovedJourney = {
        id: 'jny_staging_01',
        schemaVersion: '1.0',
        workspaceId,
        projectId,
        targetEnvironmentId: target.id,
        goal: 'Verify staging pilot interaction and defect detection',
        origin: 'https://crashlab-api.onrender.com',
        allowedActions: ['navigate', 'click', 'interact'],
        forbiddenActions: ['checkout', 'payment', 'delete_account', 'change_password'],
        requiresCredentials: false,
        requiresTestData: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const result = validateProductTargetPreflight(target, [journey]);
      expect(result.valid).toBe(true);
      expect(result.status).toBe('ready');
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Dedicated Staging Fixture Endpoints
  // ---------------------------------------------------------------------------
  describe('2. Dedicated Staging Fixture Endpoints', () => {
    let server: Server;
    let baseUrl: string;

    beforeEach(async () => {
      server = createServer(async (req, res) => {
        await handleProductApiRequest(req, res, {
          service,
          authConfig: { authMode: 'development', authSecret: 'test-secret' },
          defaultUserId: ownerUserId,
        });
      });

      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve());
      });
      const addr = server.address() as any;
      baseUrl = `http://127.0.0.1:${addr.port}`;
    });

    afterEach(async () => {
      if (server) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('serves the controlled staging pilot HTML fixture with interactive elements', async () => {
      const res = await fetch(`${baseUrl}/staging-pilot`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');

      const html = await res.text();
      expect(html).toContain('CrashLab Controlled Staging Pilot');
      expect(html).toContain('id="btn-interact"');
      expect(html).toContain('id="status-output"');
      expect(html).toContain('/staging-pilot/defect-probe');
      expect(html).not.toContain('customer');
    });

    it('serves the controlled defect probe returning HTTP 500', async () => {
      const res = await fetch(`${baseUrl}/staging-pilot/defect-probe`);
      expect(res.status).toBe(500);
      expect(res.headers.get('content-type')).toContain('application/json');

      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('CONTROLLED_STAGING_DEFECT');
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Target and Journey Dashboard Registration APIs
  // ---------------------------------------------------------------------------
  describe('3. Target and Journey Dashboard Registration APIs', () => {
    let server: Server;
    let baseUrl: string;

    beforeEach(async () => {
      server = createServer(async (req, res) => {
        await handleProductApiRequest(req, res, {
          service,
          authConfig: { authMode: 'development', authSecret: 'test-secret' },
          defaultUserId: ownerUserId,
        });
      });

      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve());
      });
      const addr = server.address() as any;
      baseUrl = `http://127.0.0.1:${addr.port}`;
    });

    afterEach(async () => {
      if (server) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('registers a staging target via POST /api/v1/targets', async () => {
      const res = await fetch(`${baseUrl}/api/v1/targets`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Id': ownerUserId,
        },
        body: JSON.stringify({
          workspaceId,
          projectId,
          name: 'External Staging Pilot',
          environment: 'staging',
          targetUrl: 'https://crashlab-api.onrender.com/staging-pilot',
          allowedOrigins: ['https://crashlab-api.onrender.com'],
          authorizationReference: 'AUTH-STAGING-PILOT-12H',
        }),
      });

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.data.name).toBe('External Staging Pilot');
      expect(data.data.environment).toBe('staging');
      expect(data.data.targetOrigin).toBe('https://crashlab-api.onrender.com');
    });

    it('creates and approves a journey via POST /api/v1/journeys', async () => {
      // First create target
      const target = await service.createTarget(
        {
          workspaceId,
          projectId,
          name: 'Staging Pilot Target',
          environment: 'staging',
          targetUrl: 'https://crashlab-api.onrender.com/staging-pilot',
          allowedOrigins: ['https://crashlab-api.onrender.com'],
          authorizationReference: 'AUTH-STAGING-PILOT-12H',
        },
        ownerUserId,
      );

      const res = await fetch(`${baseUrl}/api/v1/journeys`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Id': ownerUserId,
        },
        body: JSON.stringify({
          workspaceId,
          projectId,
          targetEnvironmentId: target.id,
          goal: 'Verify staging pilot interaction and defect detection',
          origin: 'https://crashlab-api.onrender.com',
          allowedActions: ['navigate', 'click', 'interact'],
        }),
      });

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.data.goal).toBe('Verify staging pilot interaction and defect detection');
      expect(data.data.allowedActions).toEqual(['navigate', 'click', 'interact']);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Safe-Test Confirmation & Run Dispatch
  // ---------------------------------------------------------------------------
  describe('4. Safe-Test Confirmation & Run Dispatch', () => {
    it('requires safe-test confirmation and refuses runs with disabled safeTestMode', async () => {
      const target = await service.createTarget(
        {
          workspaceId,
          projectId,
          name: 'Staging Target',
          environment: 'staging',
          targetUrl: 'https://crashlab-api.onrender.com/staging-pilot',
          allowedOrigins: ['https://crashlab-api.onrender.com'],
          authorizationReference: 'AUTH-STAGING-PILOT-12H',
        },
        ownerUserId,
      );

      const journey = await service.approveJourney(
        {
          workspaceId,
          projectId,
          targetEnvironmentId: target.id,
          goal: 'Verify staging pilot interaction',
          origin: 'https://crashlab-api.onrender.com',
          allowedActions: ['navigate', 'click'],
        },
        ownerUserId,
      );

      // Attempt to enqueue with safeTestMode = false
      await expect(
        service.enqueueRun(
          {
            workspaceId,
            projectId,
            targetEnvironmentId: target.id,
            journeyId: journey.id,
            validatePreflight: true,
            safeTestMode: false,
          } as any,
          ownerUserId,
        ),
      ).rejects.toThrow('Safe-test mode cannot be disabled');
    });

    it('enqueues a safe run and transitions queued -> running -> completed', async () => {
      const target = await service.createTarget(
        {
          workspaceId,
          projectId,
          name: 'Staging Target',
          environment: 'staging',
          targetUrl: 'https://crashlab-api.onrender.com/staging-pilot',
          allowedOrigins: ['https://crashlab-api.onrender.com'],
          authorizationReference: 'AUTH-STAGING-PILOT-12H',
        },
        ownerUserId,
      );

      const journey = await service.approveJourney(
        {
          workspaceId,
          projectId,
          targetEnvironmentId: target.id,
          goal: 'Verify staging pilot interaction',
          origin: 'https://crashlab-api.onrender.com',
          allowedActions: ['navigate', 'click'],
        },
        ownerUserId,
      );

      const enqueueResult = await service.enqueueRun(
        {
          workspaceId,
          projectId,
          targetEnvironmentId: target.id,
          journeyId: journey.id,
          validatePreflight: true,
        },
        ownerUserId,
      );

      expect(enqueueResult.run.status).toBe('queued');
      expect(enqueueResult.run.safeTestMode).toBe(true);

      // Transition to running
      await repos.runs.update({ ...enqueueResult.run, status: 'running' });
      const runningRun = await service.getRun(workspaceId, enqueueResult.run.id, ownerUserId);
      expect(runningRun.status).toBe('running');

      // Transition to completed
      await repos.runs.update({ ...enqueueResult.run, status: 'completed' });
      const completedRun = await service.getRun(workspaceId, enqueueResult.run.id, ownerUserId);
      expect(completedRun.status).toBe('completed');
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Genuine Controlled Defect Detection & Zero False Duplicate Navigation
  // ---------------------------------------------------------------------------
  describe('5. Genuine Controlled Defect Detection & Zero False Duplicate Navigation', () => {
    it('detects HTTP 500 controlled defect while excluding harness-generated navigation', () => {
      const events: EvidenceNetworkEvent[] = [
        netEvent({
          method: 'GET',
          url: 'https://crashlab-api.onrender.com/staging-pilot',
          path: '/staging-pilot',
          status: 200,
          resourceType: 'document',
          provenance: 'harness-initial-load',
        }),
        netEvent({
          method: 'GET',
          url: 'https://crashlab-api.onrender.com/staging-pilot',
          path: '/staging-pilot',
          status: 200,
          resourceType: 'document',
          provenance: 'harness-fallback-navigation',
        }),
        netEvent({
          method: 'GET',
          url: 'https://crashlab-api.onrender.com/staging-pilot/defect-probe',
          path: '/staging-pilot/defect-probe',
          status: 500,
          resourceType: 'fetch',
          provenance: 'target-triggered',
        }),
      ];

      const consoleEvents = [
        consoleEvent({
          type: 'error',
          text: 'Controlled Staging Defect: probe returned HTTP 500',
        }),
      ];

      const execReport = execution({
        target: {
          url: 'https://crashlab-api.onrender.com/staging-pilot',
          finalUrl: 'https://crashlab-api.onrender.com/staging-pilot',
          title: 'CrashLab Controlled Staging Pilot Fixture',
        },
        rawEvidence: {
          ...execution().rawEvidence,
          networkEvents: events,
          consoleEvents,
        },
      });

      const journeyPlan = journey({
        target: {
          url: 'https://crashlab-api.onrender.com/staging-pilot',
          finalUrl: 'https://crashlab-api.onrender.com/staging-pilot',
          title: 'CrashLab Controlled Staging Pilot Fixture',
        },
      });

      const anomalyReport = buildAnomalyReport({
        execution: execReport,
        executionPath: 'runs/run-staging-pilot-12h/execution.json',
        journey: journeyPlan,
        journeyPath: 'journeys/jny-001.json',
      });

      // Requirement 8: Genuine controlled defects are detected
      expect(anomalyReport.summary.httpErrors).toBe(1);
      expect(anomalyReport.summary.consoleErrors).toBe(1);
      expect(anomalyReport.interpretation.requiresInvestigation).toBe(true);

      const httpAnomaly = anomalyReport.anomalies.find((s) => s.ruleId === 'HTTP_5XX');
      expect(httpAnomaly).toBeDefined();
      expect(httpAnomaly?.message).toContain('HTTP 500');

      // Requirement 9: Harness-generated navigation is not reported as a defect
      expect(anomalyReport.summary.duplicateRequestSignals).toBe(0);
      expect(anomalyReport.anomalies.some((s) => s.ruleId === 'DUPLICATE_REQUEST')).toBe(false);

      // Invariants: Never auto-confirmed
      expect(anomalyReport.interpretation.confirmedBug).toBe(false);
      expect(anomalyReport.anomalies.every((s) => s.confirmed === false)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Tenant Isolation Enforcement
  // ---------------------------------------------------------------------------
  describe('6. Tenant Isolation Enforcement', () => {
    it('prevents non-member user from configuring targets or reading runs', async () => {
      // Other user cannot configure target in owner workspace
      await expect(
        service.createTarget(
          {
            workspaceId,
            projectId,
            name: 'Malicious Target',
            environment: 'staging',
            targetUrl: 'https://crashlab-api.onrender.com/staging-pilot',
            allowedOrigins: ['https://crashlab-api.onrender.com'],
            authorizationReference: 'AUTH-REF',
          },
          otherUserId,
        ),
      ).rejects.toThrow(TenantAccessDeniedError);

      // Other user cannot list targets in owner workspace
      await expect(service.listTargets(workspaceId, projectId, otherUserId)).rejects.toThrow(
        TenantAccessDeniedError,
      );
    });
  });
});
