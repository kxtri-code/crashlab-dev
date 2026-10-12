/**
 * Product Repository Storage Resolver & Dependency Injection — Build 12B.1.
 *
 * Provides explicit, non-fallback storage provider selection:
 * - in-memory: Default for fast, isolated local unit tests
 * - postgres: Production & staging relational persistence adapter
 *
 * Enforces:
 * - Explicit selection via PRODUCT_STORAGE ('in-memory' | 'postgres')
 * - Clear failure if PRODUCT_STORAGE=postgres and DATABASE_URL is missing
 * - Zero silent fallback between providers
 * - Direct dependency injection of custom pool / repositories for contract testing
 */

import type { ProductRepositories } from './repository/interfaces.js';
import { createInMemoryProductRepositories } from './repository/inMemory.js';
import { createPostgresProductRepositories } from './repository/postgres.js';
import { createPgPool, type PostgresPool } from './repository/postgresPool.js';

export type ProductStorageType = 'in-memory' | 'postgres';

export interface StorageConfig {
  readonly storage: ProductStorageType;
  readonly databaseUrl?: string;
}

export function loadStorageConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): StorageConfig {
  const raw = env.PRODUCT_STORAGE?.trim().toLowerCase();
  const storage: ProductStorageType = raw === 'postgres' ? 'postgres' : 'in-memory';
  return {
    storage,
    databaseUrl: env.DATABASE_URL?.trim(),
  };
}

export interface StorageResolutionOptions {
  readonly storage?: ProductStorageType;
  readonly databaseUrl?: string;
  readonly pool?: PostgresPool;
  readonly repositories?: ProductRepositories;
}

export interface ResolvedStorage {
  readonly repositories: ProductRepositories;
  readonly pool?: PostgresPool;
  readonly storage: ProductStorageType;
}

/**
 * Resolves product repositories based on options and environment configuration.
 * Fails clearly if postgres storage is requested without a database URL or pool.
 */
export function resolveProductRepositories(
  options: StorageResolutionOptions = {},
  env: Record<string, string | undefined> = process.env,
): ResolvedStorage {
  // 1. Explicitly provided repositories take precedence (for custom unit tests)
  if (options.repositories) {
    return {
      repositories: options.repositories,
      pool: options.pool,
      storage: options.storage ?? 'in-memory',
    };
  }

  const envConfig = loadStorageConfigFromEnv(env);
  const targetStorage = options.storage ?? envConfig.storage;

  // 2. PostgreSQL Storage Selection
  if (targetStorage === 'postgres') {
    if (options.pool) {
      return {
        repositories: createPostgresProductRepositories(options.pool),
        pool: options.pool,
        storage: 'postgres',
      };
    }

    const databaseUrl = options.databaseUrl ?? envConfig.databaseUrl;
    if (!databaseUrl) {
      throw new Error('DATABASE_URL is required when PRODUCT_STORAGE=postgres.');
    }

    const pool = createPgPool({ databaseUrl });
    return {
      repositories: createPostgresProductRepositories(pool),
      pool,
      storage: 'postgres',
    };
  }

  // 3. In-Memory Storage (Default)
  return {
    repositories: createInMemoryProductRepositories(),
    storage: 'in-memory',
  };
}
