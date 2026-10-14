/**
 * Production Deployment Readiness & Environment Validation — Build 12D.1: Hosting Readiness.
 *
 * Enforces production-safe configuration boundaries:
 * - Production environment variable validation (reports variable names only, never values).
 * - Refuses development fallbacks in production (in-memory storage, local disk blob store without private-beta flag).
 * - Validates CORS allowlist (rejects wildcard '*' in production).
 * - Enforces disabled-by-default worker policy.
 * - Health and readiness connectivity probes.
 */

import { validateProductionAuthConfig } from '../auth/identity.js';

export interface ProductionEnvironmentValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export interface DeploymentConfig {
  readonly authMode: 'development' | 'production';
  readonly storage: 'in-memory' | 'postgres';
  readonly blobStore: 'local' | 's3-compatible' | 'supabase';
  readonly blobAllowLocalInProduction: boolean;
  readonly workerEnabled: boolean;
  readonly workerId: string;
  readonly corsAllowedOrigins: readonly string[];
  readonly trustProxy: boolean;
  readonly maxRequestBodyBytes: number;
}

export const DEFAULT_MAX_REQUEST_BODY_BYTES = 1024 * 1024; // 1MB bounded limit

/**
 * Validates Supabase Storage configuration variables.
 * Reports missing variable names ONLY — NEVER outputs values.
 */
export function validateSupabaseStorageConfig(
  env: Record<string, string | undefined> = process.env,
): { valid: boolean; missingVariables: readonly string[] } {
  const missing: string[] = [];

  if (!env.SUPABASE_URL?.trim()) {
    missing.push('SUPABASE_URL');
  }
  if (!env.SUPABASE_STORAGE_BUCKET?.trim()) {
    missing.push('SUPABASE_STORAGE_BUCKET');
  }
  if (!env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    missing.push('SUPABASE_SERVICE_ROLE_KEY');
  }

  return {
    valid: missing.length === 0,
    missingVariables: Object.freeze(missing),
  };
}

/**
 * Validates environment variables for production beta deployment.
 * Reports missing or invalid variable names ONLY — NEVER outputs secret values.
 */
export function validateProductionEnvironment(
  env: Record<string, string | undefined> = process.env,
): ProductionEnvironmentValidationResult {
  const errors: string[] = [];
  const rawAuthMode = env.PRODUCT_AUTH_MODE?.trim().toLowerCase();
  const isProduction = rawAuthMode === 'production' || !rawAuthMode; // Default is production

  if (isProduction) {
    // 1. Production Authentication
    const authValidation = validateProductionAuthConfig(env);
    if (!authValidation.valid) {
      for (const missing of authValidation.missingVariables) {
        errors.push(`Missing required production authentication variable: ${missing}`);
      }
    }

    // 2. Storage Provider
    const storage = env.PRODUCT_STORAGE?.trim().toLowerCase();
    if (storage !== 'postgres') {
      errors.push(
        'PRODUCT_STORAGE must be "postgres" in production mode (in-memory storage is prohibited).',
      );
    } else if (!env.DATABASE_URL?.trim()) {
      errors.push('DATABASE_URL is required when PRODUCT_STORAGE=postgres.');
    }

    // 3. Blob Storage Provider
    const blobStore = env.PRODUCT_BLOB_STORE?.trim().toLowerCase() || 'local';
    const allowLocal =
      env.PRODUCT_BLOB_ALLOW_LOCAL_IN_PRODUCTION?.trim().toLowerCase() === 'true';

    if (blobStore === 'supabase') {
      const storageValidation = validateSupabaseStorageConfig(env);
      if (!storageValidation.valid) {
        for (const missing of storageValidation.missingVariables) {
          errors.push(`Missing required production storage variable: ${missing}`);
        }
      }
    } else if (blobStore === 'local') {
      if (!allowLocal) {
        errors.push(
          'Local filesystem blob storage is refused in production mode without explicit PRODUCT_BLOB_ALLOW_LOCAL_IN_PRODUCTION=true override.',
        );
      }
    } else if (blobStore === 's3' || blobStore === 's3-compatible') {
      if (!env.PRODUCT_BLOB_S3_BUCKET?.trim()) {
        errors.push('PRODUCT_BLOB_S3_BUCKET is required when PRODUCT_BLOB_STORE=s3.');
      }
    } else {
      errors.push(`Unsupported PRODUCT_BLOB_STORE "${blobStore}" in production. Supported: "supabase", "local" (with override), "s3".`);
    }

    // 4. CORS Allowed Origins
    const corsOrigins = env.PRODUCT_CORS_ALLOWED_ORIGINS?.trim();
    if (!corsOrigins || corsOrigins === '*') {
      errors.push(
        'PRODUCT_CORS_ALLOWED_ORIGINS must be set to an explicit allowlist in production (wildcard "*" is prohibited).',
      );
    }

    // 5. Worker Startup Policy
    const workerEnabledRaw = env.PRODUCT_WORKER_ENABLED?.trim().toLowerCase();
    if (workerEnabledRaw && workerEnabledRaw !== 'true' && workerEnabledRaw !== 'false') {
      errors.push('PRODUCT_WORKER_ENABLED must be "true" or "false".');
    }
  }

  return {
    valid: errors.length === 0,
    errors: Object.freeze(errors),
  };
}

/**
 * Parses and returns deployment configuration from environment variables.
 */
export function loadDeploymentConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): DeploymentConfig {
  const rawAuthMode = env.PRODUCT_AUTH_MODE?.trim().toLowerCase();
  const authMode = rawAuthMode === 'development' ? 'development' : 'production';

  const rawStorage = env.PRODUCT_STORAGE?.trim().toLowerCase();
  const storage = rawStorage === 'postgres' ? 'postgres' : 'in-memory';

  const rawBlob = env.PRODUCT_BLOB_STORE?.trim().toLowerCase();
  let blobStore: 'local' | 's3-compatible' | 'supabase' = 'local';
  if (rawBlob === 'supabase') {
    blobStore = 'supabase';
  } else if (rawBlob === 's3' || rawBlob === 's3-compatible') {
    blobStore = 's3-compatible';
  }

  const blobAllowLocalInProduction =
    env.PRODUCT_BLOB_ALLOW_LOCAL_IN_PRODUCTION?.trim().toLowerCase() === 'true';

  const workerEnabled = env.PRODUCT_WORKER_ENABLED?.trim().toLowerCase() === 'true';
  const workerId =
    env.PRODUCT_WORKER_ID?.trim() && /^[a-zA-Z0-9_\-\.]+$/.test(env.PRODUCT_WORKER_ID.trim())
      ? env.PRODUCT_WORKER_ID.trim()
      : `worker-${process.pid}`;

  const rawCors = env.PRODUCT_CORS_ALLOWED_ORIGINS?.trim();
  const corsAllowedOrigins = rawCors
    ? rawCors.split(',').map((o) => o.trim()).filter(Boolean)
    : authMode === 'development'
      ? ['*']
      : [];

  const trustProxy = env.PRODUCT_TRUST_PROXY?.trim().toLowerCase() === 'true';

  return {
    authMode,
    storage,
    blobStore,
    blobAllowLocalInProduction,
    workerEnabled,
    workerId,
    corsAllowedOrigins: Object.freeze(corsAllowedOrigins),
    trustProxy,
    maxRequestBodyBytes: DEFAULT_MAX_REQUEST_BODY_BYTES,
  };
}
