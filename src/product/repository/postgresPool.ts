/**
 * PostgreSQL Pool and Connection Abstraction — Build 12A: PostgreSQL Adapter.
 *
 * Provides a provider-neutral interface over connection pools with:
 * - 100% parameterized queries
 * - Safe error wrapping (never leaks credentials or full connection strings)
 * - Safe configuration parsing from environment variables
 * - Graceful connection lifecycle and shutdown
 */

import pg from 'pg';

export interface PostgresQueryResult<R = any> {
  readonly rows: R[];
  readonly rowCount: number;
}

export interface PostgresClient {
  query<R extends pg.QueryResultRow = any>(text: string, params?: readonly unknown[]): Promise<PostgresQueryResult<R>>;
  release(): void;
}

export interface PostgresPool {
  query<R extends pg.QueryResultRow = any>(text: string, params?: readonly unknown[]): Promise<PostgresQueryResult<R>>;
  connect(): Promise<PostgresClient>;
  end(): Promise<void>;
  /** Returns safe metadata about the connection target (host and database name only; no credentials). */
  getSafeTargetInfo(): { host: string; port: number; database: string; ssl: boolean };
}

export interface PostgresConfig {
  readonly databaseUrl?: string;
  readonly ssl?: boolean | 'require';
  readonly poolMax?: number;
  readonly connectTimeoutMs?: number;
}

/**
 * Sanitizes a PostgreSQL connection URL so passwords and user tokens are redacted.
 * Example: postgresql://user:secret@localhost:5432/db -> postgresql://user:***@localhost:5432/db
 */
export function sanitizeConnectionString(rawUrl?: string): string {
  if (!rawUrl) return '';
  try {
    const parsed = new URL(rawUrl);
    if (parsed.password) {
      parsed.password = '***';
    }
    return parsed.toString();
  } catch {
    // If not a standard URL, mask any password=... tokens
    return rawUrl.replace(/(password=)[^&;\s]+/gi, '$1***');
  }
}

/**
 * Extracts non-secret connection target information for logging and CLI display.
 */
export function extractSafeTargetInfo(rawUrl?: string): { host: string; port: number; database: string; ssl: boolean } {
  if (!rawUrl) {
    return { host: 'unknown', port: 5432, database: 'unknown', ssl: false };
  }
  try {
    const parsed = new URL(rawUrl);
    return {
      host: parsed.hostname || 'localhost',
      port: parsed.port ? parseInt(parsed.port, 10) : 5432,
      database: parsed.pathname ? parsed.pathname.replace(/^\//, '') : 'default',
      ssl: parsed.searchParams.get('sslmode') === 'require' || parsed.searchParams.get('ssl') === 'true',
    };
  } catch {
    return { host: 'unknown', port: 5432, database: 'unknown', ssl: false };
  }
}

/**
 * Loads Postgres configuration from process environment.
 */
export function loadPostgresConfigFromEnv(env: Record<string, string | undefined> = process.env): PostgresConfig {
  const databaseUrl = env.DATABASE_URL?.trim();
  const rawSsl = env.DATABASE_SSL?.trim().toLowerCase();
  const ssl = rawSsl === 'true' || rawSsl === 'require' ? true : rawSsl === 'false' ? false : undefined;
  const poolMax = env.DATABASE_POOL_MAX ? parseInt(env.DATABASE_POOL_MAX, 10) : undefined;
  const connectTimeoutMs = env.DATABASE_CONNECT_TIMEOUT_MS ? parseInt(env.DATABASE_CONNECT_TIMEOUT_MS, 10) : undefined;

  return {
    databaseUrl,
    ssl,
    poolMax: Number.isFinite(poolMax) ? poolMax : undefined,
    connectTimeoutMs: Number.isFinite(connectTimeoutMs) ? connectTimeoutMs : undefined,
  };
}

/**
 * Wraps pg.Pool into the provider-neutral PostgresPool interface with safe error messages.
 */
export class RealPgPool implements PostgresPool {
  private readonly inner: pg.Pool;
  private readonly safeInfo: { host: string; port: number; database: string; ssl: boolean };

  constructor(config: PostgresConfig) {
    if (!config.databaseUrl) {
      throw new Error('DATABASE_URL is required to initialize PostgreSQL connection pool.');
    }

    this.safeInfo = extractSafeTargetInfo(config.databaseUrl);
    if (config.ssl !== undefined) {
      this.safeInfo.ssl = Boolean(config.ssl);
    }

    const poolConfig: pg.PoolConfig = {
      connectionString: config.databaseUrl,
      max: config.poolMax ?? 10,
      connectionTimeoutMillis: config.connectTimeoutMs ?? 5000,
      ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
    };

    this.inner = new pg.Pool(poolConfig);
  }

  getSafeTargetInfo(): { host: string; port: number; database: string; ssl: boolean } {
    return { ...this.safeInfo };
  }

  async query<R extends pg.QueryResultRow = any>(text: string, params?: readonly unknown[]): Promise<PostgresQueryResult<R>> {
    try {
      const result = await this.inner.query<R>(text, params ? [...params] : undefined);
      return {
        rows: result.rows,
        rowCount: result.rowCount ?? result.rows.length,
      };
    } catch (err: unknown) {
      throw this.sanitizeError(err);
    }
  }

  async connect(): Promise<PostgresClient> {
    try {
      const client = await this.inner.connect();
      return {
        query: async <R extends pg.QueryResultRow = any>(text: string, params?: readonly unknown[]): Promise<PostgresQueryResult<R>> => {
          try {
            const res = await client.query<R>(text, params ? [...params] : undefined);
            return {
              rows: res.rows,
              rowCount: res.rowCount ?? res.rows.length,
            };
          } catch (err: unknown) {
            throw this.sanitizeError(err);
          }
        },
        release: () => client.release(),
      };
    } catch (err: unknown) {
      throw this.sanitizeError(err);
    }
  }

  async end(): Promise<void> {
    await this.inner.end();
  }

  private sanitizeError(err: unknown): Error {
    const origMsg = (err as Error)?.message ?? String(err);
    // Sanitize any credential or connection string occurrence in message
    const sanitizedMsg = origMsg
      .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, (matched) => sanitizeConnectionString(matched))
      .replace(/(password=)[^&;\s]+/gi, '$1***');

    const cleanErr = new Error(sanitizedMsg);
    if (typeof err === 'object' && err !== null && 'code' in err) {
      (cleanErr as any).code = (err as any).code;
    }
    return cleanErr;
  }
}

/**
 * Creates a real PostgreSQL pool if config has databaseUrl.
 */
export function createPgPool(config: PostgresConfig): PostgresPool {
  return new RealPgPool(config);
}
