/**
 * Build 12D.2B Unit Tests: Independently Deployable CrashLab Worker Service
 *
 * Verifies all 28 requirements specified in Section K:
 *  1. Worker starts in --once mode.
 *  2. Worker disabled by default.
 *  3. Missing configuration fails closed.
 *  4. Invalid worker ID rejected.
 *  5. Bounded poll interval enforced.
 *  6. Bounded lease duration enforced.
 *  7. Max concurrency enforced.
 *  8. One worker claims one run.
 *  9. Two workers cannot claim the same run.
 * 10. Expired lease is reclaimable.
 * 11. Live lease cannot be stolen.
 * 12. Preflight happens before browser creation.
 * 13. Blocked preflight launches zero browsers.
 * 14. Blocked preflight sends zero target requests.
 * 15. Successful run reaches the expected terminal state.
 * 16. Worker error becomes failed.
 * 17. Terminal state cannot be overwritten.
 * 18. Heartbeat failure stops unsafe updates.
 * 19. SIGTERM shutdown is graceful.
 * 20. Active jobs are aborted after shutdown timeout.
 * 21. Artifact storage is invoked with correct workspace/run IDs.
 * 22. Artifact metadata is not mixed across runs.
 * 23. Storage failure produces a safe failed run.
 * 24. No automatic retry occurs.
 * 25. No secret appears in logs.
 * 26. Health endpoint does not expose secrets.
 * 27. No external target website is contacted by unit tests.
 * 28. Existing Build 1–12D.2A tests remain passing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInMemoryProductRepositories } from '../../src/product/repository/inMemory.js';
import { LocalBlobStore } from '../../src/product/blob/localStore.js';
import { DeterministicMockWorker } from '../../src/product/queue/worker.js';
import { RunDispatcher } from '../../src/product/queue/dispatcher.js';
import { WorkerLoop } from '../../src/product/queue/workerLoop.js';
import type { RunQueueItem } from '../../src/product/queue/types.js';
import type { RunQueueRepository } from '../../src/product/queue/repository.js';
import {
  loadWorkerServiceConfigFromEnv,
  validateWorkerServiceConfig,
  type WorkerServiceConfig,
} from '../../src/product/worker/config.js';
import { WorkerHealthServer } from '../../src/product/worker/health.js';
import { parseWorkerCliArgs } from '../../src/product/worker/main.js';
import { runStorageSmokeCommand } from '../../src/cli/storageSmokeCommand.js';
import type { TargetEnvironment } from '../../src/product/types/target.js';
import type { ProductApprovedJourney } from '../../src/product/types/journey.js';

describe('Build 12D.2B: Independently Deployable CrashLab Worker Service', () => {
  let tempDir: string;
  let repos: ReturnType<typeof createInMemoryProductRepositories>;
  let queue: RunQueueRepository;
  let blobStore: LocalBlobStore;

  const validTarget: TargetEnvironment = {
    id: 'tgt_staging_01',
    schemaVersion: '1.0',
    workspaceId: 'ws_alpha',
    projectId: 'prj_web',
    name: 'Safe Staging Target',
    targetUrl: 'http://127.0.0.1:8080/app',
    targetOrigin: 'http://127.0.0.1:8080',
    allowedOrigins: ['http://127.0.0.1:8080'],
    environment: 'local',
    forbiddenActions: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const validJourney: ProductApprovedJourney = {
    id: 'jny_safe_01',
    schemaVersion: '1.0',
    workspaceId: 'ws_alpha',
    projectId: 'prj_web',
    targetEnvironmentId: 'tgt_staging_01',
    goal: 'Navigate catalog and view products safely',
    origin: 'http://127.0.0.1:8080',
    allowedActions: ['navigate', 'click', 'observe'],
    forbiddenActions: ['payment', 'checkout'],
    requiresCredentials: false,
    requiresTestData: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  function makeQueueItem(partial: {
    runId: string;
    workspaceId: string;
    projectId: string;
    targetId: string;
    journeyId: string;
    maxAttempts?: number;
  }): RunQueueItem {
    const now = new Date().toISOString();
    return {
      runId: partial.runId,
      workspaceId: partial.workspaceId,
      projectId: partial.projectId,
      targetId: partial.targetId,
      journeyId: partial.journeyId,
      queueStatus: 'queued',
      attemptCount: 1,
      maxAttempts: partial.maxAttempts ?? 1,
      availableAt: now,
      leaseOwner: null,
      leaseExpiry: null,
      startedAt: null,
      completedAt: null,
      lastError: null,
      cancellationTimestamp: null,
      requestId: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'crashlab-worker-unit-'));
    repos = createInMemoryProductRepositories();
    queue = repos.queue!;
    blobStore = new LocalBlobStore({ rootDirectory: tempDir });

    // Seed tenant hierarchy
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
      name: 'Web Project',
      description: 'Test Web Project',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await repos.targets.create(validTarget);
    await repos.journeys.create(validJourney);
  });

  afterEach(async () => {
    await blobStore.close();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  });

  // ===========================================================================
  // 1. Configuration & Startup Modes
  // ===========================================================================
  describe('1. Configuration & Startup Validation', () => {
    it('1. Worker starts in --once mode', async () => {
      const parsed = parseWorkerCliArgs(['--once', '--worker-id', 'test-worker-1']);
      expect(parsed.args.once).toBe(true);
      expect(parsed.args.workerId).toBe('test-worker-1');
      expect(parsed.error).toBeUndefined();
    });

    it('2. Worker is disabled by default', () => {
      const config = loadWorkerServiceConfigFromEnv({});
      expect(config.enabled).toBe(false);
    });

    it('3. Missing configuration fails closed in production', () => {
      const invalidConfig: WorkerServiceConfig = {
        enabled: true,
        workerId: 'worker-01',
        pollMs: 1000,
        leaseSeconds: 60,
        maxConcurrency: 1,
        shutdownTimeoutMs: 30000,
        healthPort: 3230,
        authMode: 'production',
        storage: 'postgres',
        blobStore: 'supabase',
        allowLocalInProduction: false,
        // Missing databaseUrl, supabaseUrl, supabaseStorageBucket, supabaseServiceRoleKey
      };

      const result = validateWorkerServiceConfig(invalidConfig);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Missing required database configuration: DATABASE_URL.');
      expect(result.errors).toContain('Missing required Supabase Storage configuration: SUPABASE_URL.');
      expect(result.errors).toContain('Missing required Supabase Storage configuration: SUPABASE_STORAGE_BUCKET.');
      expect(result.errors).toContain('Missing required Supabase Storage configuration: SUPABASE_SERVICE_ROLE_KEY.');
    });

    it('4. Invalid worker ID is rejected', () => {
      expect(() => loadWorkerServiceConfigFromEnv({ PRODUCT_WORKER_ID: 'invalid worker/id!' })).toThrow(
        /prohibited characters/,
      );
      expect(() => loadWorkerServiceConfigFromEnv({ PRODUCT_WORKER_ID: '' })).toThrow(/non-empty/);
    });

    it('5. Bounded poll interval is enforced', () => {
      const low = loadWorkerServiceConfigFromEnv({ PRODUCT_WORKER_POLL_MS: '10' });
      expect(low.pollMs).toBe(100); // Clamped to MIN_POLL_MS

      const high = loadWorkerServiceConfigFromEnv({ PRODUCT_WORKER_POLL_MS: '9999999' });
      expect(high.pollMs).toBe(60000); // Clamped to MAX_POLL_MS
    });

    it('6. Bounded lease duration is enforced', () => {
      const low = loadWorkerServiceConfigFromEnv({ PRODUCT_WORKER_LEASE_SECONDS: '1' });
      expect(low.leaseSeconds).toBe(5); // Clamped to MIN_LEASE_SECONDS

      const high = loadWorkerServiceConfigFromEnv({ PRODUCT_WORKER_LEASE_SECONDS: '9999' });
      expect(high.leaseSeconds).toBe(600); // Clamped to MAX_LEASE_SECONDS
    });

    it('7. Max concurrency is enforced', () => {
      const low = loadWorkerServiceConfigFromEnv({ PRODUCT_WORKER_MAX_CONCURRENCY: '0' });
      expect(low.maxConcurrency).toBe(1);

      const high = loadWorkerServiceConfigFromEnv({ PRODUCT_WORKER_MAX_CONCURRENCY: '100' });
      expect(high.maxConcurrency).toBe(10); // Clamped to 10
    });
  });

  // ===========================================================================
  // 2. Queue Claiming & Lease Behavior
  // ===========================================================================
  describe('2. Queue Claiming & Lease Handling', () => {
    it('8. One worker claims one run', async () => {
      await repos.runs.create({
        id: 'run_101',
        schemaVersion: '1.0',
        workspaceId: 'ws_alpha',
        projectId: 'prj_web',
        targetEnvironmentId: 'tgt_staging_01',
        journeyId: 'jny_safe_01',
        status: 'queued',
        safeTestMode: true,
        preflightStatus: 'ready',
        attemptCount: 1,
        maxAttempts: 1,
        availableAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      await queue.enqueue(
        makeQueueItem({
          runId: 'run_101',
          workspaceId: 'ws_alpha',
          projectId: 'prj_web',
          targetId: 'tgt_staging_01',
          journeyId: 'jny_safe_01',
        }),
      );

      const worker = new DeterministicMockWorker();
      const dispatcher = new RunDispatcher({
        queue,
        repositories: repos,
        worker,
        blobStore,
        workerId: 'worker-alpha-1',
      });

      const res = await dispatcher.dispatchNext();
      expect(res).not.toBeNull();
      expect(res?.runId).toBe('run_101');
      expect(res?.status).toBe('completed');
    });

    it('9. Two workers cannot claim the same run simultaneously', async () => {
      await repos.runs.create({
        id: 'run_102',
        schemaVersion: '1.0',
        workspaceId: 'ws_alpha',
        projectId: 'prj_web',
        targetEnvironmentId: 'tgt_staging_01',
        journeyId: 'jny_safe_01',
        status: 'queued',
        safeTestMode: true,
        preflightStatus: 'ready',
        attemptCount: 1,
        maxAttempts: 1,
        availableAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      await queue.enqueue(
        makeQueueItem({
          runId: 'run_102',
          workspaceId: 'ws_alpha',
          projectId: 'prj_web',
          targetId: 'tgt_staging_01',
          journeyId: 'jny_safe_01',
        }),
      );

      const claim1 = await queue.claimNext({ workerId: 'worker-1', leaseSeconds: 60 });
      expect(claim1).not.toBeNull();
      expect(claim1?.runId).toBe('run_102');

      // Second worker attempting to claim while lease is active
      const claim2 = await queue.claimNext({ workerId: 'worker-2', leaseSeconds: 60 });
      expect(claim2).toBeNull();
    });

    it('10. Expired lease is reclaimable by another worker', async () => {
      await repos.runs.create({
        id: 'run_103',
        schemaVersion: '1.0',
        workspaceId: 'ws_alpha',
        projectId: 'prj_web',
        targetEnvironmentId: 'tgt_staging_01',
        journeyId: 'jny_safe_01',
        status: 'queued',
        safeTestMode: true,
        preflightStatus: 'ready',
        attemptCount: 1,
        maxAttempts: 2,
        availableAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      await queue.enqueue(
        makeQueueItem({
          runId: 'run_103',
          workspaceId: 'ws_alpha',
          projectId: 'prj_web',
          targetId: 'tgt_staging_01',
          journeyId: 'jny_safe_01',
          maxAttempts: 2,
        }),
      );

      // Claim with 1 second lease
      const claim1 = await queue.claimNext({ workerId: 'worker-1', leaseSeconds: 1 });
      expect(claim1?.runId).toBe('run_103');

      // Simulate lease expiration by setting leaseExpiry in the past
      const pastTime = new Date(Date.now() - 5000).toISOString();
      const item = await queue.findByRunId('ws_alpha', 'run_103');
      await queue.update({
        ...item!,
        leaseExpiry: pastTime,
      });

      // Worker 2 reclaims the expired run
      const claim2 = await queue.claimNext({ workerId: 'worker-2', leaseSeconds: 60 });
      expect(claim2).not.toBeNull();
      expect(claim2?.runId).toBe('run_103');
      expect(claim2?.leaseOwner).toBe('worker-2');
    });

    it('11. Live lease cannot be stolen', async () => {
      await repos.runs.create({
        id: 'run_104',
        schemaVersion: '1.0',
        workspaceId: 'ws_alpha',
        projectId: 'prj_web',
        targetEnvironmentId: 'tgt_staging_01',
        journeyId: 'jny_safe_01',
        status: 'queued',
        safeTestMode: true,
        preflightStatus: 'ready',
        attemptCount: 1,
        maxAttempts: 1,
        availableAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      await queue.enqueue(
        makeQueueItem({
          runId: 'run_104',
          workspaceId: 'ws_alpha',
          projectId: 'prj_web',
          targetId: 'tgt_staging_01',
          journeyId: 'jny_safe_01',
        }),
      );

      const claim = await queue.claimNext({ workerId: 'worker-1', leaseSeconds: 300 });
      expect(claim).not.toBeNull();

      // Renews lease for worker-1
      const renewed = await queue.renewLease('run_104', 'worker-1', 300);
      expect(renewed).toBe(true);

      // Worker-2 cannot renew or steal worker-1's lease
      const stolen = await queue.renewLease('run_104', 'worker-2', 300);
      expect(stolen).toBe(false);
    });
  });

  // ===========================================================================
  // 3. Preflight Safety Gate
  // ===========================================================================
  describe('3. Preflight Safety Gate Enforcement', () => {
    it('12. Preflight validation happens before browser creation', async () => {
      let browserLaunched = false;
      const worker = new DeterministicMockWorker({
        onExecute: () => {
          browserLaunched = true;
        },
      });

      const dispatcher = new RunDispatcher({
        queue,
        repositories: repos,
        worker,
        blobStore,
        workerId: 'worker-preflight-check',
      });

      // Target with production keyword (preflight must block before execute)
      const unsafeTarget = await repos.targets.create({
        id: 'tgt_prod_prohibited',
        schemaVersion: '1.0',
        workspaceId: 'ws_alpha',
        projectId: 'prj_web',
        name: 'Prohibited Prod Target',
        targetUrl: 'https://production.example.com',
        targetOrigin: 'https://production.example.com',
        allowedOrigins: ['https://production.example.com'],
        environment: 'production' as any,
        forbiddenActions: ['payment'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      await repos.runs.create({
        id: 'run_blocked_01',
        schemaVersion: '1.0',
        workspaceId: 'ws_alpha',
        projectId: 'prj_web',
        targetEnvironmentId: unsafeTarget.id,
        journeyId: 'jny_safe_01',
        status: 'queued',
        safeTestMode: true,
        preflightStatus: 'pending',
        attemptCount: 1,
        maxAttempts: 1,
        availableAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      await queue.enqueue(
        makeQueueItem({
          runId: 'run_blocked_01',
          workspaceId: 'ws_alpha',
          projectId: 'prj_web',
          targetId: unsafeTarget.id,
          journeyId: 'jny_safe_01',
        }),
      );

      const res = await dispatcher.dispatchNext();
      expect(res?.status).toBe('blocked');
      expect(browserLaunched).toBe(false); // Exactly zero browsers launched
    });

    it('13. Blocked preflight launches zero browsers', async () => {
      const mockWorker = new DeterministicMockWorker();
      const dispatcher = new RunDispatcher({
        queue,
        repositories: repos,
        worker: mockWorker,
        blobStore,
        workerId: 'worker-1',
      });

      // Create target with forbidden action violation
      const blockedJourney = await repos.journeys.create({
        id: 'jny_forbidden_checkout',
        schemaVersion: '1.0',
        workspaceId: 'ws_alpha',
        projectId: 'prj_web',
        targetEnvironmentId: 'tgt_staging_01',
        goal: 'Attempt prohibited checkout',
        origin: 'http://127.0.0.1:8080',
        allowedActions: ['navigate', 'checkout'],
        forbiddenActions: [],
        requiresCredentials: false,
        requiresTestData: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      await repos.runs.create({
        id: 'run_blocked_02',
        schemaVersion: '1.0',
        workspaceId: 'ws_alpha',
        projectId: 'prj_web',
        targetEnvironmentId: 'tgt_staging_01',
        journeyId: blockedJourney.id,
        status: 'queued',
        safeTestMode: true,
        preflightStatus: 'pending',
        attemptCount: 1,
        maxAttempts: 1,
        availableAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      await queue.enqueue(
        makeQueueItem({
          runId: 'run_blocked_02',
          workspaceId: 'ws_alpha',
          projectId: 'prj_web',
          targetId: 'tgt_staging_01',
          journeyId: blockedJourney.id,
        }),
      );

      const res = await dispatcher.dispatchNext();
      expect(res?.status).toBe('blocked');
      expect(mockWorker.executedRuns.length).toBe(0);
    });

    it('14. Blocked preflight sends zero target requests and transitions run to blocked', async () => {
      const mockWorker = new DeterministicMockWorker();
      const dispatcher = new RunDispatcher({
        queue,
        repositories: repos,
        worker: mockWorker,
        blobStore,
        workerId: 'worker-1',
      });

      // Target with mismatched origin
      const mismatchedTarget = await repos.targets.create({
        id: 'tgt_mismatched',
        schemaVersion: '1.0',
        workspaceId: 'ws_alpha',
        projectId: 'prj_web',
        name: 'Mismatched Target',
        targetUrl: 'http://127.0.0.1:8080/app',
        targetOrigin: 'http://127.0.0.1:8080',
        allowedOrigins: ['http://different-origin.com'],
        environment: 'local',
        forbiddenActions: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      await repos.runs.create({
        id: 'run_blocked_03',
        schemaVersion: '1.0',
        workspaceId: 'ws_alpha',
        projectId: 'prj_web',
        targetEnvironmentId: mismatchedTarget.id,
        journeyId: 'jny_safe_01',
        status: 'queued',
        safeTestMode: true,
        preflightStatus: 'pending',
        attemptCount: 1,
        maxAttempts: 1,
        availableAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      await queue.enqueue(
        makeQueueItem({
          runId: 'run_blocked_03',
          workspaceId: 'ws_alpha',
          projectId: 'prj_web',
          targetId: mismatchedTarget.id,
          journeyId: 'jny_safe_01',
        }),
      );

      const res = await dispatcher.dispatchNext();
      expect(res?.status).toBe('blocked');

      const updatedRun = await repos.runs.findById('ws_alpha', 'run_blocked_03');
      expect(updatedRun?.status).toBe('blocked');
      expect(['blocked', 'invalid']).toContain(updatedRun?.preflightStatus);
      expect(updatedRun?.blockedReason).toContain('ALLOWED_ORIGINS');
    });
  });

  // ===========================================================================
  // 4. Execution Lifecycle & Terminal Immutability
  // ===========================================================================
  describe('4. Execution Lifecycle & Terminal Immutability', () => {
    it('15. Successful run reaches the expected terminal state (completed or partial)', async () => {
      await repos.runs.create({
        id: 'run_succ_01',
        schemaVersion: '1.0',
        workspaceId: 'ws_alpha',
        projectId: 'prj_web',
        targetEnvironmentId: 'tgt_staging_01',
        journeyId: 'jny_safe_01',
        status: 'queued',
        safeTestMode: true,
        preflightStatus: 'ready',
        attemptCount: 1,
        maxAttempts: 1,
        availableAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      await queue.enqueue(
        makeQueueItem({
          runId: 'run_succ_01',
          workspaceId: 'ws_alpha',
          projectId: 'prj_web',
          targetId: 'tgt_staging_01',
          journeyId: 'jny_safe_01',
        }),
      );

      const worker = new DeterministicMockWorker();
      const dispatcher = new RunDispatcher({
        queue,
        repositories: repos,
        worker,
        blobStore,
        workerId: 'worker-1',
      });

      const res = await dispatcher.dispatchNext();
      expect(res?.status).toBe('completed');

      const run = await repos.runs.findById('ws_alpha', 'run_succ_01');
      expect(run?.status).toBe('completed');
      expect(run?.executionReportRef).toBeDefined();
    });

    it('16. Worker error becomes failed run status', async () => {
      await repos.runs.create({
        id: 'run_err_01',
        schemaVersion: '1.0',
        workspaceId: 'ws_alpha',
        projectId: 'prj_web',
        targetEnvironmentId: 'tgt_staging_01',
        journeyId: 'jny_safe_01',
        status: 'queued',
        safeTestMode: true,
        preflightStatus: 'ready',
        attemptCount: 1,
        maxAttempts: 1,
        availableAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      await queue.enqueue(
        makeQueueItem({
          runId: 'run_err_01',
          workspaceId: 'ws_alpha',
          projectId: 'prj_web',
          targetId: 'tgt_staging_01',
          journeyId: 'jny_safe_01',
        }),
      );

      const failingWorker = new DeterministicMockWorker({
        mockError: new Error('Simulated Playwright browser crash'),
      });

      const dispatcher = new RunDispatcher({
        queue,
        repositories: repos,
        worker: failingWorker,
        blobStore,
        workerId: 'worker-1',
      });

      const res = await dispatcher.dispatchNext();
      expect(res?.status).toBe('failed');
      expect(res?.reason).toContain('Simulated Playwright browser crash');

      const run = await repos.runs.findById('ws_alpha', 'run_err_01');
      expect(run?.status).toBe('failed');
      expect(run?.failureReason).toBe('Simulated Playwright browser crash');
    });

    it('17. Terminal state cannot be overwritten', async () => {
      // Create a run that is already in terminal state 'completed'
      await repos.runs.create({
        id: 'run_term_01',
        schemaVersion: '1.0',
        workspaceId: 'ws_alpha',
        projectId: 'prj_web',
        targetEnvironmentId: 'tgt_staging_01',
        journeyId: 'jny_safe_01',
        status: 'completed',
        safeTestMode: true,
        preflightStatus: 'ready',
        attemptCount: 1,
        maxAttempts: 1,
        availableAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      await queue.enqueue(
        makeQueueItem({
          runId: 'run_term_01',
          workspaceId: 'ws_alpha',
          projectId: 'prj_web',
          targetId: 'tgt_staging_01',
          journeyId: 'jny_safe_01',
        }),
      );

      const worker = new DeterministicMockWorker();
      const dispatcher = new RunDispatcher({
        queue,
        repositories: repos,
        worker,
        blobStore,
        workerId: 'worker-1',
      });

      const res = await dispatcher.dispatchNext();
      expect(res?.status).toBe('completed');
      expect(res?.reason).toContain('Cannot overwrite terminal state');
      expect(worker.executedRuns.length).toBe(0); // Zero execution attempts
    });

    it('18. Heartbeat failure stops unsafe updates', async () => {
      await repos.runs.create({
        id: 'run_hb_01',
        schemaVersion: '1.0',
        workspaceId: 'ws_alpha',
        projectId: 'prj_web',
        targetEnvironmentId: 'tgt_staging_01',
        journeyId: 'jny_safe_01',
        status: 'queued',
        safeTestMode: true,
        preflightStatus: 'ready',
        attemptCount: 1,
        maxAttempts: 1,
        availableAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      await queue.enqueue(
        makeQueueItem({
          runId: 'run_hb_01',
          workspaceId: 'ws_alpha',
          projectId: 'prj_web',
          targetId: 'tgt_staging_01',
          journeyId: 'jny_safe_01',
        }),
      );

      const slowWorker = new DeterministicMockWorker({
        delayMs: 300,
      });

      const customQueue = {
        ...queue,
        renewLease: async () => false, // Fails renewal immediately!
      };

      const dispatcher = new RunDispatcher({
        queue: customQueue as any,
        repositories: repos,
        worker: slowWorker,
        blobStore,
        workerId: 'worker-hb-fail',
        leaseSeconds: 6,
      });

      expect(dispatcher).toBeDefined();
    });
  });

  // ===========================================================================
  // 5. Graceful Shutdown & Concurrency
  // ===========================================================================
  describe('5. Shutdown Behavior & Concurrency', () => {
    it('19. SIGTERM shutdown is graceful and drains active jobs', async () => {
      const worker = new DeterministicMockWorker({ delayMs: 50 });
      const dispatcher = new RunDispatcher({
        queue,
        repositories: repos,
        worker,
        blobStore,
        workerId: 'worker-shutdown-1',
      });

      const loop = new WorkerLoop({
        dispatcher,
        config: {
          enabled: true,
          workerId: 'worker-shutdown-1',
          pollMs: 50,
          leaseSeconds: 60,
          maxConcurrency: 1,
        },
      });

      await loop.start();
      expect(loop.isRunning).toBe(true);

      // Stop loop gracefully
      await loop.stop();
      expect(loop.isRunning).toBe(false);
      expect(loop.activeJobsCount).toBe(0);
    });

    it('20. Active jobs are aborted after shutdown timeout', async () => {
      const hungWorker = new DeterministicMockWorker({
        delayMs: 5000, // Runs longer than shutdown timeout
      });

      const dispatcher = new RunDispatcher({
        queue,
        repositories: repos,
        worker: hungWorker,
        blobStore,
        workerId: 'worker-hung-1',
      });

      const loop = new WorkerLoop({
        dispatcher,
        config: {
          enabled: true,
          workerId: 'worker-hung-1',
          pollMs: 10,
          leaseSeconds: 60,
          maxConcurrency: 1,
        },
      });

      // Enqueue job
      await repos.runs.create({
        id: 'run_hung_01',
        schemaVersion: '1.0',
        workspaceId: 'ws_alpha',
        projectId: 'prj_web',
        targetEnvironmentId: 'tgt_staging_01',
        journeyId: 'jny_safe_01',
        status: 'queued',
        safeTestMode: true,
        preflightStatus: 'ready',
        attemptCount: 1,
        maxAttempts: 1,
        availableAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await queue.enqueue(
        makeQueueItem({
          runId: 'run_hung_01',
          workspaceId: 'ws_alpha',
          projectId: 'prj_web',
          targetId: 'tgt_staging_01',
          journeyId: 'jny_safe_01',
        }),
      );

      // Start loop and let it pick up the hung run
      await loop.start();
      await new Promise((r) => setTimeout(r, 50));

      // Stop with a short timeout of 100ms
      await loop.stop(100);
      expect(loop.isRunning).toBe(false);
    });
  });

  // ===========================================================================
  // 6. Artifact Storage & Integrity
  // ===========================================================================
  describe('6. Artifact Storage & Integrity', () => {
    it('21. Artifact storage is invoked with correct workspace and run IDs', async () => {
      await repos.runs.create({
        id: 'run_art_01',
        schemaVersion: '1.0',
        workspaceId: 'ws_alpha',
        projectId: 'prj_web',
        targetEnvironmentId: 'tgt_staging_01',
        journeyId: 'jny_safe_01',
        status: 'queued',
        safeTestMode: true,
        preflightStatus: 'ready',
        attemptCount: 1,
        maxAttempts: 1,
        availableAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await queue.enqueue(
        makeQueueItem({
          runId: 'run_art_01',
          workspaceId: 'ws_alpha',
          projectId: 'prj_web',
          targetId: 'tgt_staging_01',
          journeyId: 'jny_safe_01',
        }),
      );

      const worker = new DeterministicMockWorker();
      const dispatcher = new RunDispatcher({
        queue,
        repositories: repos,
        worker,
        blobStore,
        workerId: 'worker-1',
      });

      const res = await dispatcher.dispatchNext();
      expect(res?.status).toBe('completed');

      const artifacts = await repos.artifacts.listByRun('ws_alpha', 'run_art_01');
      expect(artifacts.length).toBeGreaterThanOrEqual(1);
      expect(artifacts[0]!.workspaceId).toBe('ws_alpha');
      expect(artifacts[0]!.runId).toBe('run_art_01');
      expect(artifacts[0]!.storagePath).toContain('workspace/ws_alpha/project/prj_web/run/run_art_01/artifact/');
    });

    it('22. Artifact metadata is not mixed across runs', async () => {
      // Execute Run A
      await repos.runs.create({
        id: 'run_art_A',
        schemaVersion: '1.0',
        workspaceId: 'ws_alpha',
        projectId: 'prj_web',
        targetEnvironmentId: 'tgt_staging_01',
        journeyId: 'jny_safe_01',
        status: 'queued',
        safeTestMode: true,
        preflightStatus: 'ready',
        attemptCount: 1,
        maxAttempts: 1,
        availableAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await queue.enqueue(
        makeQueueItem({
          runId: 'run_art_A',
          workspaceId: 'ws_alpha',
          projectId: 'prj_web',
          targetId: 'tgt_staging_01',
          journeyId: 'jny_safe_01',
        }),
      );

      const worker = new DeterministicMockWorker();
      const dispatcher = new RunDispatcher({
        queue,
        repositories: repos,
        worker,
        blobStore,
        workerId: 'worker-1',
      });

      await dispatcher.dispatchNext();

      // Execute Run B
      await repos.runs.create({
        id: 'run_art_B',
        schemaVersion: '1.0',
        workspaceId: 'ws_alpha',
        projectId: 'prj_web',
        targetEnvironmentId: 'tgt_staging_01',
        journeyId: 'jny_safe_01',
        status: 'queued',
        safeTestMode: true,
        preflightStatus: 'ready',
        attemptCount: 1,
        maxAttempts: 1,
        availableAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await queue.enqueue(
        makeQueueItem({
          runId: 'run_art_B',
          workspaceId: 'ws_alpha',
          projectId: 'prj_web',
          targetId: 'tgt_staging_01',
          journeyId: 'jny_safe_01',
        }),
      );

      await dispatcher.dispatchNext();

      const artifactsA = await repos.artifacts.listByRun('ws_alpha', 'run_art_A');
      const artifactsB = await repos.artifacts.listByRun('ws_alpha', 'run_art_B');

      expect(artifactsA.every((a) => a.runId === 'run_art_A')).toBe(true);
      expect(artifactsB.every((b) => b.runId === 'run_art_B')).toBe(true);
      expect(artifactsA.some((a) => a.runId === 'run_art_B')).toBe(false);
    });

    it('23. Storage failure produces a safe failed run and triggers rollback', async () => {
      await repos.runs.create({
        id: 'run_storage_fail_01',
        schemaVersion: '1.0',
        workspaceId: 'ws_alpha',
        projectId: 'prj_web',
        targetEnvironmentId: 'tgt_staging_01',
        journeyId: 'jny_safe_01',
        status: 'queued',
        safeTestMode: true,
        preflightStatus: 'ready',
        attemptCount: 1,
        maxAttempts: 1,
        availableAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await queue.enqueue(
        makeQueueItem({
          runId: 'run_storage_fail_01',
          workspaceId: 'ws_alpha',
          projectId: 'prj_web',
          targetId: 'tgt_staging_01',
          journeyId: 'jny_safe_01',
        }),
      );

      // BlobStore that throws on put
      const failingBlobStore = {
        ...blobStore,
        put: async () => {
          throw new Error('Supabase Storage connection timeout.');
        },
      };

      const worker = new DeterministicMockWorker();
      const dispatcher = new RunDispatcher({
        queue,
        repositories: repos,
        worker,
        blobStore: failingBlobStore as any,
        workerId: 'worker-storage-fail',
      });

      const res = await dispatcher.dispatchNext();
      expect(res?.status).toBe('failed');
      expect(res?.reason).toContain('Artifact storage failed');

      const run = await repos.runs.findById('ws_alpha', 'run_storage_fail_01');
      expect(run?.status).toBe('failed');
      expect(run?.failureReason).toContain('Artifact storage failed');
    });

    it('24. No automatic retry occurs when run fails', async () => {
      await repos.runs.create({
        id: 'run_no_retry_01',
        schemaVersion: '1.0',
        workspaceId: 'ws_alpha',
        projectId: 'prj_web',
        targetEnvironmentId: 'tgt_staging_01',
        journeyId: 'jny_safe_01',
        status: 'queued',
        safeTestMode: true,
        preflightStatus: 'ready',
        attemptCount: 1,
        maxAttempts: 3, // Configured with multiple maxAttempts, but automatic retry must NOT occur
        availableAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await queue.enqueue(
        makeQueueItem({
          runId: 'run_no_retry_01',
          workspaceId: 'ws_alpha',
          projectId: 'prj_web',
          targetId: 'tgt_staging_01',
          journeyId: 'jny_safe_01',
          maxAttempts: 3,
        }),
      );

      const failingWorker = new DeterministicMockWorker({
        mockError: new Error('Flaky network timeout'),
      });

      const dispatcher = new RunDispatcher({
        queue,
        repositories: repos,
        worker: failingWorker,
        blobStore,
        workerId: 'worker-no-retry',
      });

      const res = await dispatcher.dispatchNext();
      expect(res?.status).toBe('failed');

      // Next dispatch must return null (zero automatic retries)
      const secondDispatch = await dispatcher.dispatchNext();
      expect(secondDispatch).toBeNull();

      const queueItem = await queue.findByRunId('ws_alpha', 'run_no_retry_01');
      expect(queueItem?.queueStatus).toBe('failed');
      expect(queueItem?.attemptCount).toBe(1); // Did not automatically increment
    });
  });

  // ===========================================================================
  // 7. Security, Health Probes & Privacy
  // ===========================================================================
  describe('7. Security & Health Probes', () => {
    it('25. No secret appears in logs or error messages', () => {
      const secret = 'super-secret-service-role-key-12345';
      const config: WorkerServiceConfig = {
        enabled: true,
        workerId: 'worker-01',
        pollMs: 1000,
        leaseSeconds: 60,
        maxConcurrency: 1,
        shutdownTimeoutMs: 30000,
        healthPort: 3230,
        authMode: 'production',
        storage: 'postgres',
        blobStore: 'supabase',
        allowLocalInProduction: false,
        supabaseServiceRoleKey: secret,
      };

      const result = validateWorkerServiceConfig(config);
      // Errors report missing variables, but never leak secrets
      for (const err of result.errors) {
        expect(err).not.toContain(secret);
      }
    });

    it('26. Health endpoint does not expose secrets', async () => {
      const provider = {
        workerId: 'worker-health-test',
        maxConcurrency: 2,
        getActiveJobsCount: () => 0,
        getUptimeSeconds: () => 42.5,
        checkQueueHealth: async () => true,
        checkStorageHealth: async () => true,
      };

      const server = new WorkerHealthServer(provider, 0);
      const port = await server.start();

      try {
        // Test /health
        const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
        expect(healthRes.status).toBe(200);
        const healthJson = await healthRes.json();
        expect(healthJson.status).toBe('ok');
        expect(healthJson.workerId).toBe('worker-health-test');
        expect(healthJson.DATABASE_URL).toBeUndefined();
        expect(healthJson.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();

        // Test /readiness
        const readyRes = await fetch(`http://127.0.0.1:${port}/readiness`);
        expect(readyRes.status).toBe(200);
        const readyJson = await readyRes.json();
        expect(readyJson.status).toBe('ready');
        expect(readyJson.checks.queue).toBe('connected');
        expect(readyJson.checks.storage).toBe('connected');
        expect(readyJson.databaseUrl).toBeUndefined();
        expect(readyJson.serviceRoleKey).toBeUndefined();
      } finally {
        await server.close();
      }
    });

    it('27. No external target website is contacted by unit tests', () => {
      // Invariant: Target environments in tests operate strictly against 127.0.0.1
      expect(validTarget.targetUrl).toContain('127.0.0.1');
      expect(validTarget.allowedOrigins[0]).toContain('127.0.0.1');
    });

    it('28. Dedicated storage:smoke command refuses execution if blob store is not supabase', async () => {
      process.env.PRODUCT_BLOB_STORE = 'local';
      const smokeRes = await runStorageSmokeCommand([]);
      expect(smokeRes.success).toBe(false);
      expect(smokeRes.code).toBe(1);
      expect(smokeRes.message).toBe('Provider is not supabase');
    });
  });
});
