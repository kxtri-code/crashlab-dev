/**
 * Database Migration Runner — Build 12A: PostgreSQL Adapter.
 *
 * Runs deterministic, repeatable SQL migrations against a PostgresPool.
 * Tracks applied migrations in the `_migrations` table.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { PostgresPool } from './postgresPool.js';

export interface MigrationFile {
  readonly name: string;
  readonly sql: string;
}

export interface MigrationResult {
  readonly applied: readonly string[];
  readonly alreadyApplied: readonly string[];
}

/**
 * Built-in initial schema SQL migration.
 * Kept in code to ensure deterministic availability across all test and runtime contexts.
 */
export const INITIAL_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS _migrations (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL UNIQUE,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  checksum VARCHAR(64) NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(36) PRIMARY KEY,
  schema_version VARCHAR(16) NOT NULL DEFAULT '1.0',
  email VARCHAR(255) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(LOWER(email));

CREATE TABLE IF NOT EXISTS workspaces (
  id VARCHAR(36) PRIMARY KEY,
  schema_version VARCHAR(16) NOT NULL DEFAULT '1.0',
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(255) NOT NULL UNIQUE,
  owner_user_id VARCHAR(36) NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workspaces_owner ON workspaces(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_workspaces_slug ON workspaces(LOWER(slug));

CREATE TABLE IF NOT EXISTS workspace_members (
  id VARCHAR(36) PRIMARY KEY,
  schema_version VARCHAR(16) NOT NULL DEFAULT '1.0',
  workspace_id VARCHAR(36) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(32) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT uq_workspace_members_ws_user UNIQUE (workspace_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_members_workspace ON workspace_members(workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspace_members_user ON workspace_members(user_id);

CREATE TABLE IF NOT EXISTS projects (
  id VARCHAR(36) PRIMARY KEY,
  schema_version VARCHAR(16) NOT NULL DEFAULT '1.0',
  workspace_id VARCHAR(36) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT uq_projects_ws_name UNIQUE (workspace_id, name)
);

CREATE INDEX IF NOT EXISTS idx_projects_workspace ON projects(workspace_id);

CREATE TABLE IF NOT EXISTS target_environments (
  id VARCHAR(36) PRIMARY KEY,
  schema_version VARCHAR(16) NOT NULL DEFAULT '1.0',
  workspace_id VARCHAR(36) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id VARCHAR(36) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  environment VARCHAR(32) NOT NULL,
  target_url TEXT NOT NULL,
  target_origin TEXT NOT NULL,
  allowed_origins JSONB NOT NULL DEFAULT '[]'::jsonb,
  app_build_id VARCHAR(255),
  authorization_reference VARCHAR(255),
  test_data_reference VARCHAR(255),
  forbidden_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  reset_procedure TEXT,
  testing_window TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_targets_workspace_project ON target_environments(workspace_id, project_id);
CREATE INDEX IF NOT EXISTS idx_targets_origin ON target_environments(target_origin);

CREATE TABLE IF NOT EXISTS approved_journeys (
  id VARCHAR(36) PRIMARY KEY,
  schema_version VARCHAR(16) NOT NULL DEFAULT '1.0',
  workspace_id VARCHAR(36) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id VARCHAR(36) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  target_environment_id VARCHAR(36) NOT NULL REFERENCES target_environments(id) ON DELETE CASCADE,
  goal TEXT NOT NULL,
  origin TEXT NOT NULL,
  allowed_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  forbidden_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  requires_credentials BOOLEAN NOT NULL DEFAULT FALSE,
  requires_test_data BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_journeys_workspace_target ON approved_journeys(workspace_id, target_environment_id);
CREATE INDEX IF NOT EXISTS idx_journeys_workspace_project ON approved_journeys(workspace_id, project_id);

CREATE TABLE IF NOT EXISTS test_runs (
  id VARCHAR(36) PRIMARY KEY,
  schema_version VARCHAR(16) NOT NULL DEFAULT '1.0',
  workspace_id VARCHAR(36) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id VARCHAR(36) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  target_environment_id VARCHAR(36) NOT NULL REFERENCES target_environments(id) ON DELETE CASCADE,
  journey_id VARCHAR(36) NOT NULL REFERENCES approved_journeys(id) ON DELETE CASCADE,
  status VARCHAR(32) NOT NULL,
  safe_test_mode BOOLEAN NOT NULL DEFAULT TRUE,
  preflight_status VARCHAR(32) NOT NULL DEFAULT 'pending',
  preflight_report_ref VARCHAR(255),
  execution_report_ref VARCHAR(255),
  anomaly_report_ref VARCHAR(255),
  reproduction_report_ref VARCHAR(255),
  candidates_report_ref VARCHAR(255),
  baseline_ref VARCHAR(255),
  blocked_reason TEXT,
  failure_reason TEXT,
  cancel_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_runs_workspace_project_created ON test_runs(workspace_id, project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_workspace_status ON test_runs(workspace_id, status);

CREATE TABLE IF NOT EXISTS run_artifacts (
  id VARCHAR(36) PRIMARY KEY,
  schema_version VARCHAR(16) NOT NULL DEFAULT '1.0',
  workspace_id VARCHAR(36) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id VARCHAR(36) NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
  type VARCHAR(64) NOT NULL,
  storage_path TEXT NOT NULL,
  byte_size BIGINT NOT NULL,
  sha256 VARCHAR(64) NOT NULL,
  content_type VARCHAR(128) NOT NULL DEFAULT 'application/json',
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_artifacts_workspace_run ON run_artifacts(workspace_id, run_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_sha256 ON run_artifacts(sha256);

CREATE TABLE IF NOT EXISTS candidate_references (
  id VARCHAR(36) PRIMARY KEY,
  schema_version VARCHAR(16) NOT NULL DEFAULT '1.0',
  workspace_id VARCHAR(36) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id VARCHAR(36) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id VARCHAR(36) NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
  candidate_id VARCHAR(64) NOT NULL,
  rule_id VARCHAR(64) NOT NULL,
  classification VARCHAR(64) NOT NULL,
  reproduced BOOLEAN NOT NULL DEFAULT FALSE,
  review_status VARCHAR(32) NOT NULL DEFAULT 'unreviewed',
  confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  confirmed_bug BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_candidates_workspace_project_status ON candidate_references(workspace_id, project_id, review_status);
CREATE INDEX IF NOT EXISTS idx_candidates_workspace_run ON candidate_references(workspace_id, run_id);
CREATE INDEX IF NOT EXISTS idx_candidates_candidate_id ON candidate_references(candidate_id);

CREATE TABLE IF NOT EXISTS audit_events (
  id VARCHAR(36) PRIMARY KEY,
  schema_version VARCHAR(16) NOT NULL DEFAULT '1.0',
  workspace_id VARCHAR(36) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_user_id VARCHAR(36) NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  entity_type VARCHAR(64) NOT NULL,
  entity_id VARCHAR(64) NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  timestamp TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_workspace_timestamp ON audit_events(workspace_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_workspace_event_type ON audit_events(workspace_id, event_type);
`;

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Loads standard migrations.
 */
export async function loadStandardMigrations(migrationsDir?: string): Promise<readonly MigrationFile[]> {
  const dir = migrationsDir ?? resolve(process.cwd(), 'migrations');
  try {
    const filePath = resolve(dir, '001_initial_product_schema.sql');
    const sql = await readFile(filePath, 'utf8');
    return [{ name: '001_initial_product_schema.sql', sql }];
  } catch {
    // Fallback to built-in SQL
    return [{ name: '001_initial_product_schema.sql', sql: INITIAL_MIGRATION_SQL }];
  }
}

/**
 * Executes pending migrations in transaction-safe order.
 */
export async function runMigrations(
  pool: PostgresPool,
  migrations?: readonly MigrationFile[],
): Promise<MigrationResult> {
  const list = migrations ?? (await loadStandardMigrations());
  const applied: string[] = [];
  const alreadyApplied: string[] = [];

  const client = await pool.connect();
  try {
    // 1. Ensure migrations table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        checksum VARCHAR(64) NOT NULL
      );
    `);

    // 2. Fetch existing migrations
    const existingRes = await client.query<{ name: string }>('SELECT name FROM _migrations ORDER BY id ASC;');
    const existingNames = new Set(existingRes.rows.map((r) => r.name));

    // 3. Apply missing migrations in order
    for (const mig of list) {
      if (existingNames.has(mig.name)) {
        alreadyApplied.push(mig.name);
        continue;
      }

      await client.query('BEGIN;');
      try {
        await client.query(mig.sql);
        const checksum = sha256(mig.sql);
        await client.query(
          'INSERT INTO _migrations (name, checksum) VALUES ($1, $2);',
          [mig.name, checksum],
        );
        await client.query('COMMIT;');
        applied.push(mig.name);
      } catch (err) {
        await client.query('ROLLBACK;');
        throw err;
      }
    }

    return { applied, alreadyApplied };
  } finally {
    client.release();
  }
}
