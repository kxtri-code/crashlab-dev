/**
 * Local Worker Loop — Build 12B.2B.
 *
 * Implements bounded, graceful background worker polling for local development and test automation.
 *
 * Rules:
 * - Disabled by default (`PRODUCT_WORKER_ENABLED=false`).
 * - Poll interval and concurrency are strictly bounded.
 * - Graceful shutdown drains in-flight jobs and releases timers.
 * - Supports `--once` mode for deterministic, single-execution runs.
 */

import type { WorkerConfig } from './types.js';
import type { RunDispatcher, DispatchResult } from './dispatcher.js';

export interface WorkerLoopOptions {
  readonly dispatcher: RunDispatcher;
  readonly config: WorkerConfig;
  readonly onDispatched?: (result: DispatchResult | null) => void;
  readonly onError?: (error: Error) => void;
}

export class WorkerLoop {
  private readonly dispatcher: RunDispatcher;
  private readonly config: WorkerConfig;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private activeCount = 0;
  private stopPromiseResolve: (() => void) | null = null;

  constructor(private readonly options: WorkerLoopOptions) {
    this.dispatcher = options.dispatcher;
    this.config = options.config;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get activeJobsCount(): number {
    return this.activeCount;
  }

  /**
   * Executes at most one run and returns the result.
   */
  async runOnce(): Promise<DispatchResult | null> {
    try {
      this.activeCount++;
      const result = await this.dispatcher.dispatchNext();
      if (this.options.onDispatched) {
        this.options.onDispatched(result);
      }
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (this.options.onError) {
        this.options.onError(error);
      }
      throw error;
    } finally {
      this.activeCount--;
    }
  }

  /**
   * Starts the worker polling loop if enabled.
   */
  async start(): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    if (this.running) {
      return;
    }

    this.running = true;
    this.scheduleNextPoll(0);
  }

  private scheduleNextPoll(delayMs: number): void {
    if (!this.running) {
      return;
    }

    this.timer = setTimeout(async () => {
      this.timer = null;
      if (!this.running) return;

      try {
        if (this.activeCount < this.config.maxConcurrency) {
          await this.runOnce();
        }
      } catch {
        // Error logged via onError callback; continue polling
      } finally {
        if (this.running) {
          this.scheduleNextPoll(this.config.pollMs);
        } else if (this.activeCount === 0 && this.stopPromiseResolve) {
          this.stopPromiseResolve();
          this.stopPromiseResolve = null;
        }
      }
    }, delayMs);
  }

  /**
   * Gracefully stops the worker loop, waiting for any active jobs to complete.
   * If timeoutMs is reached before active jobs finish, active jobs are safely aborted.
   */
  async stop(timeoutMs?: number): Promise<void> {
    this.running = false;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.activeCount === 0) {
      return;
    }

    let timeoutTimer: NodeJS.Timeout | null = null;
    await new Promise<void>((resolve) => {
      this.stopPromiseResolve = () => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        resolve();
      };

      if (timeoutMs && timeoutMs > 0) {
        timeoutTimer = setTimeout(async () => {
          this.stopPromiseResolve = null;
          try {
            await this.dispatcher.abortAllActive();
          } catch {
            // Safe abort
          }
          resolve();
        }, timeoutMs);
      }
    });
  }
}
