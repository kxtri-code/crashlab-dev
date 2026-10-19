/**
 * Unit Test Suite for Build 12K.1: Candidate Reproduction UX and Signal-State Accuracy.
 *
 * Requirements Tested:
 * 1. 4 explicit reproduction states: 'not-tested', 'reproduced', 'not-reproduced', 'inconclusive'.
 * 2. Bounded reproduction with strict maximum of 3 attempts.
 * 3. 3/3 reproduction classification and metrics.
 * 4. 0/3 non-reproduction classification and metrics.
 * 5. Incomplete / inconclusive reproduction (1/3 hits).
 * 6. Related signal grouping (HTTP 500 server cascade correlation).
 * 7. Duplicate review action guidance.
 * 8. Empty log detection & rich execution log with text/plain; charset=utf-8.
 * 9. formatArtifactSize preventing misleading "0 KB" for non-zero files.
 * 10. Strict preservation of trust invariants: confirmed: false, confirmedBug: false, safeTestMode: true, zero secrets in client code.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProductService } from '../../src/product/service/productService.js';
import { createInMemoryProductRepositories } from '../../src/product/repository/inMemory.js';
import { LocalBlobStore } from '../../src/product/blob/localStore.js';
import { analyzeSignalCorrelation } from '../../src/product/util/signalCorrelation.js';
import { formatArtifactSize, resolveArtifactExtension } from '../../src/product/dashboard/artifactUtils.js';
import { formatWorkerExecutionLog } from '../../src/product/worker/executionLog.js';
import { CLIENT_JS_BUNDLE } from '../../src/product/dashboard/clientBundle.js';
import type { CandidateReference } from '../../src/product/types/candidate.js';
import type { ReproductionReport, ReproductionInput } from '../../src/reproducer/types.js';
import type { ExecutionReport } from '../../src/executor/types.js';
import type { AnomalyReport } from '../../src/anomaly/report.js';

describe('Build 12K.1: Candidate Reproduction UX and Signal-State Accuracy', () => {
  let tempDir: string;
  let repos: ReturnType<typeof createInMemoryProductRepositories>;
  let blobStore: LocalBlobStore;
  let service: ProductService;

  const workspaceId = 'ws_12k_test';
  const userId = 'usr_operator';
  const projectId = 'proj_12k';
  const targetId = 'tgt_12k';
  const journeyId = 'jny_12k';
  const runId = 'run_12k_test';

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'crashlab-12k-test-'));
    repos = createInMemoryProductRepositories();
    blobStore = new LocalBlobStore({ rootDirectory: tempDir });

    // Seed test workspace, user, and membership
    await repos.users.create({
      id: userId,
      schemaVersion: '1.0',
      email: 'operator@crashlab.internal',
      name: 'Pilot Operator',
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await repos.workspaces.create({
      id: workspaceId,
      schemaVersion: '1.0',
      name: 'Pilot Staging Workspace',
      slug: 'pilot-staging',
      ownerUserId: userId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await repos.memberships.create({
      id: 'mem_operator',
      schemaVersion: '1.0',
      workspaceId,
      userId,
      role: 'owner',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await repos.projects.create({
      id: projectId,
      schemaVersion: '1.0',
      workspaceId,
      name: 'Staging Pilot Project',
      description: 'Staging Pilot Project Description',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await repos.targets.create({
      id: targetId,
      schemaVersion: '1.0',
      workspaceId,
      projectId,
      name: 'Controlled Staging Fixture',
      environment: 'staging',
      targetUrl: 'https://staging.crashlab.internal',
      targetOrigin: 'https://staging.crashlab.internal',
      allowedOrigins: ['https://staging.crashlab.internal'],
      forbiddenActions: ['payment', 'email'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await repos.journeys.create({
      id: journeyId,
      schemaVersion: '1.0',
      workspaceId,
      projectId,
      targetEnvironmentId: targetId,
      goal: 'Trigger staging pilot interaction and controlled probe',
      origin: 'https://staging.crashlab.internal',
      allowedActions: ['navigate', 'click'],
      forbiddenActions: ['payment', 'email'],
      requiresCredentials: false,
      requiresTestData: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await repos.runs.create({
      id: runId,
      schemaVersion: '1.0',
      workspaceId,
      projectId,
      targetEnvironmentId: targetId,
      journeyId,
      status: 'completed',
      safeTestMode: true,
      preflightStatus: 'ready',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  describe('1. Explicit 4-State Reproduction Model', () => {
    it('initializes candidates in the explicit "not-tested" state by default', async () => {
      service = new ProductService({
        repositories: repos,
        blobStore,
      });

      // Register an un-reproduced candidate
      await service.registerCandidate(
        {
          workspaceId,
          projectId,
          runId,
          candidateId: 'anom_http500_01',
          ruleId: 'HTTP_5XX',
          classification: 'HTTP_5XX',
          reproduced: false,
        },
        userId,
      );

      const candidates = await service.listCandidatesByRun(workspaceId, runId, userId);
      expect(candidates).toHaveLength(1);
      const cand = candidates[0]!;

      expect(cand.reproductionStatus).toBe('not-tested');
      expect(cand.reproduced).toBe(false);
      expect(cand.reproductionRatio).toBe('Not tested');
      expect(cand.reproductionDetails).toEqual({
        state: 'not-tested',
        attemptsRequested: 0,
        attemptsCompleted: 0,
        signalsEvaluated: 0,
        signalsReproduced: 0,
        recurrenceRatio: '0/0',
        finalClassification: 'not-tested',
      });
      // Invariants
      expect(cand.confirmed).toBe(false);
      expect(cand.confirmedBug).toBe(false);
    });
  });

  describe('2. Bounded Reproduction: 3/3 Reproduction Outcome', () => {
    it('evaluates 3 attempts and marks candidate as "reproduced" when recurrence ratio is 3/3', async () => {
      // Mock reproducer function simulating 3/3 recurrence
      let attemptsExecuted = 0;
      const mockReproducer = async (input: ReproductionInput): Promise<ReproductionReport> => {
        attemptsExecuted = input.attempts;
        return {
          schemaVersion: '1.0',
          journeyReport: input.journeyPath,
          anomalyReport: input.anomalyPath,
          executionReport: input.executionPath,
          goal: input.journey.goal,
          summary: {
            totalSignals: 1,
            eligibleSignals: 1,
            reproduced: 1,
            notReproduced: 0,
            inconclusive: 0,
            blocked: 0,
            ineligible: 0,
            candidatesRequiringInvestigation: 1,
          },
          runs: [1, 2, 3].map((attempt) => ({
            attempt,
            name: `attempt-00${attempt}`,
            executionReport: `runs/${runId}/attempt-${attempt}.json`,
            anomalyReport: `runs/${runId}/attempt-${attempt}-anom.json`,
            status: 'completed',
            detail: null,
            environment: { fingerprint: null, environmentId: 'staging', applicationBuildId: null },
          })),
          results: [
            {
              id: 'reproduction-001',
              anomalyId: 'anom_http500_01',
              ruleId: 'HTTP_5XX',
              classification: 'reproduced',
              confirmed: false,
              matchingAttempts: 3,
              completedAttempts: 3,
              inconclusiveAttempts: 0,
              reproductionRatio: '3/3',
              matchingKey: 'net:http500',
              evidence: [],
              reason: 'The same signal occurred in all 3 controlled attempts.',
              ineligibleBecause: null,
              requiresInvestigation: true,
              originalEnvironment: null,
              attemptEnvironments: [],
              environmentComparison: {
                classification: 'same',
                differences: [],
                unknownReason: null,
                interpretation: 'Identical staging environment',
              },
            },
          ],
          safety: {
            authorizedConfirmationRequired: true,
            safeTestMode: true,
            livePaymentAllowed: false,
            sensitiveValuesRedacted: true,
            attemptsBlockedBySafety: 0,
          },
          reproducer: {
            mode: 'controlled-deterministic',
            version: '1.0',
            automaticRetries: false,
            attemptsRequested: input.attempts,
            attemptsCompleted: 3,
            attemptsBlocked: 0,
            attemptsFailed: 0,
          },
          expectations: null,
          interpretation: {
            confirmedBug: false,
            reproducedSignalsAreCandidatesOnly: true,
            note: 'Lead only, not a confirmed bug',
          },
        };
      };

      service = new ProductService({
        repositories: repos,
        blobStore,
        reproduceSignalsFn: mockReproducer as any,
      });

      await service.registerCandidate(
        {
          workspaceId,
          projectId,
          runId,
          candidateId: 'anom_http500_01',
          ruleId: 'HTTP_5XX',
          classification: 'HTTP_5XX',
          reproduced: false,
        },
        userId,
      );

      const result = await service.runBoundedReproduction(workspaceId, runId, userId, { attempts: 3 });

      expect(attemptsExecuted).toBe(3);
      expect(result.reproductionReport.summary.reproduced).toBe(1);
      expect(result.candidates).toHaveLength(1);

      const cand = result.candidates[0]!;
      expect(cand.reproductionStatus).toBe('reproduced');
      expect(cand.reproduced).toBe(true);
      expect(cand.reproductionRatio).toBe('3/3');
      expect(cand.reproductionDetails).toEqual({
        state: 'reproduced',
        attemptsRequested: 3,
        attemptsCompleted: 3,
        signalsEvaluated: 1,
        signalsReproduced: 1,
        recurrenceRatio: '3/3',
        finalClassification: 'reproduced',
      });

      // Verify invariants preserved
      expect(cand.confirmed).toBe(false);
      expect(cand.confirmedBug).toBe(false);
      expect(result.reproductionReport.interpretation.confirmedBug).toBe(false);

      // Verify persistence in repo
      const stored = await service.listCandidatesByRun(workspaceId, runId, userId);
      expect(stored[0]!.reproductionStatus).toBe('reproduced');
      expect(stored[0]!.reproduced).toBe(true);
    });
  });

  describe('3. Bounded Reproduction: 0/3 Non-Reproduction Outcome', () => {
    it('marks candidate as "not-reproduced" when recurrence ratio is 0/3', async () => {
      const mockReproducer = async (input: ReproductionInput): Promise<ReproductionReport> => ({
        schemaVersion: '1.0',
        journeyReport: input.journeyPath,
        anomalyReport: input.anomalyPath,
        executionReport: input.executionPath,
        goal: input.journey.goal,
        summary: {
          totalSignals: 1,
          eligibleSignals: 1,
          reproduced: 0,
          notReproduced: 1,
          inconclusive: 0,
          blocked: 0,
          ineligible: 0,
          candidatesRequiringInvestigation: 0,
        },
        runs: [1, 2, 3].map((attempt) => ({
          attempt,
          name: `attempt-00${attempt}`,
          executionReport: `runs/${runId}/attempt-${attempt}.json`,
          anomalyReport: `runs/${runId}/attempt-${attempt}-anom.json`,
          status: 'completed',
          detail: null,
          environment: { fingerprint: null, environmentId: 'staging', applicationBuildId: null },
        })),
        results: [
          {
            id: 'reproduction-001',
            anomalyId: 'anom_flaky_01',
            ruleId: 'HTTP_5XX',
            classification: 'not-reproduced',
            confirmed: false,
            matchingAttempts: 0,
            completedAttempts: 3,
            inconclusiveAttempts: 0,
            reproductionRatio: '0/3',
            matchingKey: 'net:http500',
            evidence: [],
            reason: 'The same signal did not occur in any of the 3 controlled attempt(s).',
            ineligibleBecause: null,
            requiresInvestigation: false,
            originalEnvironment: null,
            attemptEnvironments: [],
            environmentComparison: {
              classification: 'same',
              differences: [],
              unknownReason: null,
              interpretation: 'Identical staging environment',
            },
          },
        ],
        safety: {
          authorizedConfirmationRequired: true,
          safeTestMode: true,
          livePaymentAllowed: false,
          sensitiveValuesRedacted: true,
          attemptsBlockedBySafety: 0,
        },
        reproducer: {
          mode: 'controlled-deterministic',
          version: '1.0',
          automaticRetries: false,
          attemptsRequested: 3,
          attemptsCompleted: 3,
          attemptsBlocked: 0,
          attemptsFailed: 0,
        },
        expectations: null,
        interpretation: {
          confirmedBug: false,
          reproducedSignalsAreCandidatesOnly: true,
          note: 'Not reproduced',
        },
      });

      service = new ProductService({
        repositories: repos,
        blobStore,
        reproduceSignalsFn: mockReproducer as any,
      });

      await service.registerCandidate(
        {
          workspaceId,
          projectId,
          runId,
          candidateId: 'anom_flaky_01',
          ruleId: 'HTTP_5XX',
          classification: 'HTTP_5XX',
          reproduced: false,
        },
        userId,
      );

      const result = await service.runBoundedReproduction(workspaceId, runId, userId, { attempts: 3 });
      const cand = result.candidates[0]!;

      expect(cand.reproductionStatus).toBe('not-reproduced');
      expect(cand.reproduced).toBe(false);
      expect(cand.reproductionRatio).toBe('0/3');
      expect(cand.reproductionDetails?.finalClassification).toBe('not-reproduced');
      expect(cand.confirmed).toBe(false);
      expect(cand.confirmedBug).toBe(false);
    });
  });

  describe('4. Bounded Reproduction: Incomplete / Inconclusive Outcome', () => {
    it('marks candidate as "inconclusive" when recurrence is below threshold (1/3)', async () => {
      const mockReproducer = async (input: ReproductionInput): Promise<ReproductionReport> => ({
        schemaVersion: '1.0',
        journeyReport: input.journeyPath,
        anomalyReport: input.anomalyPath,
        executionReport: input.executionPath,
        goal: input.journey.goal,
        summary: {
          totalSignals: 1,
          eligibleSignals: 1,
          reproduced: 0,
          notReproduced: 0,
          inconclusive: 1,
          blocked: 0,
          ineligible: 0,
          candidatesRequiringInvestigation: 0,
        },
        runs: [1, 2, 3].map((attempt) => ({
          attempt,
          name: `attempt-00${attempt}`,
          executionReport: `runs/${runId}/attempt-${attempt}.json`,
          anomalyReport: `runs/${runId}/attempt-${attempt}-anom.json`,
          status: 'completed',
          detail: null,
          environment: { fingerprint: null, environmentId: 'staging', applicationBuildId: null },
        })),
        results: [
          {
            id: 'reproduction-001',
            anomalyId: 'anom_intermittent_01',
            ruleId: 'HTTP_5XX',
            classification: 'inconclusive',
            confirmed: false,
            matchingAttempts: 1,
            completedAttempts: 3,
            inconclusiveAttempts: 0,
            reproductionRatio: '1/3',
            matchingKey: 'net:http500',
            evidence: [],
            reason: 'The signal occurred in only 1 of 3 controlled attempts, below threshold of 2.',
            ineligibleBecause: null,
            requiresInvestigation: false,
            originalEnvironment: null,
            attemptEnvironments: [],
            environmentComparison: {
              classification: 'same',
              differences: [],
              unknownReason: null,
              interpretation: 'Identical staging environment',
            },
          },
        ],
        safety: {
          authorizedConfirmationRequired: true,
          safeTestMode: true,
          livePaymentAllowed: false,
          sensitiveValuesRedacted: true,
          attemptsBlockedBySafety: 0,
        },
        reproducer: {
          mode: 'controlled-deterministic',
          version: '1.0',
          automaticRetries: false,
          attemptsRequested: 3,
          attemptsCompleted: 3,
          attemptsBlocked: 0,
          attemptsFailed: 0,
        },
        expectations: null,
        interpretation: {
          confirmedBug: false,
          reproducedSignalsAreCandidatesOnly: true,
          note: 'Inconclusive',
        },
      });

      service = new ProductService({
        repositories: repos,
        blobStore,
        reproduceSignalsFn: mockReproducer as any,
      });

      await service.registerCandidate(
        {
          workspaceId,
          projectId,
          runId,
          candidateId: 'anom_intermittent_01',
          ruleId: 'HTTP_5XX',
          classification: 'HTTP_5XX',
          reproduced: false,
        },
        userId,
      );

      const result = await service.runBoundedReproduction(workspaceId, runId, userId, { attempts: 3 });
      const cand = result.candidates[0]!;

      expect(cand.reproductionStatus).toBe('inconclusive');
      expect(cand.reproduced).toBe(false);
      expect(cand.reproductionRatio).toBe('1/3');
      expect(cand.reproductionDetails?.finalClassification).toBe('inconclusive');
    });

    it('enforces strict maximum bound of 3 attempts even if caller requests more', async () => {
      let boundedAttemptsReceived = 0;
      const mockReproducer = async (input: ReproductionInput): Promise<ReproductionReport> => {
        boundedAttemptsReceived = input.attempts;
        return {
          schemaVersion: '1.0',
          journeyReport: input.journeyPath,
          anomalyReport: input.anomalyPath,
          executionReport: input.executionPath,
          goal: input.journey.goal,
          summary: { totalSignals: 1, eligibleSignals: 1, reproduced: 1, notReproduced: 0, inconclusive: 0, blocked: 0, ineligible: 0, candidatesRequiringInvestigation: 1 },
          runs: [],
          results: [],
          safety: { authorizedConfirmationRequired: true, safeTestMode: true, livePaymentAllowed: false, sensitiveValuesRedacted: true, attemptsBlockedBySafety: 0 },
          reproducer: { mode: 'controlled-deterministic', version: '1.0', automaticRetries: false, attemptsRequested: input.attempts, attemptsCompleted: 3, attemptsBlocked: 0, attemptsFailed: 0 },
          expectations: null,
          interpretation: { confirmedBug: false, reproducedSignalsAreCandidatesOnly: true, note: 'bounded' },
        };
      };

      service = new ProductService({
        repositories: repos,
        blobStore,
        reproduceSignalsFn: mockReproducer as any,
      });

      await service.registerCandidate(
        {
          workspaceId,
          projectId,
          runId,
          candidateId: 'anom_limit_01',
          ruleId: 'HTTP_5XX',
          classification: 'HTTP_5XX',
          reproduced: false,
        },
        userId,
      );

      // Caller requests 10 attempts
      await service.runBoundedReproduction(workspaceId, runId, userId, { attempts: 10 });
      expect(boundedAttemptsReceived).toBe(3); // Strict max 3 enforced
    });
  });

  describe('5. Related Signal Grouping & Correlation (HTTP 500 Cascade)', () => {
    it('correlates 1 HTTP 500 server finding with downstream client console errors', () => {
      const candidates: CandidateReference[] = [
        {
          id: 'cand_http500',
          schemaVersion: '1.0',
          workspaceId,
          projectId,
          runId,
          candidateId: 'anom_500',
          ruleId: 'HTTP_5XX',
          classification: 'HTTP_5XX',
          reproduced: false,
          reviewStatus: 'unreviewed',
          confirmed: false,
          confirmedBug: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        {
          id: 'cand_console1',
          schemaVersion: '1.0',
          workspaceId,
          projectId,
          runId,
          candidateId: 'anom_con1',
          ruleId: 'CONSOLE_ERROR',
          classification: 'CONSOLE_ERROR',
          reproduced: false,
          reviewStatus: 'unreviewed',
          confirmed: false,
          confirmedBug: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        {
          id: 'cand_console2',
          schemaVersion: '1.0',
          workspaceId,
          projectId,
          runId,
          candidateId: 'anom_con2',
          ruleId: 'CONSOLE_ERROR',
          classification: 'CONSOLE_ERROR',
          reproduced: false,
          reviewStatus: 'unreviewed',
          confirmed: false,
          confirmedBug: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ];

      const correlation = analyzeSignalCorrelation(candidates);

      expect(correlation.hasCorrelatedSignals).toBe(true);
      expect(correlation.groups).toHaveLength(1);

      const group = correlation.groups[0]!;
      expect(group.correlationType).toBe('http_5xx_cascade');
      expect(group.primaryCandidateId).toBe('cand_http500');
      expect(group.secondaryCandidateIds).toEqual(['cand_console1', 'cand_console2']);
      expect(group.title).toContain('Server Fault Defect Cascade');
      expect(group.explanation).toContain('HTTP 500');
      expect(group.duplicateGuidance).toContain('Marking as duplicate');

      expect(correlation.candidateCorrelationMap['cand_http500']?.isPrimary).toBe(true);
      expect(correlation.candidateCorrelationMap['cand_console1']?.isPrimary).toBe(false);
      expect(correlation.candidateCorrelationMap['cand_console2']?.isPrimary).toBe(false);
    });

    it('does not group unrelated signals when no HTTP 500 cascade exists', () => {
      const candidates: CandidateReference[] = [
        {
          id: 'cand_timeout',
          schemaVersion: '1.0',
          workspaceId,
          projectId,
          runId,
          candidateId: 'anom_t1',
          ruleId: 'STEP_TIMEOUT',
          classification: 'STEP_TIMEOUT',
          reproduced: false,
          reviewStatus: 'unreviewed',
          confirmed: false,
          confirmedBug: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ];

      const correlation = analyzeSignalCorrelation(candidates);
      expect(correlation.hasCorrelatedSignals).toBe(false);
      expect(correlation.groups).toHaveLength(0);
    });
  });

  describe('6. Empty Log Detection & Rich Execution Log Builder', () => {
    it('generates rich, multi-line execution logs (> 1 KB) with full step, network, and console context', () => {
      const execReport: ExecutionReport = {
        schemaVersion: '1.0',
        journeyPlanSchemaVersion: '1.0',
        journeyReport: 'journey.json',
        goal: 'Staging defect probe',
        journeyType: 'navigation',
        target: { url: 'https://staging.crashlab.internal', finalUrl: null, title: 'Staging' },
        status: 'completed',
        verification: null,
        startedAt: '2026-10-19T10:00:00.000Z',
        finishedAt: '2026-10-19T10:00:03.200Z',
        durationMs: 3200,
        stepCounts: { total: 2, passed: 2, failed: 0, blocked: 0, skipped: 0 },
        steps: [
          {
            id: 'step-001',
            order: 1,
            description: 'Navigate to target',
            planConfidence: 1,
            intent: 'navigate',
            action: 'navigate',
            status: 'passed',
            startedAt: '2026-10-19T10:00:00.100Z',
            finishedAt: '2026-10-19T10:00:01.000Z',
            durationMs: 900,
            selectedLocator: null,
            targetElementIds: [],
            urlBefore: null,
            urlAfter: 'https://staging.crashlab.internal',
            observations: null,
            evidence: {
              screenshot: null,
              screenshotOmitted: true,
              screenshotOmittedReason: 'test',
              consoleEvents: [],
              pageErrors: [],
              networkEvents: [
                { method: 'GET', url: 'https://staging.crashlab.internal', path: '/', status: 200, resourceType: 'document', durationMs: 120, thirdParty: false, failure: null },
              ],
              dialogObserved: false,
              pageChanged: true,
            },
            error: null,
            skipReason: null,
            verification: null,
            assertion: null,
            postconditions: null,
          },
          {
            id: 'step-002',
            order: 2,
            description: 'Click defect probe button',
            planConfidence: 1,
            intent: 'click',
            action: 'click',
            status: 'passed',
            startedAt: '2026-10-19T10:00:01.100Z',
            finishedAt: '2026-10-19T10:00:02.500Z',
            durationMs: 1400,
            selectedLocator: '#btn-interact',
            targetElementIds: ['btn-interact'],
            urlBefore: 'https://staging.crashlab.internal',
            urlAfter: 'https://staging.crashlab.internal',
            observations: null,
            evidence: {
              screenshot: null,
              screenshotOmitted: true,
              screenshotOmittedReason: 'test',
              consoleEvents: [
                { type: 'error', text: 'Uncaught (in promise) Server defect probe failed', url: null, line: null },
              ],
              pageErrors: [],
              networkEvents: [
                { method: 'GET', url: 'https://staging.crashlab.internal/defect-probe', path: '/defect-probe', status: 500, resourceType: 'fetch', durationMs: 250, thirdParty: false, failure: null },
              ],
              dialogObserved: false,
              pageChanged: false,
            },
            error: null,
            skipReason: null,
            verification: null,
            assertion: null,
            postconditions: null,
          },
        ],
        rawEvidence: { consoleEvents: [], pageErrors: [], networkEvents: [], screenshots: [] },
        warnings: [],
        blockedSteps: [],
        redaction: { sensitiveValuesRedacted: true, redactedValueCount: 0, dataProvidedKeys: [], dataProvided: false, screenshotsOmittedAfterSensitiveData: false },
        executor: { mode: 'deterministic', version: '1.0', retries: 0, stoppedOnFailure: false, continueOnFailure: false, safeTestMode: true },
        environment: null,
      };

      const anomalyReport: AnomalyReport = {
        schemaVersion: '1.0',
        executionReport: 'runs/run_12k_test/execution.json',
        journeyReport: 'journeys/jny_12k.json',
        executionStatus: 'passed',
        goal: 'Staging defect probe',
        journeyType: 'custom',
        summary: {
          totalSignals: 2,
          httpErrors: 1,
          networkFailures: 0,
          consoleErrors: 1,
          pageErrors: 0,
          timeouts: 0,
          navigationSignals: 0,
          uiStateSignals: 0,
          duplicateRequestSignals: 0,
          stepFailureSignals: 0,
          ruleIds: ['CONSOLE_ERROR', 'HTTP_5XX'],
        },
        anomalies: [
          {
            id: 'anom_1',
            ruleId: 'HTTP_5XX',
            kind: 'http-error',
            signalLevel: 'error',
            status: 'observed',
            message: 'Server returned HTTP 500',
            stepId: 'step-002',
            stepOrder: 2,
            source: { executionReport: 'exec.json', evidenceType: 'network', eventIndex: 0 },
            details: {},
            possiblyExpected: false,
            confirmed: false,
            occurrences: 1,
          },
        ],
        warnings: [],
        analyzer: { mode: 'deterministic', version: '1.0' },
        environment: { fingerprint: null, origin: 'https://staging.crashlab.internal', browserName: 'Chromium', browserVersion: 'unknown', environmentId: 'staging', applicationBuildId: null },
        interpretation: { confirmedBug: false, requiresInvestigation: true, note: 'defect probe' },
      };

      const log = formatWorkerExecutionLog({
        runId,
        journey: { id: journeyId, goal: 'Staging defect probe', origin: 'https://staging.crashlab.internal' },
        target: { id: targetId, name: 'Staging Fixture', targetUrl: 'https://staging.crashlab.internal', environment: 'staging' },
        execReport,
        anomalyReport,
      });

      expect(log.length).toBeGreaterThan(1000);
      expect(log).toContain('CRASHLAB WORKER EXECUTION LOG');
      expect(log).toContain('HTTP 500');
      expect(log).toContain('Server defect probe failed');
      expect(log).toContain('#btn-interact');
      expect(log).toContain('Safe-Test Mode:        ENFORCED');
      expect(log).toContain('confirmedBug: false');
    });

    it('formats artifact size accurately without displaying misleading "0 KB" for non-zero files', () => {
      expect(formatArtifactSize(0)).toBe('0 B');
      expect(formatArtifactSize(120)).toBe('120 B'); // Previously displayed as 0 KB
      expect(formatArtifactSize(512)).toBe('512 B'); // Previously displayed as 0 KB
      expect(formatArtifactSize(1024)).toBe('1.0 KB');
      expect(formatArtifactSize(2450)).toBe('2.4 KB');
      expect(formatArtifactSize(1048576)).toBe('1024.0 KB');
    });

    it('resolves artifact extensions and content types correctly', () => {
      expect(resolveArtifactExtension('log', 'text/plain; charset=utf-8')).toBe('log');
      expect(resolveArtifactExtension('execution', 'application/json')).toBe('json');
      expect(resolveArtifactExtension('anomalies', 'application/json')).toBe('json');
      expect(resolveArtifactExtension('reproduction', 'application/json')).toBe('json');
    });
  });

  describe('7. Trust Invariants Preservation', () => {
    it('strictly preserves confirmed: false and confirmedBug: false across all review actions', async () => {
      service = new ProductService({ repositories: repos, blobStore });

      const cand = await service.registerCandidate(
        {
          workspaceId,
          projectId,
          runId,
          candidateId: 'anom_invariant',
          ruleId: 'HTTP_5XX',
          classification: 'HTTP_5XX',
          reproduced: false,
        },
        userId,
      );

      expect(cand.confirmed).toBe(false);
      expect(cand.confirmedBug).toBe(false);

      // Review to 'accepted'
      const reviewed = await service.reviewCandidate(workspaceId, cand.id, 'accepted', 'Accepted for investigation', userId);
      expect(reviewed.reviewStatus).toBe('accepted');
      expect(reviewed.confirmed).toBe(false);
      expect(reviewed.confirmedBug).toBe(false);

      // Review to 'duplicate'
      const dup = await service.reviewCandidate(workspaceId, cand.id, 'duplicate', 'Downstream of HTTP 500', userId);
      expect(dup.reviewStatus).toBe('duplicate');
      expect(dup.confirmed).toBe(false);
      expect(dup.confirmedBug).toBe(false);
    });

    it('ensures frontend client bundle never leaks SUPABASE_SERVICE_ROLE_KEY or connection strings', () => {
      expect(CLIENT_JS_BUNDLE).not.toContain('service_role');
      expect(CLIENT_JS_BUNDLE).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
      expect(CLIENT_JS_BUNDLE).not.toContain('postgres://');
      expect(CLIENT_JS_BUNDLE).not.toContain('postgresql://');
    });
  });
});
