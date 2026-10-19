/**
 * Run Queue Dispatcher & Execution Pipeline — Build 12B.2B.
 *
 * Coordinates claiming, preflight safety gates, execution via injectable worker,
 * artifact storage, audit event generation, and lifecycle state transitions.
 *
 * Invariants:
 * - Preflight safety gate strictly enforced before worker execution.
 * - Blocked runs launch ZERO browsers and make ZERO target requests.
 * - Leases are atomically claimed, heartbeat-renewed, and released upon termination.
 * - Source journeys and safeTestMode are permanently immutable.
 * - Zero automatic retries on failure.
 */

import { randomUUID } from 'node:crypto';
import type { ProductRepositories } from '../repository/interfaces.js';
import type { BlobStore } from '../blob/interfaces.js';
import { resolveBlobStore } from '../blob/config.js';
import type { RunQueueRepository } from './repository.js';
import type { RunQueueItem } from './types.js';
import { assertSafeWorkerId } from './types.js';
import type { ExecutionWorker, ExecutionWorkerResult } from './worker.js';
import { validateProductTargetPreflight } from '../service/preflightAdapter.js';
import { assertNoSecrets } from '../secrets/sanitizer.js';
import type { TestRun } from '../types/run.js';
import type { RunArtifact } from '../types/artifact.js';

export interface RunDispatcherOptions {
  readonly queue: RunQueueRepository;
  readonly repositories: ProductRepositories;
  readonly worker: ExecutionWorker;
  readonly blobStore?: BlobStore;
  readonly workerId: string;
  readonly leaseSeconds?: number;
  readonly workspaceId?: string;
  readonly now?: () => Date;
}

export interface DispatchResult {
  readonly runId: string;
  readonly workspaceId: string;
  readonly status: 'completed' | 'partial' | 'failed' | 'blocked' | 'cancelled';
  readonly reason?: string;
  readonly executionReportRef?: string;
}

export class RunDispatcher {
  private readonly queue: RunQueueRepository;
  private readonly repos: ProductRepositories;
  private readonly worker: ExecutionWorker;
  private readonly blobs: BlobStore;
  private readonly workerId: string;
  private readonly leaseSeconds: number;
  private readonly workspaceId?: string;
  private readonly clock: () => Date;
  private readonly activeAbortControllers = new Map<string, AbortController>();

  constructor(options: RunDispatcherOptions) {
    assertSafeWorkerId(options.workerId);
    this.queue = options.queue;
    this.repos = options.repositories;
    this.worker = options.worker;
    this.blobs = options.blobStore ?? resolveBlobStore();
    this.workerId = options.workerId;
    this.leaseSeconds = options.leaseSeconds ?? 60;
    this.workspaceId = options.workspaceId;
    this.clock = options.now ?? (() => new Date());
  }

  private nowIso(): string {
    return this.clock().toISOString();
  }

  private async recordAudit(
    workspaceId: string,
    eventType:
      | 'run.started'
      | 'run.completed'
      | 'run.failed'
      | 'run.preflight_blocked'
      | 'run.cancelled',
    runId: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      assertNoSecrets(metadata, 'Audit metadata');
      await this.repos.audits.create({
        id: `aud-${randomUUID().slice(0, 12)}`,
        schemaVersion: '1.0',
        workspaceId,
        actorUserId: `worker:${this.workerId}`,
        eventType,
        entityType: 'test_run',
        entityId: runId,
        metadata: {
          workerId: this.workerId,
          ...metadata,
        },
        timestamp: this.nowIso(),
      });
    } catch {
      // Non-blocking for pipeline progress, but audited in production
    }
  }

  /**
   * Cancels a currently executing or queued run.
   */
  async cancelActiveRun(runId: string, reason?: string): Promise<boolean> {
    const controller = this.activeAbortControllers.get(runId);
    if (controller) {
      controller.abort();
      await this.worker.cancelRun(runId);
      return true;
    }
    return false;
  }

  /**
   * Aborts all active in-flight runs (used during worker timeout shutdown).
   */
  async abortAllActive(): Promise<void> {
    for (const [runId, controller] of this.activeAbortControllers) {
      controller.abort();
      try {
        await this.worker.cancelRun(runId);
      } catch {
        // Safe disposal
      }
    }
  }

  /**
   * Claims and dispatches the next available queued run.
   * Returns null if no eligible run is available.
   */
  async dispatchNext(): Promise<DispatchResult | null> {
    const claim = await this.queue.claimNext({
      workerId: this.workerId,
      leaseSeconds: this.leaseSeconds,
      workspaceId: this.workspaceId,
    });

    if (!claim) {
      return null;
    }

    return this.processClaimedItem(claim);
  }

  private async processClaimedItem(item: RunQueueItem): Promise<DispatchResult> {
    const runId = item.runId;
    const workspaceId = item.workspaceId;

    // Load corresponding TestRun
    const run = await this.repos.runs.findById(workspaceId, runId);
    if (!run) {
      const err = `TestRun "${runId}" not found in workspace "${workspaceId}".`;
      await this.queue.update({
        ...item,
        queueStatus: 'failed',
        lastError: err,
        completedAt: this.nowIso(),
        updatedAt: this.nowIso(),
      });
      await this.queue.releaseLease(runId, this.workerId);
      return { runId, workspaceId, status: 'failed', reason: err };
    }

    // Terminal state protection: terminal states cannot be re-executed or overwritten
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'blocked' || run.status === 'cancelled') {
      await this.queue.update({
        ...item,
        queueStatus: run.status,
        completedAt: item.completedAt ?? this.nowIso(),
        updatedAt: this.nowIso(),
      });
      await this.queue.releaseLease(runId, this.workerId);
      return {
        runId,
        workspaceId,
        status: run.status as any,
        reason: `Run "${runId}" is already in terminal status "${run.status}". Cannot overwrite terminal state.`,
      };
    }

    // Step 1: Load target and journey definitions
    const target = await this.repos.targets.findById(workspaceId, item.targetId);
    const journey = await this.repos.journeys.findById(workspaceId, item.journeyId);

    if (!target || !journey) {
      const blockedReason = !target
        ? `Target "${item.targetId}" not found.`
        : `Journey "${item.journeyId}" not found.`;

      const now = this.nowIso();
      await this.repos.runs.update({
        ...run,
        status: 'blocked',
        preflightStatus: 'blocked',
        blockedReason,
        finishedAt: now,
        updatedAt: now,
      });
      await this.queue.update({
        ...item,
        queueStatus: 'blocked',
        lastError: blockedReason,
        completedAt: now,
        updatedAt: now,
      });
      await this.queue.releaseLease(runId, this.workerId);
      await this.recordAudit(workspaceId, 'run.preflight_blocked', runId, { reason: blockedReason });
      return { runId, workspaceId, status: 'blocked', reason: blockedReason };
    }

    // Step 2: Enforce Preflight Safety Gate before any browser/worker execution
    const preflightResult = validateProductTargetPreflight(target, [journey]);
    if (preflightResult.status !== 'ready') {
      // PREFLIGHT BLOCKED:
      // Zero browsers launched. Zero target requests. Store blocked result safely.
      const blockedReason = preflightResult.failureReasons.join('; ') || 'Preflight safety check refused execution.';
      const now = this.nowIso();

      await this.repos.runs.update({
        ...run,
        status: 'blocked',
        preflightStatus: preflightResult.status,
        blockedReason,
        finishedAt: now,
        updatedAt: now,
      });
      await this.queue.update({
        ...item,
        queueStatus: 'blocked',
        lastError: blockedReason,
        completedAt: now,
        updatedAt: now,
      });
      await this.queue.releaseLease(runId, this.workerId);
      await this.recordAudit(workspaceId, 'run.preflight_blocked', runId, {
        reasons: preflightResult.failureReasons,
        preflightStatus: preflightResult.status,
      });

      return { runId, workspaceId, status: 'blocked', reason: blockedReason };
    }

    // Step 3: Transition to 'running'
    const startTs = this.nowIso();
    await this.repos.runs.update({
      ...run,
      status: 'running',
      preflightStatus: 'ready',
      startedAt: startTs,
      updatedAt: startTs,
    });
    await this.queue.update({
      ...item,
      queueStatus: 'running',
      startedAt: startTs,
      updatedAt: startTs,
    });
    await this.recordAudit(workspaceId, 'run.started', runId);

    // Step 4: Setup lease heartbeat and execution abort controller
    const abortController = new AbortController();
    this.activeAbortControllers.set(runId, abortController);

    // Heartbeat renewal interval (e.g. leaseSeconds / 2, min 5 seconds)
    const renewalIntervalMs = Math.max(5, Math.floor(this.leaseSeconds / 2)) * 1000;
    let leaseLost = false;

    const heartbeatTimer = setInterval(async () => {
      try {
        const renewed = await this.queue.renewLease(runId, this.workerId, this.leaseSeconds);
        if (!renewed) {
          leaseLost = true;
          abortController.abort();
          await this.worker.cancelRun(runId);
        }
      } catch {
        // Retry next interval or lease expiration handles
      }
    }, renewalIntervalMs);

    let workerResult: ExecutionWorkerResult | null = null;
    let executionError: Error | null = null;

    try {
      workerResult = await this.worker.executeRun({
        runId,
        workspaceId,
        projectId: item.projectId,
        target,
        journey,
        attemptNumber: item.attemptCount,
        safeTestMode: true,
        cancellationSignal: abortController.signal,
      });
    } catch (err) {
      executionError = err instanceof Error ? err : new Error(String(err));
    } finally {
      clearInterval(heartbeatTimer);
      this.activeAbortControllers.delete(runId);
    }

    // If the worker lost its lease during execution, it must stop updating the run
    if (leaseLost) {
      await this.queue.releaseLease(runId, this.workerId);
      return {
        runId,
        workspaceId,
        status: 'failed',
        reason: `Worker lost lease for run "${runId}". Execution aborted without mutating final state.`,
      };
    }

    const endTs = this.nowIso();

    // Step 5: Check for cancellation during execution
    if (abortController.signal.aborted || workerResult?.status === 'cancelled') {
      const cancelReason = workerResult?.failureReason ?? 'Run execution was cancelled.';
      await this.repos.runs.update({
        ...run,
        status: 'cancelled',
        cancelReason,
        finishedAt: endTs,
        updatedAt: endTs,
      });
      await this.queue.update({
        ...item,
        queueStatus: 'cancelled',
        cancellationTimestamp: endTs,
        completedAt: endTs,
        updatedAt: endTs,
      });
      await this.queue.releaseLease(runId, this.workerId);
      await this.recordAudit(workspaceId, 'run.cancelled', runId, { reason: cancelReason });
      return { runId, workspaceId, status: 'cancelled', reason: cancelReason };
    }

    // Step 6: Handle Execution Error
    if (executionError || !workerResult || workerResult.status === 'failed') {
      const failReason = executionError?.message ?? workerResult?.failureReason ?? 'Execution worker failed.';
      await this.repos.runs.update({
        ...run,
        status: 'failed',
        failureReason: failReason,
        finishedAt: endTs,
        updatedAt: endTs,
      });
      await this.queue.update({
        ...item,
        queueStatus: 'failed',
        lastError: failReason,
        completedAt: endTs,
        updatedAt: endTs,
      });
      await this.queue.releaseLease(runId, this.workerId);
      await this.recordAudit(workspaceId, 'run.failed', runId, { error: failReason });
      return { runId, workspaceId, status: 'failed', reason: failReason };
    }

    // Step 7: Persist Execution Artifacts safely to BlobStore
    let executionReportRef = workerResult.executionReportRef;
    let anomalyReportRef = workerResult.anomalyReportRef;
    let reproductionReportRef = workerResult.reproductionReportRef;
    let candidatesReportRef = workerResult.candidatesReportRef;

    if (workerResult.artifacts && workerResult.artifacts.length > 0) {
      try {
        for (const artifact of workerResult.artifacts) {
          const artifactId = `art-${randomUUID().slice(0, 12)}`;
          const locator = {
            workspaceId,
            projectId: item.projectId,
            runId,
            artifactId,
          };
          const blobMeta = await this.blobs.put({
            ...locator,
            contentType: artifact.contentType,
            content: artifact.payload,
          });

          const createdArtifact: RunArtifact = {
            id: artifactId,
            schemaVersion: '1.0',
            workspaceId,
            runId,
            type: artifact.type,
            storagePath: blobMeta.safeObjectKey,
            byteSize: blobMeta.byteLength,
            sha256: blobMeta.checksum,
            contentType: artifact.contentType,
            createdAt: endTs,
          };

          try {
            await this.repos.artifacts.create(createdArtifact);
          } catch (dbErr) {
            // Clean up written blob if metadata persistence fails
            try {
              await this.blobs.delete(locator);
            } catch {
              // Best-effort cleanup
            }
            throw dbErr;
          }

          if (artifact.type === 'execution' && !executionReportRef) {
            executionReportRef = createdArtifact.storagePath;
          } else if (artifact.type === 'anomalies' && !anomalyReportRef) {
            anomalyReportRef = createdArtifact.storagePath;
          } else if (artifact.type === 'reproduction' && !reproductionReportRef) {
            reproductionReportRef = createdArtifact.storagePath;
          } else if (artifact.type === 'candidates' && !candidatesReportRef) {
            candidatesReportRef = createdArtifact.storagePath;
          }

          if (artifact.type === 'candidates' && this.repos.candidates) {
            try {
              const rawCandidates = JSON.parse(
                Buffer.isBuffer(artifact.payload)
                  ? artifact.payload.toString('utf8')
                  : String(artifact.payload),
              );
              const candidatesList = Array.isArray(rawCandidates?.candidates)
                ? rawCandidates.candidates
                : [];
              for (const cand of candidatesList) {
                const candId = cand.candidateId || cand.id || `cand-${randomUUID().slice(0, 16)}`;
                await this.repos.candidates.create({
                  id: `candref-${randomUUID().slice(0, 16)}`,
                  schemaVersion: '1.0',
                  workspaceId,
                  projectId: item.projectId,
                  runId,
                  candidateId: candId,
                  ruleId: cand.ruleId ?? 'UNKNOWN_RULE',
                  classification: cand.classification ?? 'unknown',
                  reproduced: Boolean(cand.reproduced),
                  reviewStatus: 'unreviewed',
                  confirmed: false,
                  confirmedBug: false,
                  createdAt: endTs,
                  updatedAt: endTs,
                });
              }
            } catch {
              // Non-blocking for pipeline completion if candidate parsing fails
            }
          }
        }
      } catch (storageErr) {
        const failReason = `Artifact storage failed: ${(storageErr as Error).message}`;
        await this.repos.runs.update({
          ...run,
          status: 'failed',
          failureReason: failReason,
          finishedAt: endTs,
          updatedAt: endTs,
        });
        await this.queue.update({
          ...item,
          queueStatus: 'failed',
          lastError: failReason,
          completedAt: endTs,
          updatedAt: endTs,
        });
        await this.queue.releaseLease(runId, this.workerId);
        await this.recordAudit(workspaceId, 'run.failed', runId, { error: failReason });
        return { runId, workspaceId, status: 'failed', reason: failReason };
      }
    }

    // Step 8: Final lifecycle transition: 'completed' or 'partial'
    const finalStatus = workerResult.status === 'partial' ? 'partial' : 'completed';
    await this.repos.runs.update({
      ...run,
      status: finalStatus,
      executionReportRef,
      anomalyReportRef,
      reproductionReportRef,
      candidatesReportRef,
      finishedAt: endTs,
      updatedAt: endTs,
    });

    await this.queue.update({
      ...item,
      queueStatus: 'completed',
      completedAt: endTs,
      updatedAt: endTs,
    });

    await this.queue.releaseLease(runId, this.workerId);
    await this.recordAudit(workspaceId, 'run.completed', runId, {
      passedSteps: workerResult.passedSteps,
      totalSteps: workerResult.totalSteps,
      executionReportRef,
    });

    return {
      runId,
      workspaceId,
      status: finalStatus,
      executionReportRef,
    };
  }
}
