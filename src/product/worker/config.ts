/**
 * CrashLab Worker Service Configuration & Validation — Build 12D.2B.
 *
 * Provides strongly-typed, bounded, server-only configuration for the independent
 * CrashLab worker service.
 *
 * Invariants:
 * - Worker is disabled by default (`PRODUCT_WORKER_ENABLED=false`).
 * - Worker ID must be alphanumeric/dash/dot to prevent log or SQL injection.
 * - Poll interval, lease duration, concurrency, and shutdown timeouts are strictly bounded.
 * - Fails closed if production storage or bucket secrets are missing.
 * - Zero secrets (DATABASE_URL, service keys, tokens) are ever logged or exposed.
 */

import { assertSafeWorkerId } from '../queue/types.js';

export interface WorkerServiceConfig {
  readonly enabled: boolean;
  readonly workerId: string;
  readonly pollMs: number;
  readonly leaseSeconds: number;
  readonly maxConcurrency: number;
  readonly shutdownTimeoutMs: number;
  readonly healthPort: number;
  readonly authMode: 'development' | 'production';
  readonly storage: 'in-memory' | 'postgres';
  readonly blobStore: 'local' | 'supabase' | 's3';
  readonly allowLocalInProduction: boolean;
  readonly databaseUrl?: string;
  readonly supabaseUrl?: string;
  readonly supabaseStorageBucket?: string;
  readonly supabaseServiceRoleKey?: string;
}

export const MIN_POLL_MS = 100;
export const MAX_POLL_MS = 60_000;
export const DEFAULT_POLL_MS = 1_000;

export const MIN_LEASE_SECONDS = 5;
export const MAX_LEASE_SECONDS = 600;
export const DEFAULT_LEASE_SECONDS = 60;

export const MIN_CONCURRENCY = 1;
export const MAX_CONCURRENCY = 10;
export const DEFAULT_CONCURRENCY = 1;

export const MIN_SHUTDOWN_TIMEOUT_MS = 1_000;
export const MAX_SHUTDOWN_TIMEOUT_MS = 120_000;
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

export const DEFAULT_HEALTH_PORT = 3230;

/**
 * Loads worker service configuration from environment with strict bounds.
 */
export function loadWorkerServiceConfigFromEnv(env: NodeJS.ProcessEnv = process.env): WorkerServiceConfig {
  const enabled = env.PRODUCT_WORKER_ENABLED?.trim().toLowerCase() === 'true';

  const rawId = env.PRODUCT_WORKER_ID !== undefined
    ? env.PRODUCT_WORKER_ID
    : `worker-${process.pid}`;
  assertSafeWorkerId(rawId);

  const rawPoll = parseInt(env.PRODUCT_WORKER_POLL_MS ?? String(DEFAULT_POLL_MS), 10);
  const pollMs = Number.isFinite(rawPoll)
    ? Math.max(MIN_POLL_MS, Math.min(rawPoll, MAX_POLL_MS))
    : DEFAULT_POLL_MS;

  const rawLease = parseInt(env.PRODUCT_WORKER_LEASE_SECONDS ?? String(DEFAULT_LEASE_SECONDS), 10);
  const leaseSeconds = Number.isFinite(rawLease)
    ? Math.max(MIN_LEASE_SECONDS, Math.min(rawLease, MAX_LEASE_SECONDS))
    : DEFAULT_LEASE_SECONDS;

  const rawConc = parseInt(env.PRODUCT_WORKER_MAX_CONCURRENCY ?? String(DEFAULT_CONCURRENCY), 10);
  const maxConcurrency = Number.isFinite(rawConc)
    ? Math.max(MIN_CONCURRENCY, Math.min(rawConc, MAX_CONCURRENCY))
    : DEFAULT_CONCURRENCY;

  const rawShutdown = parseInt(
    env.PRODUCT_WORKER_SHUTDOWN_TIMEOUT_MS ?? String(DEFAULT_SHUTDOWN_TIMEOUT_MS),
    10,
  );
  const shutdownTimeoutMs = Number.isFinite(rawShutdown)
    ? Math.max(MIN_SHUTDOWN_TIMEOUT_MS, Math.min(rawShutdown, MAX_SHUTDOWN_TIMEOUT_MS))
    : DEFAULT_SHUTDOWN_TIMEOUT_MS;

  const rawPort = parseInt(env.PRODUCT_WORKER_HEALTH_PORT ?? String(DEFAULT_HEALTH_PORT), 10);
  const healthPort = Number.isFinite(rawPort) && rawPort >= 1 && rawPort <= 65535
    ? rawPort
    : DEFAULT_HEALTH_PORT;

  const authModeRaw = env.PRODUCT_AUTH_MODE?.trim().toLowerCase();
  const authMode: 'development' | 'production' = authModeRaw === 'production' ? 'production' : 'development';

  const storageRaw = env.PRODUCT_STORAGE?.trim().toLowerCase();
  const storage: 'in-memory' | 'postgres' = storageRaw === 'postgres' ? 'postgres' : 'in-memory';

  const blobRaw = env.PRODUCT_BLOB_STORE?.trim().toLowerCase();
  const blobStore: 'local' | 'supabase' | 's3' =
    blobRaw === 'supabase' ? 'supabase' : blobRaw === 's3' ? 's3' : 'local';

  const allowLocalInProduction =
    env.PRODUCT_BLOB_ALLOW_LOCAL_IN_PRODUCTION?.trim().toLowerCase() === 'true';

  return {
    enabled,
    workerId: rawId,
    pollMs,
    leaseSeconds,
    maxConcurrency,
    shutdownTimeoutMs,
    healthPort,
    authMode,
    storage,
    blobStore,
    allowLocalInProduction,
    databaseUrl: env.DATABASE_URL?.trim() || undefined,
    supabaseUrl: env.SUPABASE_URL?.trim() || undefined,
    supabaseStorageBucket: env.SUPABASE_STORAGE_BUCKET?.trim() || undefined,
    supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY?.trim() || undefined,
  };
}

export interface WorkerConfigValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

/**
 * Validates worker configuration and enforces fail-closed production readiness.
 * Only variable names and safe constraints are returned; secret values are never printed.
 */
export function validateWorkerServiceConfig(
  config: WorkerServiceConfig,
): WorkerConfigValidationResult {
  const errors: string[] = [];

  try {
    assertSafeWorkerId(config.workerId);
  } catch (err) {
    errors.push(`Invalid worker ID: ${(err as Error).message}`);
  }

  if (config.pollMs < MIN_POLL_MS || config.pollMs > MAX_POLL_MS) {
    errors.push(`Poll interval must be between ${MIN_POLL_MS}ms and ${MAX_POLL_MS}ms.`);
  }

  if (config.leaseSeconds < MIN_LEASE_SECONDS || config.leaseSeconds > MAX_LEASE_SECONDS) {
    errors.push(`Lease duration must be between ${MIN_LEASE_SECONDS}s and ${MAX_LEASE_SECONDS}s.`);
  }

  if (config.maxConcurrency < MIN_CONCURRENCY || config.maxConcurrency > MAX_CONCURRENCY) {
    errors.push(`Max concurrency must be between ${MIN_CONCURRENCY} and ${MAX_CONCURRENCY}.`);
  }

  if (config.authMode === 'production' || config.storage === 'postgres') {
    if (!config.databaseUrl) {
      errors.push('Missing required database configuration: DATABASE_URL.');
    }
  }

  if (config.blobStore === 'supabase') {
    if (!config.supabaseUrl) {
      errors.push('Missing required Supabase Storage configuration: SUPABASE_URL.');
    }
    if (!config.supabaseStorageBucket) {
      errors.push('Missing required Supabase Storage configuration: SUPABASE_STORAGE_BUCKET.');
    }
    if (!config.supabaseServiceRoleKey) {
      errors.push('Missing required Supabase Storage configuration: SUPABASE_SERVICE_ROLE_KEY.');
    }
  }

  if (config.authMode === 'production' && config.blobStore === 'local' && !config.allowLocalInProduction) {
    errors.push(
      'Local blob storage is refused in production mode without explicit PRODUCT_BLOB_ALLOW_LOCAL_IN_PRODUCTION=true.',
    );
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
