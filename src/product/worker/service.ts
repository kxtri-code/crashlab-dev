/**
 * CrashLab Worker Service — Build 12D.2B.
 *
 * Coordinates independent worker execution, queue polling, lease renewals,
 * preflight enforcement, artifact persistence, and internal health endpoints.
 *
 * Invariants:
 * - Completely separate from Product API web server (API never starts worker).
 * - Fails closed on invalid or missing configurations.
 * - Shuts down gracefully on SIGINT/SIGTERM with bounded timeouts.
 * - Zero credentials leaked to console or logs.
 */

import type { ProductRepositories } from '../repository/interfaces.js';
import type { BlobStore } from '../blob/interfaces.js';
import { resolveProductRepositories } from '../storage.js';
import { resolveBlobStore } from '../blob/config.js';
import { RunDispatcher, type DispatchResult } from '../queue/dispatcher.js';
import { WorkerLoop } from '../queue/workerLoop.js';
import type { ExecutionWorker } from '../queue/worker.js';
import { PlaywrightExecutionWorker } from './playwrightWorker.js';
import { WorkerHealthServer, type WorkerHealthProvider } from './health.js';
import type { WorkerServiceConfig } from './config.js';

export interface WorkerServiceOptions {
  readonly config: WorkerServiceConfig;
  readonly repositories?: ProductRepositories;
  readonly blobStore?: BlobStore;
  readonly worker?: ExecutionWorker;
  readonly pool?: { end(): Promise<void> };
}

export class WorkerService implements WorkerHealthProvider {
  readonly config: WorkerServiceConfig;
  readonly repositories: ProductRepositories;
  readonly blobStore: BlobStore;
  readonly executionWorker: ExecutionWorker;
  private readonly dispatcher: RunDispatcher;
  private readonly workerLoop: WorkerLoop;
  private readonly healthServer: WorkerHealthServer;
  private readonly pool?: { end(): Promise<void> };
  private startTime = 0;
  private shuttingDown = false;

  constructor(options: WorkerServiceOptions) {
    this.config = options.config;

    if (options.repositories) {
      this.repositories = options.repositories;
      this.pool = options.pool;
    } else {
      const resolved = resolveProductRepositories();
      this.repositories = resolved.repositories;
      this.pool = resolved.pool;
    }

    this.blobStore = options.blobStore ?? resolveBlobStore();
    this.executionWorker = options.worker ?? new PlaywrightExecutionWorker();

    if (!this.repositories.queue) {
      throw new Error('WorkerService requires a configured RunQueueRepository.');
    }
    const queue = this.repositories.queue;

    this.dispatcher = new RunDispatcher({
      queue,
      repositories: this.repositories,
      worker: this.executionWorker,
      blobStore: this.blobStore,
      workerId: this.config.workerId,
      leaseSeconds: this.config.leaseSeconds,
    });

    this.workerLoop = new WorkerLoop({
      dispatcher: this.dispatcher,
      config: {
        enabled: this.config.enabled,
        workerId: this.config.workerId,
        pollMs: this.config.pollMs,
        leaseSeconds: this.config.leaseSeconds,
        maxConcurrency: this.config.maxConcurrency,
      },
      onDispatched: (res) => {
        if (res) {
          console.log(`[Worker ${this.config.workerId}] Processed run "${res.runId}" -> ${res.status}`);
        }
      },
      onError: (err) => {
        console.error(`[Worker ${this.config.workerId}] Error: ${err.message}`);
      },
    });

    this.healthServer = new WorkerHealthServer(this, this.config.healthPort);
  }

  get workerId(): string {
    return this.config.workerId;
  }

  get maxConcurrency(): number {
    return this.config.maxConcurrency;
  }

  getActiveJobsCount(): number {
    return this.workerLoop.activeJobsCount;
  }

  getUptimeSeconds(): number {
    return this.startTime > 0 ? (Date.now() - this.startTime) / 1000 : 0;
  }

  async checkQueueHealth(): Promise<boolean> {
    try {
      if (!this.repositories.queue) return false;
      // In-memory or database check: findByRunId with a non-existent ID
      await this.repositories.queue.findByRunId('health-check-ws', 'health-check-run');
      return true;
    } catch {
      return false;
    }
  }

  async checkStorageHealth(): Promise<boolean> {
    try {
      if (!this.blobStore) return false;
      await this.blobStore.exists({
        workspaceId: 'health_ws',
        projectId: 'health_prj',
        runId: 'health_run',
        artifactId: 'health_art',
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Starts the worker continuous loop and internal health server.
   */
  async start(): Promise<void> {
    this.startTime = Date.now();
    await this.healthServer.start();
    await this.workerLoop.start();
  }

  /**
   * Executes at most one queued run and exits cleanly.
   */
  async runOnce(): Promise<DispatchResult | null> {
    this.startTime = Date.now();
    try {
      return await this.workerLoop.runOnce();
    } finally {
      await this.close();
    }
  }

  /**
   * Gracefully shuts down the worker with bounded timeouts.
   */
  async stop(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    // 1. Close health server
    try {
      await this.healthServer.close();
    } catch {
      // Safe shutdown
    }

    // 2. Stop worker loop, draining active jobs up to shutdown timeout
    await this.workerLoop.stop(this.config.shutdownTimeoutMs);

    // 3. Close resources
    await this.close();
  }

  /**
   * Closes database pool, blob store, and execution worker resources.
   */
  async close(): Promise<void> {
    try {
      await this.healthServer.close();
    } catch {
      // Safe shutdown
    }

    try {
      await this.executionWorker.close();
    } catch {
      // Safe shutdown
    }

    try {
      await this.blobStore.close();
    } catch {
      // Safe shutdown
    }

    if (this.pool) {
      try {
        await this.pool.end();
      } catch {
        // Safe shutdown
      }
    }
  }
}
