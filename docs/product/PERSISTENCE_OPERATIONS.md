# Persistence Operations and Data Security

**Build 12A: PostgreSQL Persistence Adapter**

This document specifies data boundaries, security guarantees, backup policies, and operations for CrashLab's persistence tier.

---

## 1. What Data is Stored vs Never Stored

### Stored in Database:
- Safe metadata for users, workspaces, projects, and target environments
- Non-secret authorization references (ticket keys, written approval codes)
- Non-secret test data references (vault identifiers, synthetic fixture names)
- Approved journey goals, origins, and non-destructive action constraints
- Test run state machine records and execution status transitions
- Cryptographic SHA-256 checksums, byte sizes, and paths of generated evidence files
- Candidate defect findings with non-confirmed triage leads
- Append-only audit logs with sanitized metadata

### NEVER Stored in Database:
- Passwords, password hashes, salts, or recovery questions
- Session cookies, bearer tokens, or API keys
- Raw test data values, synthetic credentials, or personally identifiable information
- Arbitrary browser HTTP request headers or raw POST request payloads
- Full HTML page contents, raw DOM dumps, or unsanitized script logs
- Real production target hostnames or production environment configurations

> [!IMPORTANT]
> The database adapter actively calls `assertNoSecrets()` on every entity and metadata payload prior to SQL execution. Any attempt to persist a prohibited key (`password`, `token`, `cookie`, `apiKey`, `bearer`) immediately throws an error and aborts the query.

---

## 2. Tenant Isolation Enforcement

CrashLab enforces multi-tenant boundaries at two independent layers:

1. **Product Service Layer:**
   Authorization checks (`canReadWorkspace`, `canManageProject`, `canRunProject`, etc.) verify actor membership and role before any repository method is invoked.

2. **Repository Query Layer:**
   Every query accessing tenant data mandates `workspace_id = $1` in its WHERE clause.
   - Cross-workspace queries are structurally impossible.
   - Foreign workspace IDs passed in lookups return `null` or 0 updated rows even if an entity with that primary key exists in another workspace.

---

## 3. Run Revisions & Optimistic State Transitions

- The test run state machine (`created -> preflight -> queued -> running -> completed | partial | failed | blocked | cancelled`) requires strict validation before update.
- Terminal run states (`completed`, `failed`, `blocked`, `cancelled`) are permanently immutable.
- Updates preserve `safeTestMode: true` unconditionally.

---

## 4. Append-Only Audit Trail

- The `audit_events` table is append-only.
- `PostgresAuditRepository` implements only `create`, `findById`, and `listByWorkspace`.
- There are no `update` or `delete` methods.
- Audit entries are sorted in reverse chronological order (`ORDER BY timestamp DESC`).

---

## 5. Connection Pool Lifecycle & Graceful Shutdown

- CrashLab uses standard connection pooling via `pg.Pool`.
- Connection pools should be closed gracefully upon process termination using `pool.end()`.
- Error wrappers sanitize all database errors, stripping credentials and connection strings from user-facing logs.

---

## 6. Backup & Retention Considerations

| Data Entity | Retention Policy | Archival Recommendation |
| :--- | :--- | :--- |
| `users`, `workspaces`, `projects` | Permanent until workspace deletion | Daily logical backup (pg_dump) |
| `target_environments`, `approved_journeys` | Indefinite for run provenance | Daily logical backup |
| `test_runs` | Indefinite (lightweight metadata) | Partition by year if run volume > 100k/yr |
| `run_artifacts` | 90 days active -> 1 year cold blob storage | S3 lifecycle rules for underlying files |
| `candidate_references` | Indefinite | Retained for regression tracking across runs |
| `audit_events` | 1 to 7 years (compliance dependent) | Immutable write-once storage |
