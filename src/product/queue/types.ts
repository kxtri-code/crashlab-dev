/**
 * Product Run Queue Domain Types & Contracts — Build 12B.2B.
 *
 * Defines the PostgreSQL-backed asynchronous worker queue data model,
 * worker lease states, claiming constraints, and configuration.
 */

export type RunQueueStatus =
  | 'queued'
  | 'preflight'
  | 'running'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'cancelled';

export const RUN_QUEUE_STATUSES: readonly RunQueueStatus[] = [
  'queued',
  'preflight',
  'running',
  'cancelling',
  'completed',
  'failed',
  'blocked',
  'cancelled',
] as const;

export interface RunQueueItem {
  readonly runId: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly targetId: string;
  readonly journeyId: string;
  readonly queueStatus: RunQueueStatus;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly availableAt: string;
  readonly leaseOwner: string | null;
  readonly leaseExpiry: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly lastError: string | null;
  readonly cancellationTimestamp: string | null;
  readonly requestId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EnqueueRunInput {
  readonly runId: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly targetId: string;
  readonly journeyId: string;
  readonly maxAttempts?: number;
  readonly requestId?: string;
  readonly availableAt?: string;
}

export interface ClaimOptions {
  readonly workerId: string;
  readonly leaseSeconds?: number;
  readonly workspaceId?: string;
}

export interface WorkerConfig {
  readonly enabled: boolean;
  readonly workerId: string;
  readonly pollMs: number;
  readonly leaseSeconds: number;
  readonly maxConcurrency: number;
  readonly workerSecret?: string;
}

const SAFE_WORKER_ID_REGEX = /^[a-zA-Z0-9_\-\.]+$/;

/**
 * Validates that a worker ID is safe, non-empty, and free of injection, secrets, or control characters.
 */
export function assertSafeWorkerId(workerId: string): void {
  if (!workerId || typeof workerId !== 'string') {
    throw new Error('Worker ID must be a non-empty string.');
  }
  const trimmed = workerId.trim();
  if (trimmed.length === 0 || trimmed.length > 128) {
    throw new Error(`Worker ID "${workerId}" is invalid: must be between 1 and 128 characters.`);
  }
  if (!SAFE_WORKER_ID_REGEX.test(trimmed)) {
    throw new Error(
      `Worker ID "${workerId}" contains prohibited characters. Only alphanumeric, dashes, dots, and underscores are allowed.`,
    );
  }
  if (/[\x00-\x1f\x7f]/.test(workerId)) {
    throw new Error(`Worker ID "${workerId}" contains prohibited control characters.`);
  }
}

/**
 * Loads worker configuration from process environment with safe defaults.
 */
export function loadWorkerConfigFromEnv(): WorkerConfig {
  const enabled = process.env.PRODUCT_WORKER_ENABLED?.toLowerCase() === 'true';
  const rawId = process.env.PRODUCT_WORKER_ID?.trim() || `worker-${process.pid}`;
  assertSafeWorkerId(rawId);

  const pollMsRaw = parseInt(process.env.PRODUCT_WORKER_POLL_MS ?? '1000', 10);
  const pollMs = Number.isFinite(pollMsRaw) && pollMsRaw >= 100 ? pollMsRaw : 1000;

  const leaseSecRaw = parseInt(process.env.PRODUCT_WORKER_LEASE_SECONDS ?? '60', 10);
  const leaseSeconds = Number.isFinite(leaseSecRaw) && leaseSecRaw >= 5 ? leaseSecRaw : 60;

  const maxConcRaw = parseInt(process.env.PRODUCT_WORKER_MAX_CONCURRENCY ?? '1', 10);
  const maxConcurrency = Number.isFinite(maxConcRaw) && maxConcRaw >= 1 ? Math.min(maxConcRaw, 10) : 1;

  const workerSecret = process.env.PRODUCT_WORKER_SECRET?.trim() || undefined;

  return {
    enabled,
    workerId: rawId,
    pollMs,
    leaseSeconds,
    maxConcurrency,
    workerSecret,
  };
}
