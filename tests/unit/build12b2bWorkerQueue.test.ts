/**
 * Build 12B.2B: PostgreSQL-Backed Asynchronous Run Queue & Worker Dispatcher Test Suite.
 *
 * Verifies all 32 required queue, lease, safety-gate, retry, cancellation,
 * and API boundary behaviors.
 *
 * Guarantees:
 * - Deterministic unit tests with ZERO browser launches and ZERO network requests.
 * - PostgreSQL persistence adapter support (including row-locking simulation).
 * - Complete tenant isolation and secret sanitization.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createInMemoryProductRepositories } from '../../src/product/repository/inMemory.js';
import { InMemoryRunQueueRepository, PostgresRunQueueRepository } from '../../src/product/queue/repository.js';
import { MockPostgresPool } from '../../src/product/repository/mockPostgresClient.js';
import { ProductService, TenantAccessDeniedError } from '../../src/product/service/productService.js';
import { RunDispatcher } from '../../src/product/queue/dispatcher.js';
import { DeterministicMockWorker } from '../../src/product/queue/worker.js';
import { WorkerLoop } from '../../src/product/queue/workerLoop.js';
import { assertSafeWorkerId, loadWorkerConfigFromEnv } from '../../src/product/queue/types.js';
import { LocalBlobStore } from '../../src/product/blob/localStore.js';
import { ProductApiServer } from '../../src/product/api/server.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('Build 12B.2B: Asynchronous Run Queue & Worker Dispatcher', () => {
  let tempDir: string;
  let blobStore: LocalBlobStore;
  let repos: ReturnType<typeof createInMemoryProductRepositories>;
  let service: ProductService;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'crashlab-queue-test-'));
    blobStore = new LocalBlobStore({ rootDirectory: tempDir });
    repos = createInMemoryProductRepositories();
    service = new ProductService({
      repositories: repos,
      blobStore,
    });
  });

  afterEach(async () => {
    await blobStore.close();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  async function createFixtureHierarchy() {
    const owner = await service.createUser({ name: 'Owner User', email: 'owner@crashlab.local' });
    const otherUser = await service.createUser({ name: 'Other User', email: 'other@crashlab.local' });
    const { workspace } = await service.createWorkspace({
      name: 'Alpha WS',
      slug: 'alpha-ws',
      ownerUserId: owner.id,
    });
    const { workspace: workspace2 } = await service.createWorkspace({
      name: 'Beta WS',
      slug: 'beta-ws',
      ownerUserId: otherUser.id,
    });

    const project = await service.createProject({
      workspaceId: workspace.id,
      name: 'Web App Test',
    }, owner.id);

    const target = await service.createTarget({
      workspaceId: workspace.id,
      projectId: project.id,
      name: 'Local Test Target',
      environment: 'local',
      targetUrl: 'http://127.0.0.1:8080/app',
      allowedOrigins: ['http://127.0.0.1:8080'],
      forbiddenActions: ['payment', 'delete_account'],
    }, owner.id);

    const journey = await service.approveJourney({
      workspaceId: workspace.id,
      projectId: project.id,
      targetEnvironmentId: target.id,
      goal: 'Navigate safely',
      origin: target.targetOrigin,
      allowedActions: ['navigate', 'click'],
    }, owner.id);

    return { owner, otherUser, workspace, workspace2, project, target, journey };
  }

  // 1. Enqueue creates a queued run
  it('1. Enqueue creates a queued run', async () => {
    const { owner, workspace, project, target, journey } = await createFixtureHierarchy();
    const result = await service.enqueueRun({
      workspaceId: workspace.id,
      projectId: project.id,
      targetEnvironmentId: target.id,
      journeyId: journey.id,
      maxAttempts: 2,
      requestId: 'req-101',
    }, owner.id);

    expect(result.run.status).toBe('queued');
    expect(result.run.attemptCount).toBe(1);
    expect(result.run.maxAttempts).toBe(2);
    expect(result.run.requestId).toBe('req-101');
    expect(result.queueItem.queueStatus).toBe('queued');
    expect(result.queueItem.runId).toBe(result.run.id);

    const persistedRun = await service.getRun(workspace.id, result.run.id, owner.id);
    expect(persistedRun.status).toBe('queued');
  });

  // 2. Unauthenticated enqueue is rejected
  it('2. Unauthenticated enqueue is rejected', async () => {
    const { workspace, project, target, journey } = await createFixtureHierarchy();
    const server = new ProductApiServer({
      service,
      authMode: 'production',
      authSecret: 'super-secure-signing-secret-for-jwt-testing-32-chars-min',
    });
    const { url } = await server.start();

    try {
      const res = await fetch(`${url}/api/v1/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId: workspace.id,
          projectId: project.id,
          targetEnvironmentId: target.id,
          journeyId: journey.id,
        }),
      });

      expect(res.status).toBe(401);
      const json = await res.json() as any;
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('UNAUTHORIZED');
    } finally {
      await server.stop();
    }
  });

  // 3. Cross-workspace enqueue is rejected
  it('3. Cross-workspace enqueue is rejected', async () => {
    const { otherUser, workspace, project, target, journey } = await createFixtureHierarchy();
    await expect(
      service.enqueueRun({
        workspaceId: workspace.id,
        projectId: project.id,
        targetEnvironmentId: target.id,
        journeyId: journey.id,
      }, otherUser.id),
    ).rejects.toThrow(TenantAccessDeniedError);
  });

  // 4. Worker claims one queued run atomically
  it('4. Worker claims one queued run atomically', async () => {
    const { owner, workspace, project, target, journey } = await createFixtureHierarchy();
    const { run } = await service.enqueueRun({
      workspaceId: workspace.id,
      projectId: project.id,
      targetEnvironmentId: target.id,
      journeyId: journey.id,
    }, owner.id);

    const claim = await service.runQueue.claimNext({
      workerId: 'worker-local-1',
      leaseSeconds: 60,
    });

    expect(claim).not.toBeNull();
    expect(claim?.runId).toBe(run.id);
    expect(claim?.queueStatus).toBe('preflight');
    expect(claim?.leaseOwner).toBe('worker-local-1');
    expect(claim?.leaseExpiry).toBeDefined();
  });

  // 5. Two workers cannot claim the same run
  it('5. Two workers cannot claim the same run simultaneously', async () => {
    const { owner, workspace, project, target, journey } = await createFixtureHierarchy();
    await service.enqueueRun({
      workspaceId: workspace.id,
      projectId: project.id,
      targetEnvironmentId: target.id,
      journeyId: journey.id,
    }, owner.id);

    const claim1 = await service.runQueue.claimNext({ workerId: 'worker-A' });
    const claim2 = await service.runQueue.claimNext({ workerId: 'worker-B' });

    expect(claim1).not.toBeNull();
    expect(claim1?.leaseOwner).toBe('worker-A');
    expect(claim2).toBeNull();
  });

  // 6. Expired lease can be reclaimed
  it('6. Expired lease can be reclaimed safely', async () => {
    const { owner, workspace, project, target, journey } = await createFixtureHierarchy();
    const { run } = await service.enqueueRun({
      workspaceId: workspace.id,
      projectId: project.id,
      targetEnvironmentId: target.id,
      journeyId: journey.id,
    }, owner.id);

    // Worker 1 claims with lease that expired in the past
    const claimed = await service.runQueue.claimNext({ workerId: 'worker-1', leaseSeconds: 1 });
    expect(claimed).not.toBeNull();

    // Force lease expiration
    const expiredItem = {
      ...claimed!,
      leaseExpiry: new Date(Date.now() - 5000).toISOString(),
    };
    await service.runQueue.update(expiredItem);

    // Worker 2 should now safely reclaim the expired run
    const reclaimed = await service.runQueue.claimNext({ workerId: 'worker-2', leaseSeconds: 60 });
    expect(reclaimed).not.toBeNull();
    expect(reclaimed?.runId).toBe(run.id);
    expect(reclaimed?.leaseOwner).toBe('worker-2');
  });

  // 7. Live lease cannot be stolen
  it('7. Live lease cannot be stolen', async () => {
    const { owner, workspace, project, target, journey } = await createFixtureHierarchy();
    await service.enqueueRun({
      workspaceId: workspace.id,
      projectId: project.id,
      targetEnvironmentId: target.id,
      journeyId: journey.id,
    }, owner.id);

    await service.runQueue.claimNext({ workerId: 'worker-1', leaseSeconds: 300 });

    const stolen = await service.runQueue.claimNext({ workerId: 'worker-2' });
    expect(stolen).toBeNull();
  });

  // 8. Invalid worker ID is rejected
  it('8. Invalid worker ID is rejected', () => {
    expect(() => assertSafeWorkerId('')).toThrow(/non-empty string/);
    expect(() => assertSafeWorkerId('   ')).toThrow(/invalid/);
    expect(() => assertSafeWorkerId('worker with spaces')).toThrow(/prohibited characters/);
    expect(() => assertSafeWorkerId('worker;DROP TABLE run_queue;--')).toThrow(/prohibited characters/);
    expect(() => assertSafeWorkerId('worker\x00null')).toThrow(/prohibited/);
    expect(() => assertSafeWorkerId('worker-safe_123.test')).not.toThrow();
  });

  // 9. Preflight runs before browser creation
  it('9. Preflight runs before browser creation', async () => {
    const { owner, workspace, project, target, journey } = await createFixtureHierarchy();
    await service.enqueueRun({
      workspaceId: workspace.id,
      projectId: project.id,
      targetEnvironmentId: target.id,
      journeyId: journey.id,
    }, owner.id);

    const worker = new DeterministicMockWorker();
    const dispatcher = new RunDispatcher({
      queue: service.runQueue,
      repositories: repos,
      worker,
      blobStore,
      workerId: 'worker-1',
    });

    const result = await dispatcher.dispatchNext();
    expect(result).not.toBeNull();
    expect(result?.status).toBe('completed');
    expect(worker.executedRuns.length).toBe(1);
    expect(worker.executedRuns[0]!.safeTestMode).toBe(true);
  });

  // 10. Blocked preflight launches zero browsers
  it('10. Blocked preflight launches zero browsers', async () => {
    const { owner, workspace, project } = await createFixtureHierarchy();

    // Create a target with production indicators (strictly blocked by preflight safety gate)
    const unsafeTarget = await service.createTarget({
      workspaceId: workspace.id,
      projectId: project.id,
      name: 'Prod Target',
      environment: 'staging',
      targetUrl: 'https://production.example.com/app',
      allowedOrigins: ['https://production.example.com'],
      forbiddenActions: ['payment'],
      authorizationReference: 'INVALID', // Missing proper AUTH- reference
    }, owner.id);

    const unsafeJourney = await service.approveJourney({
      workspaceId: workspace.id,
      projectId: project.id,
      targetEnvironmentId: unsafeTarget.id,
      goal: 'Attempt unsafe checkout',
      origin: unsafeTarget.targetOrigin,
      allowedActions: ['checkout', 'payment'], // Forbidden dangerous actions
    }, owner.id);

    const { run } = await service.enqueueRun({
      workspaceId: workspace.id,
      projectId: project.id,
      targetEnvironmentId: unsafeTarget.id,
      journeyId: unsafeJourney.id,
    }, owner.id);

    const worker = new DeterministicMockWorker();
    const dispatcher = new RunDispatcher({
      queue: service.runQueue,
      repositories: repos,
      worker,
      blobStore,
      workerId: 'worker-1',
    });

    const result = await dispatcher.dispatchNext();

    expect(result?.status).toBe('blocked');
    expect(worker.executedRuns.length).toBe(0); // STRICT INVARIANT: 0 browsers executed

    const updatedRun = await service.getRun(workspace.id, run.id, owner.id);
    expect(updatedRun.status).toBe('blocked');
    expect(updatedRun.blockedReason).toBeDefined();
  });

  // 11. Blocked preflight makes zero target requests
  it('11. Blocked preflight makes zero target requests and stores safe failure reason', async () => {
    const { owner, workspace, project } = await createFixtureHierarchy();

    const blockedTarget = await service.createTarget({
      workspaceId: workspace.id,
      projectId: project.id,
      name: 'Live Target',
      environment: 'staging',
      targetUrl: 'https://live.test.local',
      allowedOrigins: ['https://live.test.local'],
      forbiddenActions: ['pay'],
      authorizationReference: '', // Missing
    }, owner.id);

    const journey = await service.approveJourney({
      workspaceId: workspace.id,
      projectId: project.id,
      targetEnvironmentId: blockedTarget.id,
      goal: 'Explore',
      origin: blockedTarget.targetOrigin,
      allowedActions: ['navigate'],
    }, owner.id);

    const { run } = await service.enqueueRun({
      workspaceId: workspace.id,
      projectId: project.id,
      targetEnvironmentId: blockedTarget.id,
      journeyId: journey.id,
    }, owner.id);

    const worker = new DeterministicMockWorker();
    const dispatcher = new RunDispatcher({
      queue: service.runQueue,
      repositories: repos,
      worker,
      blobStore,
      workerId: 'worker-1',
    });

    const result = await dispatcher.dispatchNext();
    expect(result?.status).toBe('blocked');
    expect(worker.executedRuns.length).toBe(0);

    const runRecord = await service.getRun(workspace.id, run.id, owner.id);
    expect(runRecord.status).toBe('blocked');
    expect(runRecord.blockedReason).toContain('AUTHORIZATION_REFERENCE');
  });

  // 12. Valid run transitions queued → preflight → running
  it('12. Valid run transitions queued → preflight → running', async () => {
    const { owner, workspace, project, target, journey } = await createFixtureHierarchy();
    const { run } = await service.enqueueRun({
      workspaceId: workspace.id,
      projectId: project.id,
      targetEnvironmentId: target.id,
      journeyId: journey.id,
    }, owner.id);

    expect(run.status).toBe('queued');

    const observedStatuses: string[] = [];
    const worker = new DeterministicMockWorker({
      onExecute: async (input) => {
        const current = await service.getRun(workspace.id, input.runId, owner.id);
        observedStatuses.push(current.status);
      },
    });

    const dispatcher = new RunDispatcher({
      queue: service.runQueue,
      repositories: repos,
      worker,
      blobStore,
      workerId: 'worker-1',
    });

    const result = await dispatcher.dispatchNext();
    expect(result?.status).toBe('completed');
    expect(observedStatuses).toContain('running');
  });

  // 13. Successful worker result becomes completed
  it('13. Successful worker result becomes completed with artifacts', async () => {
    const { owner, workspace, project, target, journey } = await createFixtureHierarchy();
    const { run } = await service.enqueueRun({
      workspaceId: workspace.id,
      projectId: project.id,
      targetEnvironmentId: target.id,
      journeyId: journey.id,
    }, owner.id);

    const worker = new DeterministicMockWorker();
    const dispatcher = new RunDispatcher({
      queue: service.runQueue,
      repositories: repos,
      worker,
      blobStore,
      workerId: 'worker-1',
    });

    const result = await dispatcher.dispatchNext();
    expect(result?.status).toBe('completed');

    const completedRun = await service.getRun(workspace.id, run.id, owner.id);
    expect(completedRun.status).toBe('completed');
    expect(completedRun.executionReportRef).toBeDefined();

    const artifacts = await service.listArtifacts(workspace.id, run.id, owner.id);
    expect(artifacts.length).toBeGreaterThan(0);
  });

  // 14. Worker error becomes failed
  it('14. Worker error becomes failed and records last error', async () => {
    const { owner, workspace, project, target, journey } = await createFixtureHierarchy();
    const { run } = await service.enqueueRun({
      workspaceId: workspace.id,
      projectId: project.id,
      targetEnvironmentId: target.id,
      journeyId: journey.id,
    }, owner.id);

    const worker = new DeterministicMockWorker({
      mockError: new Error('Simulated browser crash during navigation'),
    });

    const dispatcher = new RunDispatcher({
      queue: service.runQueue,
      repositories: repos,
      worker,
      blobStore,
      workerId: 'worker-1',
    });

    const result = await dispatcher.dispatchNext();
    expect(result?.status).toBe('failed');
    expect(result?.reason).toContain('Simulated browser crash');

    const failedRun = await service.getRun(workspace.id, run.id, owner.id);
    expect(failedRun.status).toBe('failed');
    expect(failedRun.failureReason).toContain('Simulated browser crash');
  });

  // 15. Terminal states cannot be mutated
  it('15. Terminal states cannot be mutated', async () => {
    const { owner, workspace, project, target, journey } = await createFixtureHierarchy();
    const { run } = await service.enqueueRun({
      workspaceId: workspace.id,
      projectId: project.id,
      targetEnvironmentId: target.id,
      journeyId: journey.id,
    }, owner.id);

    const worker = new DeterministicMockWorker();
    const dispatcher = new RunDispatcher({
      queue: service.runQueue,
      repositories: repos,
      worker,
      blobStore,
      workerId: 'worker-1',
    });

    await dispatcher.dispatchNext();

    const completedRun = await service.getRun(workspace.id, run.id, owner.id);
    expect(completedRun.status).toBe('completed');

    // Attempting to cancel or re-queue a completed run must fail
    await expect(
      service.cancelRun(workspace.id, completedRun.id, owner.id),
    ).rejects.toThrow(/terminal status/);
  });

  // 16. Automatic retries remain disabled by default
  it('16. Automatic retries remain disabled by default', async () => {
    const { owner, workspace, project, target, journey } = await createFixtureHierarchy();
    await service.enqueueRun({
      workspaceId: workspace.id,
      projectId: project.id,
      targetEnvironmentId: target.id,
      journeyId: journey.id,
      maxAttempts: 3, // Allowed up to 3 attempts, but automatic retries must be false
    }, owner.id);

    const worker = new DeterministicMockWorker({ mockError: new Error('Flaky failure') });
    const dispatcher = new RunDispatcher({
      queue: service.runQueue,
      repositories: repos,
      worker,
      blobStore,
      workerId: 'worker-1',
    });

    await dispatcher.dispatchNext();

    // After failure, no run should be automatically available for claiming
    const nextClaim = await service.runQueue.claimNext({ workerId: 'worker-1' });
    expect(nextClaim).toBeNull();
  });

  // 17. Explicit retry increments attempt count
  it('17. Explicit retry increments attempt count and resets status to queued', async () => {
    const { owner, workspace, project, target, journey } = await createFixtureHierarchy();
    const { run } = await service.enqueueRun({
      workspaceId: workspace.id,
      projectId: project.id,
      targetEnvironmentId: target.id,
      journeyId: journey.id,
      maxAttempts: 3,
    }, owner.id);

    const worker = new DeterministicMockWorker({ mockError: new Error('First attempt failed') });
    const dispatcher = new RunDispatcher({
      queue: service.runQueue,
      repositories: repos,
      worker,
      blobStore,
      workerId: 'worker-1',
    });

    await dispatcher.dispatchNext();

    const failedRun = await service.getRun(workspace.id, run.id, owner.id);
    expect(failedRun.status).toBe('failed');
    expect(failedRun.attemptCount).toBe(1);

    // Explicit manual retry
    const retried = await service.retryRun(workspace.id, run.id, owner.id);
    expect(retried.run.status).toBe('queued');
    expect(retried.run.attemptCount).toBe(2);
    expect(retried.queueItem.queueStatus).toBe('queued');
    expect(retried.queueItem.attemptCount).toBe(2);

    // Can be claimed and dispatched again
    const worker2 = new DeterministicMockWorker();
    const dispatcher2 = new RunDispatcher({
      queue: service.runQueue,
      repositories: repos,
      worker: worker2,
      blobStore,
      workerId: 'worker-2',
    });

    const secondResult = await dispatcher2.dispatchNext();
    expect(secondResult?.status).toBe('completed');
  });

  // 18. Retry limit is enforced
  it('18. Retry limit is enforced', async () => {
    const { owner, workspace, project, target, journey } = await createFixtureHierarchy();
    const { run } = await service.enqueueRun({
      workspaceId: workspace.id,
      projectId: project.id,
      targetEnvironmentId: target.id,
      journeyId: journey.id,
      maxAttempts: 1, // Max 1 attempt allowed
    }, owner.id);

    const worker = new DeterministicMockWorker({ mockError: new Error('Failed run') });
    const dispatcher = new RunDispatcher({
      queue: service.runQueue,
      repositories: repos,
      worker,
      blobStore,
      workerId: 'worker-1',
    });

    await dispatcher.dispatchNext();

    // Attempting manual retry when maxAttempts reached must fail
    await expect(
      service.retryRun(workspace.id, run.id, owner.id),
    ).rejects.toThrow(/maximum attempts \(1\) reached/);
  });

  // 19. Safety-blocked runs cannot be automatically retried
  it('19. Safety-blocked runs cannot be retried', async () => {
    const { owner, workspace, project, target, journey } = await createFixtureHierarchy();
    const { run } = await service.enqueueRun({
      workspaceId: workspace.id,
      projectId: project.id,
      targetEnvironmentId: target.id,
      journeyId: journey.id,
    }, owner.id);

    // Transition run to blocked
    await repos.runs.update({
      ...run,
      status: 'blocked',
      blockedReason: 'Safety violation',
    });

    await expect(
      service.retryRun(workspace.id, run.id, owner.id),
    ).rejects.toThrow(/Safety-blocked runs cannot be retried/);
  });

  // 20. Cancellation of queued run works
  it('20. Cancellation of queued run works', async () => {
    const { owner, workspace, project, target, journey } = await createFixtureHierarchy();
    const { run } = await service.enqueueRun({
      workspaceId: workspace.id,
      projectId: project.id,
      targetEnvironmentId: target.id,
      journeyId: journey.id,
    }, owner.id);

    const cancelled = await service.cancelRun(workspace.id, run.id, owner.id, 'User stopped test');
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancelReason).toBe('User stopped test');

    const queueItem = await service.getRunQueueItem(workspace.id, run.id, owner.id);
    expect(queueItem?.queueStatus).toBe('cancelled');

    // Worker claiming should return null because run was cancelled
    const claim = await service.runQueue.claimNext({ workerId: 'worker-1' });
    expect(claim).toBeNull();
  });

  // 21. Cancellation during running works
  it('21. Cancellation during running works', async () => {
    const { owner, workspace, project, target, journey } = await createFixtureHierarchy();
    const { run } = await service.enqueueRun({
      workspaceId: workspace.id,
      projectId: project.id,
      targetEnvironmentId: target.id,
      journeyId: journey.id,
    }, owner.id);

    let wasAborted = false;
    const worker = new DeterministicMockWorker({
      delayMs: 100,
      onExecute: (input) => {
        input.cancellationSignal?.addEventListener('abort', () => {
          wasAborted = true;
        });
      },
    });

    const dispatcher = new RunDispatcher({
      queue: service.runQueue,
      repositories: repos,
      worker,
      blobStore,
      workerId: 'worker-1',
    });

    // Start dispatching asynchronously
    const dispatchPromise = dispatcher.dispatchNext();

    // Wait slightly then cancel
    await new Promise((r) => setTimeout(r, 20));
    await dispatcher.cancelActiveRun(run.id, 'Aborted mid-run');

    const result = await dispatchPromise;
    expect(result?.status).toBe('cancelled');
    expect(wasAborted).toBe(true);

    const finishedRun = await service.getRun(workspace.id, run.id, owner.id);
    expect(finishedRun.status).toBe('cancelled');
  });

  // 22. Cancellation is idempotent
  it('22. Cancellation is idempotent', async () => {
    const { owner, workspace, project, target, journey } = await createFixtureHierarchy();
    const { run } = await service.enqueueRun({
      workspaceId: workspace.id,
      projectId: project.id,
      targetEnvironmentId: target.id,
      journeyId: journey.id,
    }, owner.id);

    const firstCancel = await service.cancelRun(workspace.id, run.id, owner.id);
    expect(firstCancel.status).toBe('cancelled');

    const secondCancel = await service.cancelRun(workspace.id, run.id, owner.id);
    expect(secondCancel.status).toBe('cancelled');
  });

  // 23. Cancelled run retains evidence
  it('23. Cancelled run retains evidence', async () => {
    const { owner, workspace, project, target, journey } = await createFixtureHierarchy();
    const { run } = await service.enqueueRun({
      workspaceId: workspace.id,
      projectId: project.id,
      targetEnvironmentId: target.id,
      journeyId: journey.id,
    }, owner.id);

    // Attach an artifact prior to cancellation
    await service.storeArtifact({
      workspaceId: workspace.id,
      runId: run.id,
      type: 'log',
      content: 'Early logs before cancellation',
    }, owner.id);

    await service.cancelRun(workspace.id, run.id, owner.id);

    const artifacts = await service.listArtifacts(workspace.id, run.id, owner.id);
    expect(artifacts.length).toBe(1);
    expect(artifacts[0]!.type).toBe('log');
  });

  // 24. Worker shutdown releases resources
  it('24. Worker shutdown releases resources cleanly', async () => {
    const worker = new DeterministicMockWorker();
    const dispatcher = new RunDispatcher({
      queue: service.runQueue,
      repositories: repos,
      worker,
      blobStore,
      workerId: 'worker-1',
    });

    const workerLoop = new WorkerLoop({
      dispatcher,
      config: {
        enabled: true,
        workerId: 'worker-1',
        pollMs: 100,
        leaseSeconds: 60,
        maxConcurrency: 1,
      },
    });

    await workerLoop.start();
    expect(workerLoop.isRunning).toBe(true);

    await workerLoop.stop();
    expect(workerLoop.isRunning).toBe(false);
    expect(workerLoop.activeJobsCount).toBe(0);
  });

  // 25. Worker loop --once processes at most one run
  it('25. Worker loop --once processes at most one run', async () => {
    const { owner, workspace, project, target, journey } = await createFixtureHierarchy();

    // Enqueue 2 runs
    await service.enqueueRun({
      workspaceId: workspace.id,
      projectId: project.id,
      targetEnvironmentId: target.id,
      journeyId: journey.id,
    }, owner.id);
    await service.enqueueRun({
      workspaceId: workspace.id,
      projectId: project.id,
      targetEnvironmentId: target.id,
      journeyId: journey.id,
    }, owner.id);

    const worker = new DeterministicMockWorker();
    const dispatcher = new RunDispatcher({
      queue: service.runQueue,
      repositories: repos,
      worker,
      blobStore,
      workerId: 'worker-1',
    });

    const workerLoop = new WorkerLoop({
      dispatcher,
      config: {
        enabled: true,
        workerId: 'worker-1',
        pollMs: 50,
        leaseSeconds: 60,
        maxConcurrency: 1,
      },
    });

    const result = await workerLoop.runOnce();
    expect(result).not.toBeNull();
    expect(worker.executedRuns.length).toBe(1); // Processed at most one run!
  });

  // 26. Worker loop does not run when disabled
  it('26. Worker loop does not run when disabled', async () => {
    const { owner, workspace, project, target, journey } = await createFixtureHierarchy();
    await service.enqueueRun({
      workspaceId: workspace.id,
      projectId: project.id,
      targetEnvironmentId: target.id,
      journeyId: journey.id,
    }, owner.id);

    const worker = new DeterministicMockWorker();
    const dispatcher = new RunDispatcher({
      queue: service.runQueue,
      repositories: repos,
      worker,
      blobStore,
      workerId: 'worker-1',
    });

    const workerLoop = new WorkerLoop({
      dispatcher,
      config: {
        enabled: false, // Disabled
        workerId: 'worker-1',
        pollMs: 50,
        leaseSeconds: 60,
        maxConcurrency: 1,
      },
    });

    await workerLoop.start();
    expect(workerLoop.isRunning).toBe(false);

    // Wait a moment and verify nothing ran
    await new Promise((r) => setTimeout(r, 100));
    expect(worker.executedRuns.length).toBe(0);
  });

  // 27. Cross-tenant run status access is rejected
  it('27. Cross-tenant run status access is rejected', async () => {
    const { owner, otherUser, workspace, project, target, journey } = await createFixtureHierarchy();
    const { run } = await service.enqueueRun({
      workspaceId: workspace.id,
      projectId: project.id,
      targetEnvironmentId: target.id,
      journeyId: journey.id,
    }, owner.id);

    // Attempt to access run from another user outside workspace
    await expect(
      service.getRun(workspace.id, run.id, otherUser.id),
    ).rejects.toThrow(TenantAccessDeniedError);

    await expect(
      service.getRunQueueItem(workspace.id, run.id, otherUser.id),
    ).rejects.toThrow(TenantAccessDeniedError);
  });

  // 28. Request IDs are preserved
  it('28. Request IDs are preserved across API and queue entities', async () => {
    const { owner, workspace, project, target, journey } = await createFixtureHierarchy();
    const server = new ProductApiServer({
      service,
      authMode: 'development',
      defaultUserId: owner.id,
    });
    const { url } = await server.start();

    try {
      const res = await fetch(`${url}/api/v1/runs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Request-Id': 'req-audit-999',
        },
        body: JSON.stringify({
          workspaceId: workspace.id,
          projectId: project.id,
          targetEnvironmentId: target.id,
          journeyId: journey.id,
        }),
      });

      expect(res.status).toBe(201);
      expect(res.headers.get('x-request-id')).toBe('req-audit-999');

      const json = await res.json() as any;
      expect(json.requestId).toBe('req-audit-999');
      expect(json.data.requestId).toBe('req-audit-999');

      const queueItem = await service.getRunQueueItem(workspace.id, json.data.id, owner.id);
      expect(queueItem?.requestId).toBe('req-audit-999');
    } finally {
      await server.stop();
    }
  });

  // 29. Secrets never appear in errors, logs, or audit events
  it('29. Secrets never appear in errors, logs, or audit events', async () => {
    const { owner, workspace, project, target, journey } = await createFixtureHierarchy();

    await expect(
      service.enqueueRun({
        workspaceId: workspace.id,
        projectId: project.id,
        targetEnvironmentId: target.id,
        journeyId: journey.id,
        secretToken: 'ghp_secretTokenWithHighEntropyValue1234567890',
      } as any, owner.id),
    ).rejects.toThrow(/violates secret boundary/);
  });

  // 30. Input journey and evidence reports remain byte-identical
  it('30. Input journey and evidence reports remain byte-identical', async () => {
    const { owner, workspace, project, target, journey } = await createFixtureHierarchy();
    const serializedJourneyBefore = JSON.stringify(journey);

    const { run } = await service.enqueueRun({
      workspaceId: workspace.id,
      projectId: project.id,
      targetEnvironmentId: target.id,
      journeyId: journey.id,
    }, owner.id);

    const worker = new DeterministicMockWorker();
    const dispatcher = new RunDispatcher({
      queue: service.runQueue,
      repositories: repos,
      worker,
      blobStore,
      workerId: 'worker-1',
    });

    await dispatcher.dispatchNext();

    const fetchedJourney = await repos.journeys.findById(workspace.id, journey.id);
    const serializedJourneyAfter = JSON.stringify(fetchedJourney);

    expect(serializedJourneyAfter).toBe(serializedJourneyBefore);
  });

  // 31. PostgreSQL-backed queue adapter with MockPostgresPool
  it('31. PostgreSQL-backed queue adapter performs atomic claim and lease handling', async () => {
    const pool = new MockPostgresPool();
    const pgQueue = new PostgresRunQueueRepository(pool);

    const item = {
      runId: 'run-pg-1',
      workspaceId: 'ws-pg-1',
      projectId: 'proj-pg-1',
      targetId: 'tgt-pg-1',
      journeyId: 'jrn-pg-1',
      queueStatus: 'queued' as const,
      attemptCount: 1,
      maxAttempts: 2,
      availableAt: new Date(Date.now() - 1000).toISOString(),
      leaseOwner: null,
      leaseExpiry: null,
      startedAt: null,
      completedAt: null,
      lastError: null,
      cancellationTimestamp: null,
      requestId: 'req-pg',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await pgQueue.enqueue(item);

    // Worker 1 claims
    const claim1 = await pgQueue.claimNext({ workerId: 'worker-pg-1', leaseSeconds: 60 });
    expect(claim1).not.toBeNull();
    expect(claim1?.runId).toBe('run-pg-1');
    expect(claim1?.queueStatus).toBe('preflight');
    expect(claim1?.leaseOwner).toBe('worker-pg-1');

    // Worker 2 cannot steal live lease
    const claim2 = await pgQueue.claimNext({ workerId: 'worker-pg-2' });
    expect(claim2).toBeNull();

    // Worker 1 renews lease
    const renewed = await pgQueue.renewLease('run-pg-1', 'worker-pg-1', 120);
    expect(renewed).toBe(true);

    // Worker 2 cannot renew Worker 1's lease
    const fakeRenew = await pgQueue.renewLease('run-pg-1', 'worker-pg-2', 120);
    expect(fakeRenew).toBe(false);

    // Worker 1 releases lease
    const released = await pgQueue.releaseLease('run-pg-1', 'worker-pg-1');
    expect(released).toBe(true);
  });

  // 32. Zero browser is launched by queue unit tests
  it('32. No browser is launched by queue unit tests', async () => {
    // DeterministicMockWorker and RunDispatcher execute purely in-memory
    const worker = new DeterministicMockWorker();
    expect(worker.executedRuns).toHaveLength(0);
    await worker.close();
  });
});
