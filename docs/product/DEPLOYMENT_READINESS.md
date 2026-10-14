# CrashLab Deployment Readiness & Operations Guide

**Build 12D.1: Production Authentication and Deployment Readiness**

This document specifies the operational policies, environment validation, health/readiness probes, and hosting boundaries required to run CrashLab in a private hosted beta.

---

## 1. Production Environment Validation

Before serving traffic in production (`PRODUCT_AUTH_MODE=production`), the application runs `validateProductionEnvironment` (`src/product/deployment/readiness.ts`).

### Strict Startup Validation Rules
- **Authentication:** `SUPABASE_JWKS_URL`, `SUPABASE_JWT_ISSUER`, and `SUPABASE_JWT_AUDIENCE` must be present.
- **Storage:** If `PRODUCT_STORAGE=postgres`, `DATABASE_URL` must be provided.
- **Blob Storage:**
  - If `PRODUCT_BLOB_STORE=supabase`: `SUPABASE_URL`, `SUPABASE_STORAGE_BUCKET`, and `SUPABASE_SERVICE_ROLE_KEY` must be present. Bucket privacy is verified via `npm run storage:check`.
  - If `PRODUCT_BLOB_STORE=local`: The server will refuse to start in production unless `PRODUCT_BLOB_ALLOW_LOCAL_IN_PRODUCTION=true` is explicitly set.
- **CORS Allowlist:** Wildcard origins (`*`) are prohibited in production mode.
- **Worker Isolation:** The API server must **not** automatically run a worker queue loop. `PRODUCT_WORKER_ENABLED` must be explicitly configured.

```text
Startup Refusal Example:
[FATAL CONFIG ERROR] Production environment validation failed:
- Missing required storage variable: SUPABASE_SERVICE_ROLE_KEY
- Local blob storage is refused in production without explicit PRODUCT_BLOB_ALLOW_LOCAL_IN_PRODUCTION=true override.
- Production CORS origin cannot be wildcard '*'.
```

Only variable names are reported in failure messages; credential values are never printed or leaked.

---

## 2. Health & Readiness Probes

CrashLab exposes unauthenticated, credential-safe health and readiness endpoints for container orchestrators (e.g. Kubernetes, Fly.io, ECS, Docker):

### 2.1 Liveness Probe: `GET /health`
- **Purpose:** Quick process heartbeat. Returns whether the HTTP listener is responsive.
- **Status Codes:** `200 OK`
- **Payload:**
  ```json
  {
    "status": "ok",
    "version": "0.1.0",
    "appEnvironment": "local",
    "mode": "hosted-mvp-foundation"
  }
  ```

### 2.2 Readiness Probe: `GET /readiness`
- **Purpose:** Deep dependency readiness check. Verifies:
  1. **Database Connectivity:** Executes a non-destructive ping (`SELECT 1`) against PostgreSQL or checks in-memory store.
  2. **Storage Readiness:** Verifies blob store availability.
- **Status Codes:**
  - `200 OK`: All dependencies healthy.
  - `503 Service Unavailable`: One or more dependencies unreachable or degraded.
- **Payload (200 OK):**
  ```json
  {
    "status": "ready",
    "checks": {
      "database": "connected",
      "storage": "ready"
    },
    "timestamp": "2026-10-14T10:00:00.000Z"
  }
  ```
- **Security Invariant:** Zero credentials, database hostnames, or connection strings are returned in readiness responses.

---

## 3. Database & Migration Operational Policy

CrashLab adheres to strict database operational safety invariants:

1. **No Migrations on Request:** Database migrations are **never** executed automatically during web requests or standard server boot.
2. **Explicit Migration Tooling:** Migrations must be executed via explicit deployment lifecycle hooks or administrator commands:
   ```bash
   # Production migration execution
   npm run db:migrate
   ```
3. **Migration Failure Handling:** If a migration fails, the deployment pipeline must halt immediately. The application must not serve traffic against an un-migrated schema.
4. **Existing Applied Migrations:** Migrations `001_initial_schema.sql` and `002_run_queue.sql` remain immutable. No retro-active edits are permitted.
5. **Connection Pooling & Bounds:**
   - `DATABASE_POOL_MAX` is bounded (default: 10).
   - `DATABASE_CONNECT_TIMEOUT_MS` is bounded (default: 5000ms).
   - `DATABASE_SSL` is enforced for remote database connections.
   - Credentials in `DATABASE_URL` are redacted from logs and audit trails.

---

## 4. Artifact Storage Readiness

### Local Blob Store Boundary
- Local disk storage (`PRODUCT_BLOB_STORE=local`) is supported for local development and integration tests.
- In production mode, local disk storage is blocked by default to prevent silent ephemeral data loss in containerized environments.
- In a private beta single-node deployment, local storage can be explicitly allowed with:
  ```bash
  PRODUCT_BLOB_ALLOW_LOCAL_IN_PRODUCTION=true
  ```

### Supabase Storage (Build 12D.2A Production Provider)
- Implemented via `SupabaseBlobStore` (`src/product/blob/supabaseStore.ts`) connecting to Supabase Storage REST API (`/storage/v1`).
- Enforces private bucket access (`public: false`), SHA-256 integrity checksums, payload length verification, and bounded upload size (`PRODUCT_BLOB_MAX_BYTES`).
- Fail-closed operational validation via `npm run storage:check`.
- Safe provisioning via `npm run storage:setup -- --confirm`.
- See [SUPABASE_STORAGE_SETUP.md](file:///c:/Users/kxtri/Crash-labs/docs/product/SUPABASE_STORAGE_SETUP.md) for full operational manual.

### S3-Compatible Object Storage (Adapter Boundary)
- CrashLab includes an architectural adapter boundary for S3-compatible storage (`src/product/blob/s3Store.ts`).
- Designed provider-neutrally for future external object-storage migrations.

---

## 5. Worker Startup & Execution Policy

1. **Separation of Concerns:** The Product API web server processes API traffic and enqueues runs; it **does not** start a background worker loop unless explicitly commanded.
2. **Explicit Worker Command:** Workers must be run as separate processes or explicitly enabled services:
   ```bash
   npm run product:worker
   ```
3. **Safe Worker Identity:** Worker IDs must conform to `assertSafeWorkerId` (`[a-zA-Z0-9._-]+`) to prevent injection into database lease fields.
4. **Mandatory Preflight Gate:** Every claimed run is validated through the preflight safety gate before any browser process is spawned.
5. **Bounded Concurrency & Clean Shutdown:**
   - Worker concurrency is strictly bounded (`PRODUCT_WORKER_MAX_CONCURRENCY=1..10`).
   - Leases automatically time out to allow crash recovery (`PRODUCT_WORKER_LEASE_SECONDS`).
   - SIGINT/SIGTERM triggers graceful drain of active leases.

---

## 6. API Hardening & Security Controls

- **CORS Allowlist:** Origin headers are matched against `PRODUCT_CORS_ALLOWED_ORIGINS`. Wildcards (`*`) are disallowed in production.
- **Request Body Limits:** Inbound JSON request bodies are bounded to a maximum of 1MB (configurable via `PRODUCT_REQUEST_BODY_LIMIT_BYTES`). Payloads exceeding this limit receive HTTP 413 `PAYLOAD_TOO_LARGE`.
- **Error Message Sanitization:** Unhandled 500 exceptions in production mode return generic `"Internal server error"` messages, preventing stack trace or internal SQL leakage.
- **Request Tracing:** Every HTTP interaction is stamped with an immutable `X-Request-Id`.
- **Tenant Isolation:** All data access is parameterized and scoped by `workspaceId`.

---

## 7. Frontend Secret Audit

An audit of the dashboard frontend bundle confirms:
- **Zero Secrets Bundled:** Neither `DATABASE_URL`, `PRODUCT_AUTH_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, private JWT signing keys, nor local filesystem paths exist in the frontend distribution assets.
- **Public Variables Only:** Only public configuration (API base URL, Supabase public URL, anon public key if required) may be delivered to the client.
- **Token Handling:** Auth tokens are stored strictly in memory, never stored in `localStorage` or `sessionStorage` by default, never rendered in DOM nodes, and purged completely upon logout.
- **Content Security Policy:** Strict CSP headers prevent script injection, frame embedding, and untrusted cross-origin requests.

---

## 8. What Remains Before Public Launch

Before moving from private beta to general public availability, the following milestones remain:
1. **Independent Standalone Worker Deployment:** Deploying the worker fleet as dedicated container services separately from the Product API web server.
2. **Server-Sent Events (SSE):** Real-time run progress and queue monitoring via SSE.
3. **Self-Service User Provisioning:** Automated user onboarding and organization invitation workflows with Supabase Auth hooks.
4. **Production Rate Limiting:** Global and per-workspace token bucket rate limiting on public API endpoints.
5. **Automated Backup & Disaster Recovery:** Continuous database replication and artifact backup verification.
