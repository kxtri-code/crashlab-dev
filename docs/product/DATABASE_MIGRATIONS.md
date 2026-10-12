# CrashLab Database Migrations

**Build 12A: PostgreSQL Persistence Adapter**

This document details the database migration system, schema structure, and operational execution for CrashLab.

---

## 1. Migration Architecture

Migrations reside as raw SQL scripts in `migrations/` and are tracked in the database inside the `_migrations` table:

```sql
CREATE TABLE IF NOT EXISTS _migrations (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL UNIQUE,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  checksum VARCHAR(64) NOT NULL
);
```

### Invariants:
1. **Transactional:** Each migration is executed inside a database transaction (`BEGIN ... COMMIT`). If any statement fails, the transaction is rolled back immediately (`ROLLBACK`).
2. **Idempotent:** Running migrations repeatedly only applies pending files. Already-applied migrations are safely skipped.
3. **Deterministic & Repeatable:** Checksums (SHA-256) are recorded to guard against accidental migration file drift.
4. **No Destructive Drops:** Migrations never alter or drop existing historical evidence or candidate triage records.

---

## 2. Initial Migration: `001_initial_product_schema.sql`

The initial migration provisions all 10 domain entities:

| Table | Primary Key | Workspace Boundary | Foreign Keys | Key Indexes |
| :--- | :--- | :--- | :--- | :--- |
| `users` | `id VARCHAR(36)` | Global identity | None | `email` (unique) |
| `workspaces` | `id VARCHAR(36)` | Root container | `owner_user_id -> users` | `slug` (unique), `owner_user_id` |
| `workspace_members` | `id VARCHAR(36)` | `workspace_id` | `workspace_id -> workspaces`<br>`user_id -> users` | `(workspace_id, user_id)` (unique) |
| `projects` | `id VARCHAR(36)` | `workspace_id` | `workspace_id -> workspaces` | `(workspace_id, name)` (unique) |
| `target_environments` | `id VARCHAR(36)` | `workspace_id` | `project_id -> projects` | `(workspace_id, project_id)`, `target_origin` |
| `approved_journeys` | `id VARCHAR(36)` | `workspace_id` | `target_environment_id -> targets` | `(workspace_id, target_environment_id)` |
| `test_runs` | `id VARCHAR(36)` | `workspace_id` | `project_id -> projects`<br>`target_id -> targets` | `(workspace_id, project_id, created_at DESC)` |
| `run_artifacts` | `id VARCHAR(36)` | `workspace_id` | `run_id -> test_runs` | `(workspace_id, run_id)`, `sha256` |
| `candidate_references` | `id VARCHAR(36)` | `workspace_id` | `run_id -> test_runs`<br>`project_id -> projects` | `(workspace_id, project_id, review_status)` |
| `audit_events` | `id VARCHAR(36)` | `workspace_id` | `workspace_id -> workspaces` | `(workspace_id, timestamp DESC)` |

---

## 3. CLI Execution

To apply pending migrations:

```bash
npm run db:migrate
```

To view help and options:

```bash
npm run db:migrate -- --help
```

### Exit Codes:
- `0`: Migrations succeeded or all migrations already applied.
- `1`: Database connection error or SQL migration failure.
- `2`: Invalid CLI syntax or unsupported arguments.
