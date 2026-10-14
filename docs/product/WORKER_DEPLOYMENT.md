# CrashLab Worker Service Deployment & Hardening Operations Manual

**Build 12D.2B: Independently Deployable CrashLab Worker Service**

This document specifies the operational architecture, container packaging, lifecycle behavior, and safety invariants for deploying the CrashLab Worker Service as an independent, standalone service separate from the Product API web server.

---

## 1. Architectural Separation: Web Server vs Worker Fleet

CrashLab strictly enforces process-level decoupling between the web server and the execution worker fleet:

| Dimension | Product API Web Server (`src/product/api/`) | Worker Service (`src/product/worker/`) |
| :--- | :--- | :--- |
| **Process Role** | Stateless REST API & Dashboard Gateway | Asynchronous Execution Engine |
| **Network Exposure** | Public or VPC Ingress (Port 3220) | Internal / Non-Public (Health Port 3230) |
| **Browser Execution** | **NEVER launches browsers** | Launches headless Chromium for approved runs |
| **Worker Auto-Start**| **NEVER starts workers** | Explicitly starts background loop or `--once` |
| **Scaling Model** | Scale horizontally on HTTP request traffic | Scale horizontally on PostgreSQL queue depth |
| **Database Access** | CRUD operations & atomic queue enqueuing | `FOR UPDATE SKIP LOCKED` atomic run claiming & leases |

---

## 2. Server-Only Configuration

The worker service reads configuration from process environment variables:

```ini
# Enable worker execution (REQUIRED; default: false fails closed)
PRODUCT_WORKER_ENABLED=true

# Unique safe worker identity (alphanumeric, dash, dot, underscore only)
PRODUCT_WORKER_ID=worker-prod-01

# Queue polling interval in milliseconds (min: 100, max: 60000, default: 1000)
PRODUCT_WORKER_POLL_MS=1000

# Worker lease duration in seconds (min: 5, max: 600, default: 60)
PRODUCT_WORKER_LEASE_SECONDS=60

# Max concurrent jobs per worker process (bounded 1..10, default: 1)
PRODUCT_WORKER_MAX_CONCURRENCY=1

# Shutdown timeout in milliseconds (min: 1000, max: 120000, default: 30000)
PRODUCT_WORKER_SHUTDOWN_TIMEOUT_MS=30000

# Internal health check port (default: 3230)
PRODUCT_WORKER_HEALTH_PORT=3230

# Production environment modes
PRODUCT_AUTH_MODE=production
PRODUCT_STORAGE=postgres
PRODUCT_BLOB_STORE=supabase

# PostgreSQL Database Connection
DATABASE_URL=postgresql://user:password@host:5432/crashlab

# Supabase Storage Configuration (Required when PRODUCT_BLOB_STORE=supabase)
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_STORAGE_BUCKET=crashlab-artifacts
SUPABASE_SERVICE_ROLE_KEY=eyJh...<server-only-secret>
```

### Safety and Fail-Closed Invariants:
1. **Disabled by Default:** If `PRODUCT_WORKER_ENABLED` is false or omitted, the worker refuses to process jobs and exits with code `1`.
2. **Sanitized Worker ID:** Validated against `/^[a-zA-Z0-9_\-\.]+$/`. Prevents SQL injection or log manipulation.
3. **Bounded Timing:** Polling, lease renewal, and concurrency values are strictly clamped and validated.
4. **No Secrets in Logs:** Database passwords, service-role keys, tokens, and cookies are never printed in logs or health endpoints.

---

## 3. Worker Startup Modes

### 3.1 Normal Daemon Mode
Runs continuous queue polling until interrupted by `SIGINT` or `SIGTERM`:
```bash
npm run worker
# or directly:
node dist/src/product/worker/main.js
```

### 3.2 Single Execution Mode (`--once`)
Claims and executes at most one queued run, flushes artifacts, cleans up all database/browser connections, and exits:
```bash
npm run worker -- --once
```

### 3.3 Custom Health Port & Concurrency
```bash
npm run worker -- --health-port 3230 --concurrency 2 --poll-ms 500
```

---

## 4. Mandatory Preflight Safety Gate

Before any browser process is launched or any network request is issued:
1. The worker loads the target environment and approved journey records.
2. Evaluates `validateProductTargetPreflight(target, [journey])`.
3. Checks:
   - Target is not production-like (`production`, `prod`, `live`).
   - Target origin matches allowed origins.
   - Forbidden actions (payment, checkout, etc.) are absent.
   - Protected safe test data references are valid.
   - Safe test mode is enabled.
4. **If Preflight Fails:**
   - Launches **0 browser instances**.
   - Sends **0 network requests** to the target.
   - Transitions run to `blocked`.
   - Releases the worker lease.
   - Records an immutable `run.preflight_blocked` audit event.
   - Preserves `confirmed: false` and `confirmedBug: false`.

---

## 5. Browser Lifecycle & Resource Guarantees

1. **Fresh Context per Run:** Each claimed run opens a fresh, isolated browser context and page. Cookies, localStorage, and caches never persist across runs.
2. **Guaranteed Cleanup in `finally`:** The browser page, context, and browser instance are closed in a `finally` block even if the step times out or fails.
3. **Sensitive Data Omission:** Screenshots and trace recordings immediately omit sensitive values once test data enters the page.
4. **No Arbitrary Waits:** Actions use Playwright auto-waiting on resolved selectors.
5. **No Automatic Retries:** Step failures are recorded as evidence signals; failed actions are never automatically retried.

---

## 6. Lease Management & Crash Handling

- **Atomic Claiming:** Uses PostgreSQL transactions with `FOR UPDATE SKIP LOCKED`.
- **Heartbeat Renewals:** A periodic timer renews the lease at `leaseSeconds / 2`.
- **Lost Lease Handling:** If lease renewal fails, the worker aborts execution immediately and leaves the database record untouched, preventing split-brain state overwrites.
- **Worker Crash Recovery:** If a worker process abruptly dies, its lease will expire after `leaseSeconds`. Another healthy worker can safely reclaim the run.
- **Terminal State Protection:** Terminal states (`completed`, `failed`, `blocked`, `cancelled`) can never be overwritten.

---

## 7. Graceful Shutdown Behavior

When `SIGINT` or `SIGTERM` is received:
1. Worker loop stops accepting new jobs from the queue.
2. Internal health server stops accepting new connections.
3. In-flight jobs are allowed to complete up to `PRODUCT_WORKER_SHUTDOWN_TIMEOUT_MS` (default: 30s).
4. If jobs do not complete within the timeout, active execution abort signals are triggered.
5. Browser sessions, storage connections, and database pools are cleanly closed.
6. Process exits with code `0`.

---

## 8. Internal Health & Readiness Endpoints

The worker exposes two minimal, internal HTTP endpoints on port 3230:

### 8.1 Liveness Probe: `GET /health`
Returns process status, uptime, active job count, and configured concurrency:
```json
{
  "status": "ok",
  "workerId": "worker-prod-01",
  "uptimeSeconds": 142.5,
  "activeJobs": 0,
  "maxConcurrency": 1
}
```

### 8.2 Readiness Probe: `GET /readiness`
Performs active database queue and blob store connectivity checks:
```json
{
  "status": "ready",
  "workerId": "worker-prod-01",
  "activeJobs": 0,
  "maxConcurrency": 1,
  "checks": {
    "queue": "connected",
    "storage": "connected"
  }
}
```

Zero credentials, tokens, or database hostnames are exposed in health responses.

---

## 9. Container Packaging (`Dockerfile.worker`)

The worker service is packaged into a lightweight, non-root container image:
```bash
# Build worker image
docker build -f Dockerfile.worker -t crashlab-worker:latest .

# Run worker container
docker run -d \
  --name crashlab-worker \
  --env-file .env.production \
  -e PRODUCT_WORKER_ENABLED=true \
  crashlab-worker:latest
```

---

## 10. Operational Smoke Test: `npm run storage:smoke`

To verify real Supabase Storage upload, download, and deletion lifecycle:
```bash
npm run storage:smoke
```
This non-destructive test operates exclusively against a designated test locator (`ws_test_storage_smoke`), verifies SHA-256 integrity, deletes the test object immediately, and reports full cleanup verification.

---

## 11. Remaining Production Blockers

1. **Production Worker Deployment:** Deploying the containerized worker fleet to a private VPC / cluster (AWS ECS, Fly.io, or GCP Cloud Run).
2. **Rate Limiting:** Public API token bucket limits.
3. **Queue Telemetry & Streaming:** Real-time run queue progress via Server-Sent Events (SSE).
4. **Backup & Retention Policies:** Automatic archival for large Playwright traces.
