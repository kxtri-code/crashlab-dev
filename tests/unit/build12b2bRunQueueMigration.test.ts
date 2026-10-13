/**
 * Build 12B.2B: Run Queue PostgreSQL Migration Tests
 *
 * Verifies:
 * 1. First application of 002_run_queue.sql migration
 * 2. Idempotent re-execution (second application is a safe no-op)
 * 3. Checksum verification against tampering
 * 4. Transactional rollback on migration failure
 * 5. Run queue schema, required 18 fields, indexes, and constraints
 * 6. Foreign-key references and cascade declarations
 */

import { describe, expect, it } from 'vitest';
import {
  loadStandardMigrations,
  runMigrations,
  RUN_QUEUE_MIGRATION_SQL,
  sha256,
} from '../../src/product/repository/migrationRunner.js';
import { MockPostgresPool } from '../../src/product/repository/mockPostgresClient.js';

describe('Build 12B.2B: Run Queue Migration (002_run_queue.sql)', () => {
  it('1. discovers and loads both 001 and 002 migrations in order', async () => {
    const migrations = await loadStandardMigrations();
    expect(migrations.length).toBeGreaterThanOrEqual(2);
    expect(migrations[0]!.name).toBe('001_initial_product_schema.sql');
    expect(migrations[1]!.name).toBe('002_run_queue.sql');
  });

  it('2. applies 002_run_queue.sql on first run and records checksum in _migrations', async () => {
    const pool = new MockPostgresPool();
    const result = await runMigrations(pool);

    expect(result.applied).toContain('001_initial_product_schema.sql');
    expect(result.applied).toContain('002_run_queue.sql');
    expect(result.alreadyApplied).toHaveLength(0);

    const checkRes = await pool.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM _migrations ORDER BY id ASC;',
    );
    expect(checkRes.rows).toHaveLength(2);

    const qMigration = checkRes.rows.find((r) => r.name === '002_run_queue.sql');
    expect(qMigration).toBeDefined();
    expect(qMigration!.checksum).toBe(sha256(RUN_QUEUE_MIGRATION_SQL));
    expect(qMigration!.checksum).toHaveLength(64);
  });

  it('3. second run is strictly idempotent (no re-application)', async () => {
    const pool = new MockPostgresPool();

    // First run
    const res1 = await runMigrations(pool);
    expect(res1.applied).toHaveLength(2);

    // Second run
    const res2 = await runMigrations(pool);
    expect(res2.applied).toHaveLength(0);
    expect(res2.alreadyApplied).toContain('001_initial_product_schema.sql');
    expect(res2.alreadyApplied).toContain('002_run_queue.sql');

    const checkRes = await pool.query('SELECT name FROM _migrations ORDER BY id ASC;');
    expect(checkRes.rows).toHaveLength(2);
  });

  it('4. detects tampering and rejects already-applied migration with altered checksum', async () => {
    const pool = new MockPostgresPool();
    await runMigrations(pool);

    const tampered = [
      { name: '001_initial_product_schema.sql', sql: '-- valid' },
      { name: '002_run_queue.sql', sql: RUN_QUEUE_MIGRATION_SQL + '\n-- tampered addition' },
    ];

    await expect(runMigrations(pool, tampered)).rejects.toThrow(
      /Migration checksum mismatch for/,
    );
  });

  it('5. rolls back transaction on SQL failure and does not record migration', async () => {
    const pool = new MockPostgresPool();

    const failingMigrations = [
      { name: '001_valid.sql', sql: 'CREATE TABLE IF NOT EXISTS test_ok (id VARCHAR(36) PRIMARY KEY);' },
      { name: '002_failing.sql', sql: 'FAIL INVALID SQL STATEMENT;' },
    ];

    await expect(runMigrations(pool, failingMigrations)).rejects.toThrow(/Syntax error in SQL/);

    const checkRes = await pool.query<{ name: string }>('SELECT name FROM _migrations ORDER BY id ASC;');
    expect(checkRes.rows.map((r) => r.name)).toEqual(['001_valid.sql']);
    expect(checkRes.rows.some((r) => r.name === '002_failing.sql')).toBe(false);
  });

  it('6. validates all 18 required queue fields are present in 002_run_queue.sql', () => {
    const requiredFields = [
      'run_id',
      'workspace_id',
      'project_id',
      'target_id',
      'journey_id',
      'queue_status',
      'attempt_count',
      'max_attempts',
      'available_at',
      'lease_owner',
      'lease_expiry',
      'started_at',
      'completed_at',
      'last_error',
      'cancellation_timestamp',
      'request_id',
      'created_at',
      'updated_at',
    ];

    for (const field of requiredFields) {
      expect(RUN_QUEUE_MIGRATION_SQL).toContain(field);
    }
  });

  it('7. validates required indexes exist in 002_run_queue.sql', () => {
    expect(RUN_QUEUE_MIGRATION_SQL).toContain('idx_run_queue_claim ON run_queue(queue_status, available_at)');
    expect(RUN_QUEUE_MIGRATION_SQL).toContain('idx_run_queue_lease ON run_queue(lease_owner, lease_expiry)');
    expect(RUN_QUEUE_MIGRATION_SQL).toContain('idx_run_queue_workspace ON run_queue(workspace_id)');
    expect(RUN_QUEUE_MIGRATION_SQL).toContain('idx_run_queue_project ON run_queue(project_id)');
    expect(RUN_QUEUE_MIGRATION_SQL).toContain('idx_run_queue_target ON run_queue(target_id)');
    expect(RUN_QUEUE_MIGRATION_SQL).toContain('idx_run_queue_journey ON run_queue(journey_id)');
  });

  it('8. validates constraints on queue_status and attempt counts', () => {
    expect(RUN_QUEUE_MIGRATION_SQL).toContain('chk_run_queue_status');
    expect(RUN_QUEUE_MIGRATION_SQL).toContain('chk_run_queue_attempt_count');
    expect(RUN_QUEUE_MIGRATION_SQL).toContain('chk_run_queue_max_attempts');
  });

  it('9. validates foreign-key cascade definitions match existing schema', () => {
    expect(RUN_QUEUE_MIGRATION_SQL).toContain('REFERENCES test_runs(id) ON DELETE CASCADE');
    expect(RUN_QUEUE_MIGRATION_SQL).toContain('REFERENCES workspaces(id) ON DELETE CASCADE');
    expect(RUN_QUEUE_MIGRATION_SQL).toContain('REFERENCES projects(id) ON DELETE CASCADE');
    expect(RUN_QUEUE_MIGRATION_SQL).toContain('REFERENCES target_environments(id) ON DELETE CASCADE');
    expect(RUN_QUEUE_MIGRATION_SQL).toContain('REFERENCES approved_journeys(id) ON DELETE CASCADE');
  });
});
