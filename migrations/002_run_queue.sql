-- =============================================================================
-- CrashLab Product Schema Migration: Run Queue (002_run_queue.sql)
-- Build 12B.2B: PostgreSQL-Backed Asynchronous Run Queue and Worker Dispatcher
--
-- Enforces:
-- 1. Multi-tenant workspace, project, target, journey, and run foreign key integrity
-- 2. Concurrency-safe queue tracking with lease management
-- 3. Atomic claiming via queue_status and available_at indexes
-- 4. Safe constraints on queue_status, attempt_count, and max_attempts
-- =============================================================================

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
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_run_queue_status CHECK (queue_status IN ('queued', 'preflight', 'running', 'cancelling', 'completed', 'failed', 'blocked', 'cancelled')),
  CONSTRAINT chk_run_queue_attempt_count CHECK (attempt_count >= 1),
  CONSTRAINT chk_run_queue_max_attempts CHECK (max_attempts >= 1)
);

CREATE INDEX IF NOT EXISTS idx_run_queue_claim ON run_queue(queue_status, available_at);
CREATE INDEX IF NOT EXISTS idx_run_queue_lease ON run_queue(lease_owner, lease_expiry);
CREATE INDEX IF NOT EXISTS idx_run_queue_workspace ON run_queue(workspace_id);
CREATE INDEX IF NOT EXISTS idx_run_queue_project ON run_queue(project_id);
CREATE INDEX IF NOT EXISTS idx_run_queue_target ON run_queue(target_id);
CREATE INDEX IF NOT EXISTS idx_run_queue_journey ON run_queue(journey_id);
