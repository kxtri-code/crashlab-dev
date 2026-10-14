# CrashLab Asynchronous Run Queue & Worker Dispatcher

**Build 12B.2B: PostgreSQL-Backed Asynchronous Execution Pipeline**

This document details the architecture, state machine, claiming protocols, preflight safety gates, and failure recovery rules for CrashLab's asynchronous worker queue.

---

## 1. Architectural Overview

The Run Queue decouples user-facing API run requests from browser execution workloads. It provides safe concurrency management, atomic lease claiming, heartbeats, tenant isolation, and strict preflight gating.

```text
API Request (POST /api/v1/runs)
       │
       ▼
Synchronous Safety Preflight Gate
  ├── BLOCKED: HTTP 422 PREFLIGHT_BLOCKED returned immediately.
  │            Audit event logged (run.preflight_blocked).
  │            Zero DB rows created (no test_run, no queue item).
  │            Zero browsers launched, zero target requests.
  │
  └── READY: Proceed to persistence.
       │
       ▼
ProductService.enqueueRun()
  ├── TestRun persisted (status: 'queued')
  └── RunQueueItem persisted (queue_status: 'queued', available_at: NOW)
       │
       ▼
Worker Claiming (SELECT ... FOR UPDATE SKIP LOCKED)
  ├── Atomic claim & lease allocation
  └── Transition: queued -> preflight (leaseOwner: worker-id, leaseExpiry: NOW + 60s)
       │
       ▼
Secondary Preflight Verification (Defense in Depth)
  ├── BLOCKED: Zero browsers launched, zero target requests.
  │            Run status -> 'blocked'. Lease released.
  │
  └── READY: Transition: preflight -> running.
       │
       ▼
Injectable Worker Execution Boundary (ExecutionWorker)
  ├── Heartbeat renewal timer active (renews lease every leaseSeconds / 2)
  ├── Cancellation AbortSignal monitoring
  ├── Invariant preservation: confirmedBug: false, safeTestMode: true
  └── Artifact storage via BlobStore
       │
       ▼
Final Lifecycle Transition: completed / failed / cancelled
       │
       ▼
Lease Released (leaseOwner: null, leaseExpiry: null)
```

---

## 2. Queue State Machine & Lifecycle Transitions

The queue coordinates with the product `TestRun` lifecycle state machine. Terminal states are strictly immutable.

### 2.1 States

| State | Category | Description |
| --- | --- | --- |
| `queued` | Active | Run is waiting to be claimed by an eligible worker. |
| `preflight` | Active | Run is claimed by a worker and undergoing preflight safety gate verification. |
| `running` | Active | Preflight passed; worker is actively executing the test journey. |
| `cancelling` | Active | Cancellation has been requested during active worker execution. |
| `completed` | Terminal | Journey executed to completion with evidence artifacts captured. |
| `partial` | Terminal | Journey executed with unverified assertions or skipped steps. |
| `failed` | Non-Terminal | Execution failed (e.g. browser crash, network error, or worker fault). |
| `blocked` | Terminal | Refused by the preflight safety gate. Zero browsers launched. |
| `cancelled` | Terminal | Run was cancelled prior to launch or aborted during execution. |

### 2.2 Allowed Transitions

- `queued → preflight`: Atomic worker claim.
- `preflight → running`: Preflight safety validation evaluated with status `ready`.
- `preflight → blocked`: Preflight safety validation refused (e.g., unauthorized host, production indicators, dangerous actions).
- `running → completed`: Worker finished execution with valid step evidence.
- `running → partial`: Worker finished with partial execution or skipped steps.
- `running → failed`: Worker encountered an unhandled execution error or step failure.
- `running → cancelling`: User or operator requested cancellation while active.
- `cancelling → cancelled`: Worker aborted active execution and released resources.
- `queued → cancelled`: User cancelled the run before any worker claimed it.
- `failed → queued`: **Only via explicit manual retry** (`retryRun`) where `attemptCount < maxAttempts`.

### 2.3 Terminal Immutability

The terminal states (`completed`, `partial`, `blocked`, `cancelled`) are permanently immutable. Terminal runs cannot be cancelled, re-executed, or re-queued automatically.

---

## 3. Claiming Protocol and Lease Handling

To prevent duplicate execution and race conditions across multiple workers, CrashLab implements row-level locking leases.

### 3.1 Atomic Claiming Query
Workers query the `run_queue` table using PostgreSQL parameterized queries and row-level locking:

```sql
SELECT * FROM run_queue
WHERE ((queue_status = 'queued' AND available_at <= $1)
   OR (queue_status IN ('preflight', 'running') AND lease_expiry < $1))
ORDER BY available_at ASC, created_at ASC
LIMIT 1
FOR UPDATE SKIP LOCKED;
```

Upon row selection, the worker immediately updates the record within the same transaction:
```sql
UPDATE run_queue
SET queue_status = 'preflight', lease_owner = $1, lease_expiry = $2, updated_at = $3
WHERE run_id = $4;
```

### 3.2 Lease Properties
- **Mutual Exclusion:** Two workers cannot claim the same run simultaneously (`SKIP LOCKED`).
- **Live Lease Protection:** A live lease (`lease_expiry >= NOW`) cannot be claimed or overwritten by another worker.
- **Automatic Recovery of Abandoned Leases:** If a worker crashes or becomes unresponsive, its lease will expire (`lease_expiry < NOW`). Another worker will automatically reclaim the job.
- **Heartbeat Lease Renewal:** During long executions, the active worker periodically renews its lease (`renewLease`) every `leaseSeconds / 2` seconds.
- **Lease Expiration Enforcement:** If a worker loses its lease (e.g. due to temporary network partition), it must abort updating the run to prevent split-brain state mutations.
- **Safe Worker Identifiers:** Worker IDs must match `^[a-zA-Z0-9_\-\.]+$` (1-128 characters) and contain zero control characters, whitespace, or SQL metacharacters.

---

## 4. Preflight Safety Gate Enforcement

The preflight safety gate (`src/product/service/preflightAdapter.ts`) is a strict prerequisite before any browser is launched or target request is dispatched.

The worker immediately **refuses execution** if:
1. Target is production or production-like (e.g. `production.example.com`).
2. Target environment is non-local staging without a valid `AUTHORIZATION_REFERENCE`.
3. Target URL origin is outside the target's configured `allowedOrigins`.
4. Journey contains forbidden dangerous actions (e.g., `payment`, `checkout`, `delete_account`, `truncate`).
5. Safe-test mode is missing or disabled (`safeTestMode !== true`).
6. Required test data file is missing.

### 4.1 Strict Blocked Preflight Guarantees
When a preflight gate fails:
- **Zero browsers launched:** Playwright browser instance is never created.
- **Zero target requests:** Target website is never contacted.
- **Safe failure storage:** Safe sanitized reason is persisted (e.g. `AUTHORIZATION_REFERENCE required for staging`).
- **No secret leakage:** Raw configuration secrets or credentials are never stored.
- **No client bypass:** Client flags cannot bypass preflight gate validation.

### 4.2 Preflight Timing: API Enqueue vs Worker Claim
CrashLab applies a two-tiered preflight safety gate strategy (defense-in-depth):

1. **Synchronous Dashboard API Dispatch (`POST /api/v1/runs`):**
   - Preflight gate runs **before** creating any `TestRun` or `RunQueueItem`.
   - If preflight fails, the server records an audit event (`run.preflight_blocked`), creates **no database records** (no queue row, no run row), and returns HTTP 422 `PREFLIGHT_BLOCKED` with structured `failureReasons`.
   - If preflight passes, the run is created in `queued` status and enqueued onto `run_queue`.
2. **Asynchronous Worker Re-verification (Defense in Depth):**
   - When a worker claims a `queued` run and transitions it to `preflight`, it re-executes the preflight safety gate against the current target and journey definitions.
   - If preflight is refused at this stage, the run transitions to `blocked` (terminal), the queue lease is released, and zero browser instances are created.

---

## 5. Retry and Cancellation Rules

### 5.1 Why Automatic Retries are Disabled
Automatic retries are **permanently disabled by default**. Flaky tests, network partitions, or backend errors must not trigger autonomous retries that could flood a customer's staging server or obscure genuine defect signals.

### 5.2 Explicit Manual Retries
Manual retries require an explicit authenticated API request (`POST /api/v1/runs/:runId/retry`) or service call (`service.retryRun()`):
- Only runs with status `failed` can be retried.
- `attemptCount` is incremented.
- `attemptCount` cannot exceed `maxAttempts` (default: 1).
- Original failure details are preserved in `lastError`.
- Safety-blocked runs (`blocked`) **cannot be retried**.
- Completed or cancelled runs cannot be retried.

### 5.3 Cancellation Guarantees
- Queued runs transition directly `queued → cancelled`.
- Running runs transition `running → cancelling → cancelled` via standard `AbortSignal` propagation.
- Cancellation is **idempotent**: cancelling an already cancelled run succeeds without error.
- Cancelling terminal runs (`completed`, `blocked`) fails safely.
- Cancellation **never deletes evidence**; artifacts recorded prior to cancellation remain intact.
- Cancellation **never marks a defect as confirmed** (`confirmedBug: false` invariant).

---

## 6. Injectable Worker Boundary

To keep queue orchestration completely decoupled from Playwright and browser execution, CrashLab defines the `ExecutionWorker` interface (`src/product/queue/worker.ts`):

```typescript
export interface ExecutionWorker {
  executeRun(input: ExecutionWorkerInput): Promise<ExecutionWorkerResult>;
  cancelRun(runId: string): Promise<void>;
  close(): Promise<void>;
}
```

- **Unit-Test Determinism:** `DeterministicMockWorker` launches zero browsers and makes zero network requests. It generates deterministic artifacts for unit and integration testing.
- **Production Boundary:** The production execution seam wraps the proven CrashLab scout/journey/executor pipeline while respecting the identical injectable interface.

---

## 7. Local Worker CLI & Configuration

### 7.1 Configuration via Environment

| Variable | Default | Description |
| --- | --- | --- |
| `PRODUCT_WORKER_ENABLED` | `false` | Whether worker loop starts automatically (disabled by default). |
| `PRODUCT_WORKER_ID` | `worker-<pid>` | Sanitized unique worker instance identifier. |
| `PRODUCT_WORKER_POLL_MS` | `1000` | Polling frequency in milliseconds (min: 100ms). |
| `PRODUCT_WORKER_LEASE_SECONDS` | `60` | Lease expiry duration in seconds (min: 5s). |
| `PRODUCT_WORKER_MAX_CONCURRENCY` | `1` | Maximum parallel jobs processed per worker instance (bounded). |

### 7.2 CLI Commands

Run worker in single-execution mode (claims at most one run and exits cleanly):
```bash
npm run worker -- --once
```

Run worker with custom polling interval and ID:
```bash
npm run worker -- --poll-ms 500 --worker-id worker-local-alpha
```

Display CLI help:
```bash
npm run worker -- --help
```

---

## 8. What is NOT Production-Ready Yet

This build establishes the foundational PostgreSQL-backed queue and dispatching mechanics. The following components are explicitly reserved for future builds:
- Redis or external queue broker integrations (SQS, RabbitMQ, Kafka).
- Docker or Kubernetes worker pod auto-scaling.
- Public web dashboard and streaming log UI.
- Billing, subscription, and usage quotas.
- Automatic bug confirmation (CrashLab invariants require human review).
