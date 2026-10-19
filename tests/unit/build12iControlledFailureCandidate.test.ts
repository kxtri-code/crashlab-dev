/**
 * Build 12I Unit Tests: Controlled-Failure Journey Candidate Anomaly Detection.
 *
 * Verifies that:
 * 1. A controlled-failure journey targets the staging pilot interaction (#btn-interact).
 * 2. HTTP 500 signal from /staging-pilot/defect-probe is captured in execution evidence.
 * 3. The anomaly engine classifies the HTTP 500 signal as an HTTP_5XX anomaly.
 * 4. The candidate report builder creates a candidate anomaly for the HTTP_5XX defect.
 * 5. Invariants confirmed: false and confirmedBug: false are strictly preserved.
 * 6. The worker packages the candidate report as a 'candidates' artifact.
 * 7. The queue dispatcher registers candidate references in the database repository and updates candidatesReportRef.
 * 8. The run queue lease is released after completion.
 * 9. The API endpoints GET /api/v1/runs/:runId/candidates and GET /api/v1/runs/:runId expose the candidates and counts accurately.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { createInMemoryProductRepositories } from '../../src/product/repository/inMemory.js';
import { LocalBlobStore } from '../../src/product/blob/localStore.js';
import { RunDispatcher } from '../../src/product/queue/dispatcher.js';
import { ProductService } from '../../src/product/service/productService.js';
import { handleProductApiRequest } from '../../src/product/api/routes.js';
import { buildAnomalyReport } from '../../src/anomaly/report.js';
import { buildCandidateReport } from '../../src/review/candidateReport.js';
import type { JourneyPlan } from '../../src/journey/types.js';
import type { ExecutionReport } from '../../src/executor/types.js';
import type { TargetEnvironment } from '../../src/product/types/target.js';
import type { ProductApprovedJourney } from '../../src/product/types/journey.js';
import type { TestRun } from '../../src/product/types/run.js';
import type { ExecutionWorker, ExecutionWorkerInput, ExecutionWorkerResult } from '../../src/product/queue/worker.js';

describe('Build 12I: Controlled-Failure Journey Candidate Detection and Invariants', () => {
  let tempDir: string;
  let repos: ReturnType<typeof createInMemoryProductRepositories>;
  let blobStore: LocalBlobStore;
  let service: ProductService;

  const workspaceId = 'ws_pilot_12i_test';
  const projectId = 'prj_pilot_12i_test';
  const targetId = 'tgt_staging_pilot_test';
  const journeyId = 'jny_defect_probe_test';
  const runId = 'run_controlled_failure_001';
  const ownerUserId = 'usr_pilot_owner';

  const stagingTarget: TargetEnvironment = {
    id: targetId,
    schemaVersion: '1.0',
    workspaceId,
    projectId,
    name: 'Staging Pilot Target',
    targetUrl: 'http://127.0.0.1:8080/staging-pilot',
    targetOrigin: 'http://127.0.0.1:8080',
    allowedOrigins: ['http://127.0.0.1:8080'],
    environment: 'local',
    forbiddenActions: ['payment', 'checkout'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const stagingJourney: ProductApprovedJourney = {
    id: journeyId,
    schemaVersion: '1.0',
    workspaceId,
    projectId,
    targetEnvironmentId: targetId,
    goal: 'Verify staging pilot interaction and defect detection',
    origin: 'http://127.0.0.1:8080',
    allowedActions: ['navigate', 'click', 'interact'],
    forbiddenActions: ['checkout', 'payment'],
    requiresCredentials: false,
    requiresTestData: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'crashlab-cand-test-'));
    repos = createInMemoryProductRepositories();
    blobStore = new LocalBlobStore({ rootDirectory: tempDir });
    service = new ProductService({
      repositories: repos,
      blobStore,
    });

    // Seed tenant and access
    await repos.users.create({
      id: ownerUserId,
      schemaVersion: '1.0',
      email: 'owner@crashlab.internal',
      name: 'Pilot Owner',
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await repos.workspaces.create({
      id: workspaceId,
      schemaVersion: '1.0',
      slug: 'pilot-12i',
      name: 'Pilot 12I Workspace',
      ownerUserId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await repos.memberships.create({
      id: 'mem_owner',
      schemaVersion: '1.0',
      workspaceId,
      userId: ownerUserId,
      role: 'owner',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await repos.projects.create({
      id: projectId,
      schemaVersion: '1.0',
      workspaceId,
      name: 'Pilot Project',
      description: 'Pilot Project Description',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await repos.targets.create(stagingTarget);
    await repos.journeys.create(stagingJourney);
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('proves that a controlled failure journey targeting #btn-interact produces an HTTP_5XX candidate anomaly with confirmed: false', async () => {
    // 1. Build journey plan targeting #btn-interact
    const plan: JourneyPlan = {
      schemaVersion: '1.0',
      goal: 'Verify staging pilot interaction and defect detection',
      normalizedGoal: 'verify staging pilot interaction and defect detection',
      journeyType: 'navigation',
      target: {
        url: 'http://127.0.0.1:8080/staging-pilot',
        finalUrl: 'http://127.0.0.1:8080/staging-pilot',
        title: 'Staging Pilot Target',
      },
      steps: [
        {
          id: 'step-001',
          order: 1,
          intent: 'navigate_to_target',
          action: 'navigate',
          description: 'Navigate to target http://127.0.0.1:8080/staging-pilot',
          targetElementIds: [],
          locatorCandidates: [],
          expectedOutcome: 'Page loads successfully',
          confidence: 1,
          executable: false,
          source: { report: 'scout', elementIds: [] },
          isFallback: false,
        },
        {
          id: 'step-002',
          order: 2,
          intent: 'trigger_interaction',
          action: 'click',
          description: 'Trigger staging pilot interaction and controlled probe',
          targetElementIds: ['btn-interact'],
          locatorCandidates: ['#btn-interact', 'button#btn-interact'],
          expectedOutcome: 'Staging pilot responds to interaction and triggers controlled probe',
          confidence: 1,
          executable: false,
          source: { report: 'scout', elementIds: ['btn-interact'] },
          isFallback: false,
        },
      ],
      assumptions: [],
      warnings: [],
      missingInformation: [],
      planner: { mode: 'heuristic', version: '0.1.0' },
    };

    // 2. Mock execution capturing the HTTP 500 defect probe response and console log
    const execReport: ExecutionReport = {
      schemaVersion: '1.0',
      journeyPlanSchemaVersion: '1.0',
      journeyReport: `journeys/${journeyId}.json`,
      goal: 'Verify staging pilot interaction and defect detection',
      journeyType: 'navigation',
      status: 'passed',
      target: {
        url: 'http://127.0.0.1:8080/staging-pilot',
        finalUrl: 'http://127.0.0.1:8080/staging-pilot',
        title: 'Staging Pilot Target',
      },
      verification: null,
      warnings: [],
      blockedSteps: [],
      redaction: {
        sensitiveValuesRedacted: false,
        redactedValueCount: 0,
        dataProvidedKeys: [],
        dataProvided: false,
        screenshotsOmittedAfterSensitiveData: false,
      },
      executor: {
        mode: 'deterministic',
        version: '0.1.0',
        retries: 0,
        stoppedOnFailure: false,
        continueOnFailure: false,
        safeTestMode: true,
      },
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 500,
      stepCounts: { total: 2, passed: 2, failed: 0, blocked: 0, skipped: 0 },
      steps: [
        {
          id: 'step-001',
          order: 1,
          intent: 'navigate_to_target',
          action: 'navigate',
          status: 'passed',
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: 40,
          selectedLocator: null,
          targetElementIds: [],
          urlBefore: 'http://127.0.0.1:8080/staging-pilot',
          urlAfter: 'http://127.0.0.1:8080/staging-pilot',
          observations: null,
          evidence: {
            screenshot: null,
            screenshotOmitted: true,
            screenshotOmittedReason: 'test-mode',
            consoleEvents: [],
            pageErrors: [],
            networkEvents: [
              {
                method: 'GET',
                url: 'http://127.0.0.1:8080/staging-pilot',
                path: '/staging-pilot',
                status: 200,
                resourceType: 'document',
                durationMs: 50,
                thirdParty: false,
                failure: null,
                provenance: 'harness-initial-load',
              },
            ],
            dialogObserved: false,
            pageChanged: false,
          },
          error: null,
          skipReason: null,
          verification: null,
          assertion: null,
          postconditions: null,
          expectationResults: null,
          description: 'Navigate to target',
          planConfidence: 1,
        },
        {
          id: 'step-002',
          order: 2,
          intent: 'trigger_interaction',
          action: 'click',
          status: 'passed',
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: 460,
          selectedLocator: '#btn-interact',
          targetElementIds: ['btn-interact'],
          urlBefore: 'http://127.0.0.1:8080/staging-pilot',
          urlAfter: 'http://127.0.0.1:8080/staging-pilot',
          observations: { exists: true, visible: true, enabled: true, tag: 'button', matchCount: 1 },
          evidence: {
            screenshot: null,
            screenshotOmitted: true,
            screenshotOmittedReason: 'test-mode',
            consoleEvents: [
              {
                type: 'log',
                text: 'Staging interaction triggered by test runner',
                url: 'http://127.0.0.1:8080/staging-pilot',
                line: 105,
              },
              {
                type: 'error',
                text: 'Controlled Staging Defect: probe returned HTTP 500',
                url: 'http://127.0.0.1:8080/staging-pilot',
                line: 112,
              },
            ],
            pageErrors: [],
            networkEvents: [
              {
                method: 'GET',
                url: 'http://127.0.0.1:8080/staging-pilot/defect-probe',
                path: '/staging-pilot/defect-probe',
                status: 500,
                resourceType: 'xhr',
                durationMs: 45,
                thirdParty: false,
                failure: null,
                provenance: 'target-triggered',
              },
            ],
            dialogObserved: false,
            pageChanged: false,
          },
          error: null,
          skipReason: null,
          verification: null,
          assertion: null,
          postconditions: null,
          expectationResults: null,
          description: 'Trigger staging pilot interaction and controlled probe',
          planConfidence: 1,
        },
      ],
      rawEvidence: {
        consoleEvents: [
          {
            type: 'log',
            text: 'Staging interaction triggered by test runner',
            url: 'http://127.0.0.1:8080/staging-pilot',
            line: 105,
          },
          {
            type: 'error',
            text: 'Controlled Staging Defect: probe returned HTTP 500',
            url: 'http://127.0.0.1:8080/staging-pilot',
            line: 112,
          },
        ],
        pageErrors: [],
        networkEvents: [
          {
            method: 'GET',
            url: 'http://127.0.0.1:8080/staging-pilot',
            path: '/staging-pilot',
            status: 200,
            resourceType: 'document',
            durationMs: 50,
            thirdParty: false,
            failure: null,
            provenance: 'harness-initial-load',
          },
          {
            method: 'GET',
            url: 'http://127.0.0.1:8080/staging-pilot/defect-probe',
            path: '/staging-pilot/defect-probe',
            status: 500,
            resourceType: 'xhr',
            durationMs: 45,
            thirdParty: false,
            failure: null,
            provenance: 'target-triggered',
          },
        ],
        screenshots: [],
      },
      environment: null,
    };

    // 3. Build anomaly report
    const anomalyReport = buildAnomalyReport({
      execution: execReport,
      executionPath: `runs/${runId}/execution.json`,
      journey: plan,
      journeyPath: `journeys/${journeyId}.json`,
    });

    expect(anomalyReport.summary.totalSignals).toBeGreaterThanOrEqual(1);
    const http500Anomaly = anomalyReport.anomalies.find((a) => a.ruleId === 'HTTP_5XX');
    expect(http500Anomaly).toBeDefined();
    expect(http500Anomaly?.status).toBe('observed');
    expect(http500Anomaly?.details?.statusCode).toBe(500);

    // 4. Build candidate defect report
    const candidateReport = buildCandidateReport({
      journey: plan,
      execution: execReport,
      anomalies: anomalyReport,
      baseline: null,
      reproduction: null,
      paths: {
        execution: `runs/${runId}/execution.json`,
        anomalies: `runs/${runId}/anomalies.json`,
        reproduction: null,
        journey: `journeys/${journeyId}.json`,
      },
    });

    expect(candidateReport.candidates.length).toBeGreaterThanOrEqual(1);
    const candidateDefect = candidateReport.candidates.find((c) => c.ruleId === 'HTTP_5XX');
    expect(candidateDefect).toBeDefined();
    expect(candidateDefect?.confirmed).toBe(false);

    // 5. Build worker result simulating PlaywrightExecutionWorker output
    const mockWorker: ExecutionWorker = {
      executeRun: async () => ({
        status: 'completed',
        passedSteps: 2,
        totalSteps: 2,
        artifacts: [
          {
            type: 'execution',
            relativePath: `runs/${runId}/execution.json`,
            contentType: 'application/json',
            payload: Buffer.from(JSON.stringify(execReport, null, 2), 'utf8'),
          },
          {
            type: 'anomalies',
            relativePath: `runs/${runId}/anomalies.json`,
            contentType: 'application/json',
            payload: Buffer.from(JSON.stringify(anomalyReport, null, 2), 'utf8'),
          },
          {
            type: 'candidates',
            relativePath: `runs/${runId}/candidates.json`,
            contentType: 'application/json',
            payload: Buffer.from(JSON.stringify(candidateReport, null, 2), 'utf8'),
          },
          {
            type: 'log',
            relativePath: `runs/${runId}/execution.log`,
            contentType: 'text/plain',
            payload: Buffer.from(`[RUN ${runId}] Completed with ${candidateReport.candidates.length} candidates\n`, 'utf8'),
          },
        ],
        summary: {
          executionStatus: execReport.status,
          anomaliesCount: anomalyReport.summary.totalSignals,
          candidateCount: candidateReport.candidates.length,
          safeTestMode: true,
          confirmedBug: false,
        },
      }),
      cancelRun: async () => {},
      close: async () => {},
    };

    // 6. Setup queue and test run
    const testRun: TestRun = {
      id: runId,
      schemaVersion: '1.0',
      workspaceId,
      projectId,
      targetEnvironmentId: targetId,
      journeyId,
      status: 'queued',
      safeTestMode: true,
      preflightStatus: 'ready',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await repos.runs.create(testRun);

    const nowTs = new Date().toISOString();
    await repos.queue!.enqueue({
      runId,
      workspaceId,
      projectId,
      targetId,
      journeyId,
      queueStatus: 'queued',
      attemptCount: 1,
      maxAttempts: 1,
      availableAt: nowTs,
      leaseOwner: null,
      leaseExpiry: null,
      startedAt: null,
      completedAt: null,
      lastError: null,
      cancellationTimestamp: null,
      requestId: null,
      createdAt: nowTs,
      updatedAt: nowTs,
    });

    // 7. Dispatch the run using RunDispatcher
    const dispatcher = new RunDispatcher({
      queue: repos.queue!,
      repositories: repos,
      worker: mockWorker,
      blobStore,
      workerId: 'wrk_test_12i',
      leaseSeconds: 30,
    });

    const dispatchResult = await dispatcher.dispatchNext();
    expect(dispatchResult).not.toBeNull();
    expect(dispatchResult?.status).toBe('completed');

    // 8. Verify database state after run completion
    const savedRun = await repos.runs.findById(workspaceId, runId);
    expect(savedRun).not.toBeNull();
    expect(savedRun?.status).toBe('completed');
    expect(savedRun?.safeTestMode).toBe(true);
    expect(savedRun?.candidatesReportRef).toBeDefined();
    expect(savedRun?.anomalyReportRef).toBeDefined();

    // Verify queue lease is released
    const queueItem = await repos.queue!.findByRunId(workspaceId, runId);
    expect(queueItem?.queueStatus).toBe('completed');
    expect(queueItem?.leaseOwner).toBeNull();

    // Verify candidate references persisted in repository
    const storedCandidates = await repos.candidates.listByRun(workspaceId, runId);
    expect(storedCandidates.length).toBeGreaterThanOrEqual(1);

    const http5xxStored = storedCandidates.find((c) => c.ruleId === 'HTTP_5XX');
    expect(http5xxStored).toBeDefined();
    expect(http5xxStored?.confirmed).toBe(false);
    expect(http5xxStored?.confirmedBug).toBe(false);
    expect(http5xxStored?.reviewStatus).toBe('unreviewed');

    // 9. Verify REST API returns candidates and enriched counts
    let responseData: any = null;
    let statusCode = 0;

    const mockRes = {
      writeHead: (code: number) => {
        statusCode = code;
      },
      end: (content?: string) => {
        if (content) {
          try {
            responseData = JSON.parse(content);
          } catch {}
        }
      },
    } as any;

    // Test GET /api/v1/runs/:runId/candidates
    await handleProductApiRequest(
      {
        method: 'GET',
        url: `/api/v1/runs/${runId}/candidates?workspaceId=${workspaceId}`,
        headers: {
          'x-user-id': ownerUserId,
        },
      } as any,
      mockRes,
      {
        service,
        authConfig: { authMode: 'development', authSecret: 'test-secret-at-least-32-chars-long-012345' },
        defaultUserId: ownerUserId,
      },
    );

    expect(statusCode).toBe(200);
    expect(responseData?.success).toBe(true);
    expect(responseData?.data?.candidates?.length).toBeGreaterThanOrEqual(1);
    const apiCand = responseData.data.candidates.find((c: any) => c.ruleId === 'HTTP_5XX');
    expect(apiCand).toBeDefined();
    expect(apiCand.confirmed).toBe(false);
    expect(apiCand.confirmedBug).toBe(false);

    // Test GET /api/v1/runs/:runId
    await handleProductApiRequest(
      {
        method: 'GET',
        url: `/api/v1/runs/${runId}?workspaceId=${workspaceId}`,
        headers: {
          'x-user-id': ownerUserId,
        },
      } as any,
      mockRes,
      {
        service,
        authConfig: { authMode: 'development', authSecret: 'test-secret-at-least-32-chars-long-012345' },
        defaultUserId: ownerUserId,
      },
    );

    expect(statusCode).toBe(200);
    expect(responseData?.success).toBe(true);
    expect(responseData?.data?.candidateCount).toBeGreaterThanOrEqual(1);
    expect(responseData?.data?.anomalyCount).toBeGreaterThanOrEqual(1);
    expect(responseData?.data?.safeTestMode).toBe(true);
  });
});
