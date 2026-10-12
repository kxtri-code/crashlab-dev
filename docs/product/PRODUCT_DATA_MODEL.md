# CrashLab Product Data Model

**Build 11: Database-Neutral Schema & Relational Specifications**

This document specifies the database-neutral domain schema for the CrashLab hosted SaaS product.

---

## 1. Storage Recommendation

CrashLab strongly recommends a **PostgreSQL-compatible relational database** (e.g. self-hosted PostgreSQL 16+ or Supabase Postgres) for future production deployment.

### Why Relational Storage Fits CrashLab:
1. **Strict Ownership Boundaries:** Multi-tenant workspace isolation requires relational foreign key cascades and row-level security (RLS).
2. **Deterministic Run Invariants:** Test runs depend on relational state machines, unique constraints, and ACID transactions.
3. **Structured Review Auditing:** Append-only event logs, revision sequences, and candidate relationships benefit from relational indexing.
4. **Complex Queries:** Filtered views by workspace, project, date range, rule ID, and review status require efficient multi-column b-tree indexes.

---

## 2. Entity Specifications

### 2.1 `users`
Represents an authenticated human operator or system administrator.
- **Primary Key:** `id` (`VARCHAR(36)`) e.g. `usr_...`
- **Workspace Ownership:** Global entity; referenced by workspaces and memberships.
- **Required Fields:** `id`, `schema_version`, `email`, `name`, `status`, `created_at`, `updated_at`.
- **Relationships:**
  - Has many `workspaces` (as owner).
  - Has many `workspace_members`.
- **Indexes:**
  - `UNIQUE (email)`
- **Secret-Handling Rules:** ZERO passwords, hashes, salts, or session tokens stored. Authentication is handled by an external provider (OAuth / OIDC / Supabase Auth).
- **Retention:** Permanent until explicit account deletion request.

---

### 2.2 `workspaces`
The primary tenant boundary in CrashLab.
- **Primary Key:** `id` (`VARCHAR(36)`) e.g. `ws_...`
- **Workspace Ownership:** Root tenant container (`id`).
- **Required Fields:** `id`, `schema_version`, `name`, `slug`, `owner_user_id`, `created_at`, `updated_at`.
- **Relationships:**
  - Belongs to `users` via `owner_user_id`.
  - Has many `workspace_members`, `projects`, `test_runs`, `audit_events`.
- **Indexes:**
  - `UNIQUE (slug)`
  - `INDEX (owner_user_id)`
- **Secret-Handling Rules:** Safe metadata only.
- **Retention:** Indefinite while workspace is active.

---

### 2.3 `workspace_members`
User membership and role assignment within a workspace.
- **Primary Key:** `id` (`VARCHAR(36)`) e.g. `mem_...`
- **Workspace Ownership:** `workspace_id`.
- **Required Fields:** `id`, `schema_version`, `workspace_id`, `user_id`, `role`, `created_at`, `updated_at`.
- **Relationships:**
  - Belongs to `workspaces` (`workspace_id`).
  - Belongs to `users` (`user_id`).
- **Indexes:**
  - `UNIQUE (workspace_id, user_id)`
  - `INDEX (user_id)`
- **Secret-Handling Rules:** Contains only role enum (`owner`, `member`, `reviewer`, `viewer`).
- **Retention:** Deleted upon member removal.

---

### 2.4 `projects`
An application or service under test within a workspace.
- **Primary Key:** `id` (`VARCHAR(36)`) e.g. `prj_...`
- **Workspace Ownership:** `workspace_id`.
- **Required Fields:** `id`, `schema_version`, `workspace_id`, `name`, `description`, `created_at`, `updated_at`.
- **Relationships:**
  - Belongs to `workspaces` (`workspace_id`).
  - Has many `target_environments`, `approved_journeys`, `test_runs`.
- **Indexes:**
  - `INDEX (workspace_id)`
  - `UNIQUE (workspace_id, name)`
- **Retention:** Cascade soft-deleted if project is removed.

---

### 2.5 `target_environments`
An authorized destination environment (e.g. staging, QA, demo, local loopback).
- **Primary Key:** `id` (`VARCHAR(36)`) e.g. `tgt_...`
- **Workspace Ownership:** `workspace_id`.
- **Required Fields:** `id`, `schema_version`, `workspace_id`, `project_id`, `name`, `environment`, `target_url`, `target_origin`, `allowed_origins`, `forbidden_actions`, `created_at`, `updated_at`.
- **Relationships:**
  - Belongs to `projects` (`project_id`).
  - Has many `approved_journeys`, `test_runs`.
- **Indexes:**
  - `INDEX (workspace_id, project_id)`
  - `INDEX (target_origin)`
- **Secret-Handling Rules:**
  - Prohibits `production`.
  - Non-secret references only (`authorization_reference`, `test_data_reference`).
  - ZERO passwords, cookies, bearer tokens, or API keys.
- **Retention:** Kept as long as historical test runs reference this configuration.

---

### 2.6 `approved_journeys`
A curated user journey plan approved by human QA for automated execution.
- **Primary Key:** `id` (`VARCHAR(36)`) e.g. `jny_...`
- **Workspace Ownership:** `workspace_id`.
- **Required Fields:** `id`, `schema_version`, `workspace_id`, `project_id`, `target_environment_id`, `goal`, `origin`, `allowed_actions`, `forbidden_actions`, `requires_credentials`, `requires_test_data`, `created_at`, `updated_at`.
- **Relationships:**
  - Belongs to `target_environments` (`target_environment_id`).
  - Has many `test_runs`.
- **Indexes:**
  - `INDEX (workspace_id, target_environment_id)`
- **Retention:** Preserved to maintain journey immutability and provenance.

---

### 2.7 `test_runs`
The lifecycle state machine entity for test executions.
- **Primary Key:** `id` (`VARCHAR(36)`) e.g. `run_...`
- **Workspace Ownership:** `workspace_id`.
- **Required Fields:** `id`, `schema_version`, `workspace_id`, `project_id`, `target_environment_id`, `journey_id`, `status`, `safe_test_mode`, `preflight_status`, `created_at`, `updated_at`.
- **Relationships:**
  - Belongs to `projects`, `target_environments`, `approved_journeys`.
  - Has many `run_artifacts`, `candidate_references`.
- **Indexes:**
  - `INDEX (workspace_id, project_id, created_at DESC)`
  - `INDEX (workspace_id, status)`
- **Retention:**
  - Metadata retained indefinitely.
  - Intermediate screenshots / traces archived after 90 days.

---

### 2.8 `run_artifacts`
Durable evidence files emitted during execution (execution.json, anomalies.json, etc.).
- **Primary Key:** `id` (`VARCHAR(36)`) e.g. `art_...`
- **Workspace Ownership:** `workspace_id`.
- **Required Fields:** `id`, `schema_version`, `workspace_id`, `run_id`, `type`, `storage_path`, `byte_size`, `sha256`, `content_type`, `created_at`.
- **Relationships:**
  - Belongs to `test_runs` (`run_id`).
- **Indexes:**
  - `INDEX (workspace_id, run_id)`
  - `INDEX (sha256)`
- **Retention:** Storage tiering (hot storage 30 days → cold storage 1 year).

---

### 2.9 `candidate_references`
Identified defect candidates linked to runs and projects.
- **Primary Key:** `id` (`VARCHAR(36)`) e.g. `candref_...`
- **Workspace Ownership:** `workspace_id`.
- **Required Fields:** `id`, `schema_version`, `workspace_id`, `project_id`, `run_id`, `candidate_id`, `rule_id`, `classification`, `reproduced`, `review_status`, `confirmed`, `confirmed_bug`, `created_at`, `updated_at`.
- **Relationships:**
  - Belongs to `test_runs` (`run_id`).
  - Has many `review_events`.
- **Indexes:**
  - `INDEX (workspace_id, project_id, review_status)`
  - `INDEX (candidate_id)`
- **Invariants:** `confirmed = false`, `confirmed_bug = false`.

---

### 2.10 `review_events`
Append-only human operator triage events (derived from Build 8 event store).
- **Primary Key:** `id` (`VARCHAR(36)`) e.g. `evt_...`
- **Workspace Ownership:** `workspace_id`.
- **Required Fields:** `id`, `workspace_id`, `candidate_id`, `reviewer_id`, `previous_status`, `new_status`, `revision`, `notes`, `created_at`.
- **Indexes:**
  - `INDEX (workspace_id, candidate_id, revision ASC)`
- **Retention:** Immutable append-only audit trail; never deleted.

---

### 2.11 `audit_events`
Immutable security and administrative compliance audit log.
- **Primary Key:** `id` (`VARCHAR(36)`) e.g. `aud_...`
- **Workspace Ownership:** `workspace_id`.
- **Required Fields:** `id`, `schema_version`, `workspace_id`, `actor_user_id`, `event_type`, `entity_type`, `entity_id`, `metadata`, `timestamp`.
- **Indexes:**
  - `INDEX (workspace_id, timestamp DESC)`
  - `INDEX (workspace_id, event_type)`
- **Secret-Handling Rules:**
  - Safe metadata only.
  - Prohibits passwords, tokens, cookies, raw test data, full request headers.
- **Retention:** Permanent compliance record (1–7 years depending on enterprise policy).
