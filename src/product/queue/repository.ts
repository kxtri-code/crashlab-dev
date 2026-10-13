/**
 * Run Queue Repository & Storage Adapters — Build 12B.2B.
 *
 * Implements persistent and in-memory storage for the asynchronous run queue.
 * Guarantees:
 * - 100% Parameterized queries
 * - Atomic claiming with lease expiration detection
 * - Concurrency safety (two workers cannot claim the same run simultaneously)
 * - Safe lease renewal and release
 * - Zero secrets or credentials persisted
 */

import type { PostgresPool } from '../repository/postgresPool.js';
import type { ClaimOptions, RunQueueItem } from './types.js';
import { assertSafeWorkerId } from './types.js';
import { assertNoSecrets } from '../secrets/sanitizer.js';

export interface RunQueueRepository {
  enqueue(item: RunQueueItem): Promise<RunQueueItem>;
  claimNext(options: ClaimOptions): Promise<RunQueueItem | null>;
  renewLease(runId: string, workerId: string, leaseSeconds: number): Promise<boolean>;
  releaseLease(runId: string, workerId: string): Promise<boolean>;
  findByRunId(workspaceId: string, runId: string): Promise<RunQueueItem | null>;
  update(item: RunQueueItem): Promise<RunQueueItem>;
  listByWorkspace(workspaceId: string): Promise<readonly RunQueueItem[]>;
}

function clone<T>(val: T): T {
  return JSON.parse(JSON.stringify(val)) as T;
}

function toIsoString(val: unknown): string {
  if (!val) return new Date().toISOString();
  if (val instanceof Date) return val.toISOString();
  return new Date(String(val)).toISOString();
}

// =============================================================================
// 1. In-Memory Run Queue Repository (For unit tests & transient dev)
// =============================================================================

export class InMemoryRunQueueRepository implements RunQueueRepository {
  private readonly items = new Map<string, RunQueueItem>();

  async enqueue(item: RunQueueItem): Promise<RunQueueItem> {
    assertNoSecrets(item, 'RunQueueItem');
    if (this.items.has(item.runId)) {
      throw new Error(`Queue item for run "${item.runId}" already exists.`);
    }
    const cloned = clone(item);
    this.items.set(item.runId, cloned);
    return clone(cloned);
  }

  async claimNext(options: ClaimOptions): Promise<RunQueueItem | null> {
    assertSafeWorkerId(options.workerId);
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const leaseSeconds = options.leaseSeconds ?? 60;
    const leaseExpiry = new Date(nowMs + leaseSeconds * 1000).toISOString();

    // Filter eligible items
    const candidates: RunQueueItem[] = [];
    for (const item of this.items.values()) {
      if (options.workspaceId && item.workspaceId !== options.workspaceId) {
        continue;
      }

      const isQueuedAndAvailable =
        item.queueStatus === 'queued' && item.availableAt <= nowIso;

      const isExpiredLease =
        ['preflight', 'running'].includes(item.queueStatus) &&
        item.leaseExpiry !== null &&
        item.leaseExpiry < nowIso;

      if (isQueuedAndAvailable || isExpiredLease) {
        candidates.push(item);
      }
    }

    if (candidates.length === 0) {
      return null;
    }

    // Sort by availableAt ASC, createdAt ASC
    candidates.sort((a, b) => {
      if (a.availableAt < b.availableAt) return -1;
      if (a.availableAt > b.availableAt) return 1;
      if (a.createdAt < b.createdAt) return -1;
      if (a.createdAt > b.createdAt) return 1;
      return 0;
    });

    const chosen = candidates[0]!;

    // Atomic update
    const updated: RunQueueItem = {
      ...chosen,
      queueStatus: 'preflight',
      leaseOwner: options.workerId,
      leaseExpiry,
      updatedAt: nowIso,
    };

    this.items.set(chosen.runId, updated);
    return clone(updated);
  }

  async renewLease(runId: string, workerId: string, leaseSeconds: number): Promise<boolean> {
    assertSafeWorkerId(workerId);
    const item = this.items.get(runId);
    if (!item) return false;

    // Check worker ownership
    if (item.leaseOwner !== workerId) return false;

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();

    // Do not renew if lease already expired and lost
    if (item.leaseExpiry && item.leaseExpiry < nowIso) {
      return false;
    }

    const newExpiry = new Date(nowMs + leaseSeconds * 1000).toISOString();
    const updated: RunQueueItem = {
      ...item,
      leaseExpiry: newExpiry,
      updatedAt: nowIso,
    };

    this.items.set(runId, updated);
    return true;
  }

  async releaseLease(runId: string, workerId: string): Promise<boolean> {
    assertSafeWorkerId(workerId);
    const item = this.items.get(runId);
    if (!item) return false;
    if (item.leaseOwner !== workerId) return false;

    const updated: RunQueueItem = {
      ...item,
      leaseOwner: null,
      leaseExpiry: null,
      updatedAt: new Date().toISOString(),
    };

    this.items.set(runId, updated);
    return true;
  }

  async findByRunId(workspaceId: string, runId: string): Promise<RunQueueItem | null> {
    const item = this.items.get(runId);
    if (!item || item.workspaceId !== workspaceId) return null;
    return clone(item);
  }

  async update(item: RunQueueItem): Promise<RunQueueItem> {
    assertNoSecrets(item, 'RunQueueItem');
    const existing = this.items.get(item.runId);
    if (!existing || existing.workspaceId !== item.workspaceId) {
      throw new Error(`Queue item for run "${item.runId}" not found in workspace "${item.workspaceId}".`);
    }
    const cloned = clone(item);
    this.items.set(item.runId, cloned);
    return clone(cloned);
  }

  async listByWorkspace(workspaceId: string): Promise<readonly RunQueueItem[]> {
    const results: RunQueueItem[] = [];
    for (const item of this.items.values()) {
      if (item.workspaceId === workspaceId) {
        results.push(clone(item));
      }
    }
    return results;
  }

  clear(): void {
    this.items.clear();
  }
}

// =============================================================================
// 2. PostgreSQL Run Queue Repository (For production & staging database)
// =============================================================================

export class PostgresRunQueueRepository implements RunQueueRepository {
  private schemaEnsured = false;

  constructor(private readonly pool: PostgresPool) {}

  public async ensureSchema(): Promise<void> {
    if (this.schemaEnsured) return;

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS run_queue (
        run_id VARCHAR(36) PRIMARY KEY REFERENCES test_runs(id) ON DELETE CASCADE,
        workspace_id VARCHAR(36) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        project_id VARCHAR(36) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        target_id VARCHAR(36) NOT NULL REFERENCES target_environments(id) ON DELETE CASCADE,
        journey_id VARCHAR(36) NOT NULL REFERENCES approved_journeys(id) ON DELETE CASCADE,
        queue_status VARCHAR(32) NOT NULL DEFAULT 'queued',
        attempt_count INTEGER NOT NULL DEFAULT 1,
        max_attempts INTEGER NOT NULL DEFAULT 1,
        available_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        lease_owner VARCHAR(128),
        lease_expiry TIMESTAMPTZ,
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        last_error TEXT,
        cancellation_timestamp TIMESTAMPTZ,
        request_id VARCHAR(64),
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_run_queue_claim ON run_queue(queue_status, available_at);
      CREATE INDEX IF NOT EXISTS idx_run_queue_lease ON run_queue(lease_owner, lease_expiry);
      CREATE INDEX IF NOT EXISTS idx_run_queue_workspace ON run_queue(workspace_id);
    `);

    this.schemaEnsured = true;
  }

  private mapRow(row: any): RunQueueItem {
    return Object.freeze({
      runId: row.run_id,
      workspaceId: row.workspace_id,
      projectId: row.project_id,
      targetId: row.target_id,
      journeyId: row.journey_id,
      queueStatus: row.queue_status,
      attemptCount: Number(row.attempt_count ?? 1),
      maxAttempts: Number(row.max_attempts ?? 1),
      availableAt: toIsoString(row.available_at),
      leaseOwner: row.lease_owner ?? null,
      leaseExpiry: row.lease_expiry ? toIsoString(row.lease_expiry) : null,
      startedAt: row.started_at ? toIsoString(row.started_at) : null,
      completedAt: row.completed_at ? toIsoString(row.completed_at) : null,
      lastError: row.last_error ?? null,
      cancellationTimestamp: row.cancellation_timestamp ? toIsoString(row.cancellation_timestamp) : null,
      requestId: row.request_id ?? null,
      createdAt: toIsoString(row.created_at),
      updatedAt: toIsoString(row.updated_at),
    });
  }

  async enqueue(item: RunQueueItem): Promise<RunQueueItem> {
    assertNoSecrets(item, 'RunQueueItem');
    await this.ensureSchema();

    await this.pool.query(
      `INSERT INTO run_queue (
        run_id, workspace_id, project_id, target_id, journey_id,
        queue_status, attempt_count, max_attempts, available_at,
        lease_owner, lease_expiry, started_at, completed_at,
        last_error, cancellation_timestamp, request_id, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18);`,
      [
        item.runId,
        item.workspaceId,
        item.projectId,
        item.targetId,
        item.journeyId,
        item.queueStatus,
        item.attemptCount,
        item.maxAttempts,
        item.availableAt,
        item.leaseOwner,
        item.leaseExpiry,
        item.startedAt,
        item.completedAt,
        item.lastError,
        item.cancellationTimestamp,
        item.requestId,
        item.createdAt,
        item.updatedAt,
      ],
    );

    return clone(item);
  }

  async claimNext(options: ClaimOptions): Promise<RunQueueItem | null> {
    assertSafeWorkerId(options.workerId);
    await this.ensureSchema();

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN;');

      const nowIso = new Date().toISOString();
      const leaseSeconds = options.leaseSeconds ?? 60;
      const leaseExpiry = new Date(Date.now() + leaseSeconds * 1000).toISOString();

      let selectSql = `
        SELECT * FROM run_queue
        WHERE ((queue_status = 'queued' AND available_at <= $1)
           OR (queue_status IN ('preflight', 'running') AND lease_expiry < $1))
      `;
      const selectParams: unknown[] = [nowIso];

      if (options.workspaceId) {
        selectSql += ' AND workspace_id = $2';
        selectParams.push(options.workspaceId);
      }

      selectSql += `
        ORDER BY available_at ASC, created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED;
      `;

      const candidateRes = await client.query(selectSql, selectParams);
      if (candidateRes.rows.length === 0) {
        await client.query('COMMIT;');
        return null;
      }

      const candidate = candidateRes.rows[0];

      const updateRes = await client.query(
        `UPDATE run_queue
         SET queue_status = 'preflight', lease_owner = $1, lease_expiry = $2, updated_at = $3
         WHERE run_id = $4
         RETURNING *;`,
        [options.workerId, leaseExpiry, nowIso, candidate.run_id],
      );

      await client.query('COMMIT;');

      const row = updateRes.rows.length > 0 ? updateRes.rows[0] : {
        ...candidate,
        queue_status: 'preflight',
        lease_owner: options.workerId,
        lease_expiry: leaseExpiry,
        updated_at: nowIso,
      };

      return this.mapRow(row);
    } catch (err) {
      try {
        await client.query('ROLLBACK;');
      } catch {}
      throw err;
    } finally {
      client.release();
    }
  }

  async renewLease(runId: string, workerId: string, leaseSeconds: number): Promise<boolean> {
    assertSafeWorkerId(workerId);
    await this.ensureSchema();

    const nowIso = new Date().toISOString();
    const newExpiry = new Date(Date.now() + leaseSeconds * 1000).toISOString();

    const res = await this.pool.query(
      `UPDATE run_queue
       SET lease_expiry = $1, updated_at = $2
       WHERE run_id = $3 AND lease_owner = $4 AND (lease_expiry IS NULL OR lease_expiry >= $5);`,
      [newExpiry, nowIso, runId, workerId, nowIso],
    );

    return res.rowCount > 0;
  }

  async releaseLease(runId: string, workerId: string): Promise<boolean> {
    assertSafeWorkerId(workerId);
    await this.ensureSchema();

    const nowIso = new Date().toISOString();
    const res = await this.pool.query(
      `UPDATE run_queue
       SET lease_owner = NULL, lease_expiry = NULL, updated_at = $1
       WHERE run_id = $2 AND lease_owner = $3;`,
      [nowIso, runId, workerId],
    );

    return res.rowCount > 0;
  }

  async findByRunId(workspaceId: string, runId: string): Promise<RunQueueItem | null> {
    await this.ensureSchema();
    const res = await this.pool.query(
      'SELECT * FROM run_queue WHERE workspace_id = $1 AND run_id = $2;',
      [workspaceId, runId],
    );
    if (res.rows.length === 0) return null;
    return this.mapRow(res.rows[0]);
  }

  async update(item: RunQueueItem): Promise<RunQueueItem> {
    assertNoSecrets(item, 'RunQueueItem');
    await this.ensureSchema();

    const res = await this.pool.query(
      `UPDATE run_queue
       SET queue_status = $1, attempt_count = $2, max_attempts = $3, available_at = $4,
           lease_owner = $5, lease_expiry = $6, started_at = $7, completed_at = $8,
           last_error = $9, cancellation_timestamp = $10, request_id = $11, updated_at = $12
       WHERE workspace_id = $13 AND run_id = $14;`,
      [
        item.queueStatus,
        item.attemptCount,
        item.maxAttempts,
        item.availableAt,
        item.leaseOwner ?? null,
        item.leaseExpiry ?? null,
        item.startedAt ?? null,
        item.completedAt ?? null,
        item.lastError ?? null,
        item.cancellationTimestamp ?? null,
        item.requestId ?? null,
        item.updatedAt,
        item.workspaceId,
        item.runId,
      ],
    );

    if (res.rowCount === 0) {
      throw new Error(`Queue item for run "${item.runId}" not found in workspace "${item.workspaceId}".`);
    }

    return clone(item);
  }

  async listByWorkspace(workspaceId: string): Promise<readonly RunQueueItem[]> {
    await this.ensureSchema();
    const res = await this.pool.query(
      'SELECT * FROM run_queue WHERE workspace_id = $1 ORDER BY created_at DESC;',
      [workspaceId],
    );
    return res.rows.map((r) => this.mapRow(r));
  }
}
