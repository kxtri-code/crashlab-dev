# Render Private-Beta Deployment Operations Manual

**Build 12E: Production Hosting on Render with Supabase Database & Storage**

This document provides a comprehensive, step-by-step guide for deploying CrashLab to Render for a private-beta release. It details the setup of the **Product API & Dashboard Web Service**, the **Asynchronous Execution Worker Fleet**, database migrations, artifact storage, and operational procedures.

---

## 1. Architectural Overview & Hosting Boundaries

CrashLab's production deployment decouples the user-facing web tier from the Playwright browser execution fleet:

```
                          +--------------------------------------------------+
                          |                 Render Platform                  |
                          |                                                  |
                          |  +--------------------+   (Internal Heartbeat)   |
Internet / Beta Users --->|  |   crashlab-api     |                          |
   (HTTPS / Port 443)     |  |   (Web Service)    |                          |
                          |  |   Dockerfile.api   |                          |
                          |  +---------+----------+                          |
                          |            |                                     |
                          |            |                                     |
                          |  +---------v----------+                          |
                          |  |  crashlab-worker   |                          |
                          |  | (Background Worker)|                          |
                          |  | Dockerfile.worker  |                          |
                          |  +---------+----------+                          |
                          +------------|-------------------------------------+
                                       |
                +----------------------+----------------------+
                |                                             |
                v (Pooled PostgreSQL)                        v (HTTPS REST / Storage v1)
   +--------------------------+                  +--------------------------+
   |   Supabase PostgreSQL    |                  |  Supabase Private Bucket |
   |  (aws-0-*.supabase.com)  |                  |   (crashlab-artifacts)   |
   +--------------------------+                  +--------------------------+
```

### Component Roles & Resource Requirements

| Component | Render Service Type | Dockerfile | Memory / CPU Plan | Network Exposure |
| :--- | :--- | :--- | :--- | :--- |
| **Product API & Dashboard** | **Web Service** | `Dockerfile.api` | Free or Starter (512MB RAM, 0.5 CPU) | Public HTTPS (e.g. `crashlab-api.onrender.com`) |
| **Execution Worker** | **Background Worker** | `Dockerfile.worker` | **Starter or Standard** (1GB+ RAM, 1 CPU) | **Internal only (zero ingress)** |
| **Database** | External Managed | N/A | Existing Supabase PostgreSQL | Encrypted Pooler / Port 5432 |
| **Artifact Store** | External Managed | N/A | Supabase Private Storage Bucket | Server-authenticated HTTPS REST |

> [!WARNING]
> **Playwright/Chromium Resource Requirement:**
> Headless Chromium and Playwright tracing consume significant memory during page rendering and screenshot generation. The Background Worker **must not** be run on memory-constrained free containers (<512MB). A **Starter (1GB RAM)** or **Standard (2GB RAM)** instance is strongly recommended to prevent Out-Of-Memory (OOM) process termination (`exit code 137`).

---

## 2. Health Endpoint Architecture Decision (Option A vs. Option B)

### Honest Platform Constraint
Render Background Workers **cannot receive inbound HTTP requests**, either from public ingress or from internal services. Therefore:
- Specifying an external HTTP health check path (like `/health`) on a Render Background Worker is not supported by Render's platform.
- Falsely claiming that Render verifies worker health via HTTP requests would lead to operational confusion.

### The Trade-off & Chosen Solution
We evaluate the two candidate architectures:

* **Option A: Keep the Worker as a Render Background Worker (CHOSEN & RECOMMENDED)**
  - **Mechanisms:** Render natively monitors Background Workers by OS process lifecycle. If the Node.js process crashes, exits, or is terminated by OOM, Render automatically detects the non-zero exit code and restarts the container.
  - **Internal Probes:** The worker still runs an internal loopback health server on port 3230 (`localhost:3230/health`), used by container-level `HEALTHCHECK` instructions.
  - **Database Lease Safety:** If a worker dies, its PostgreSQL lease (`PRODUCT_WORKER_LEASE_SECONDS`) automatically expires after 60 seconds, allowing another worker or the restarted container to safely reclaim the run.
  - **Why Option A is Preferred:** It provides zero network attack surface (no open ports), adheres to the principle of least privilege, and aligns with CrashLab's queue-driven pull model.

* **Option B: Deploy the Worker as a Render Private Service**
  - **Mechanisms:** Render Private Services can listen on an internal port and allow HTTP health probes from within the Render private network.
  - **Trade-off:** Exposes an HTTP port on the internal network and incurs standard service charges identical to a web service without providing additional functionality, since the worker never accepts RPC commands from the API server.

**Conclusion:** CrashLab adopts **Option A**. Operational monitoring for workers relies on Render process supervision, structured application logs, and database run leases.

---

## 3. Step-by-Step Beginner Deployment Guide

### Step 1: Connect GitHub Repository to Render
1. Log in to the [Render Dashboard](https://dashboard.render.com).
2. Click **New +** and select **Blueprint** (or create individual services manually).
3. Connect your GitHub account and select the `CrashLab` repository.
4. If using Blueprint, Render automatically detects [`render.yaml`](file:///c:/Users/kxtri/Crash-labs/render.yaml).

---

### Step 2: Configure Supabase Database & Run Migrations
Before starting web or worker containers, the database schema must be initialized.

1. Ensure your Supabase project is active.
2. Note your connection pooling string from **Project Settings > Database > Connection String (NodeJS / Transaction Pooler)**.
3. Apply schema migrations manually from your administrative environment:
   ```bash
   node --env-file=.env --import tsx src/cli.ts db:migrate
   ```
4. Verify migration status:
   ```bash
   node --env-file=.env --import tsx src/cli.ts db:check
   ```
   > [!IMPORTANT]
   > CrashLab strictly enforces that **no database migrations run automatically during HTTP requests or web server boot**. Migrations are always an explicit administrative action.

---

### Step 3: Configure Supabase Storage Bucket
1. Verify the private artifact bucket exists:
   ```bash
   node --env-file=.env --import tsx src/cli.ts storage:check
   ```
2. If the bucket does not exist, provision it with private security settings (`public: false`):
   ```bash
   node --env-file=.env --import tsx src/cli.ts storage:setup --confirm
   ```
3. Run the non-destructive storage smoke test to confirm end-to-end functionality:
   ```bash
   node --env-file=.env --import tsx src/cli.ts storage:smoke
   ```

---

### Step 4: Create the Product API Web Service (`crashlab-api`)
If configuring manually without Blueprints:
1. In Render Dashboard, click **New + > Web Service**.
2. Select repository `CrashLab`.
3. Configure the service settings:
   - **Name:** `crashlab-api`
   - **Region:** Choose the region closest to your Supabase project (e.g., Oregon or Frankfurt).
   - **Branch:** `main`
   - **Runtime:** `Docker`
   - **Dockerfile Path:** `./Dockerfile.api`
   - **Instance Type:** Starter (or Free for initial testing)
   - **Health Check Path:** `/health`
4. Configure Environment Variables (see Section 4 for complete variable table).
5. Click **Create Web Service**.

---

### Step 5: Create the Execution Worker (`crashlab-worker`)
1. In Render Dashboard, click **New + > Background Worker**.
2. Select repository `CrashLab`.
3. Configure the worker settings:
   - **Name:** `crashlab-worker`
   - **Region:** Same region as `crashlab-api`.
   - **Branch:** `main`
   - **Runtime:** `Docker`
   - **Dockerfile Path:** `./Dockerfile.worker`
   - **Instance Type:** **Starter (1GB RAM) or Standard (2GB RAM)**
4. Configure Environment Variables:
   - Crucially set `PRODUCT_WORKER_ENABLED=true`.
5. Click **Create Background Worker**.

---

## 4. Environment Variables Reference

### 4.1 Product API Web Service (`crashlab-api`)

| Variable Name | Recommended Value | Description | Sensitivity |
| :--- | :--- | :--- | :--- |
| `NODE_ENV` | `production` | Enables production optimizations | Public |
| `HOST` | `0.0.0.0` | Binds to all network interfaces | Public |
| `PORT` | `10000` | Port assigned by Render (or default 3220) | Public |
| `PRODUCT_AUTH_MODE` | `production` | Enforces JWT token verification | Public |
| `PRODUCT_STORAGE` | `postgres` | Uses PostgreSQL for entities & queue | Public |
| `PRODUCT_BLOB_STORE` | `supabase` | Uses private Supabase Storage | Public |
| `PRODUCT_WORKER_ENABLED` | `false` | **MUST BE FALSE** on API service | Public |
| `SUPABASE_STORAGE_BUCKET`| `crashlab-artifacts` | Storage bucket name | Public |
| `SUPABASE_JWT_AUDIENCE` | `authenticated` | Expected audience claim in JWT | Public |
| `DATABASE_URL` | `postgresql://postgres.[ref]:[pass]@...` | PostgreSQL connection string | **SECRET (Never commit)** |
| `SUPABASE_URL` | `https://[ref].supabase.co` | Supabase project API URL | Configuration |
| `SUPABASE_SERVICE_ROLE_KEY` | `eyJh...` | Supabase service-role secret key | **SECRET (Never commit)** |
| `SUPABASE_JWT_ISSUER` | `https://[ref].supabase.co/auth/v1` | Supabase JWT issuer | Configuration |
| `SUPABASE_JWKS_URL` | `https://[ref].supabase.co/auth/v1/.well-known/jwks.json` | JWKS public key endpoint | Configuration |
| `PRODUCT_CORS_ALLOWED_ORIGINS` | `https://crashlab-api.onrender.com` | Allowed browser origins (no `*`) | Configuration |

### 4.2 Background Worker Fleet (`crashlab-worker`)

| Variable Name | Recommended Value | Description | Sensitivity |
| :--- | :--- | :--- | :--- |
| `NODE_ENV` | `production` | Production mode | Public |
| `PRODUCT_WORKER_ENABLED` | `true` | **MUST BE TRUE** to process runs | Public |
| `PRODUCT_WORKER_ID` | `worker-render-01` | Unique safe worker identifier | Public |
| `PRODUCT_WORKER_MAX_CONCURRENCY` | `1` | Max simultaneous browser runs | Public |
| `PRODUCT_WORKER_POLL_MS` | `1000` | Polling frequency in ms | Public |
| `PRODUCT_WORKER_LEASE_SECONDS` | `60` | Lease duration before timeout | Public |
| `PRODUCT_AUTH_MODE` | `production` | Production mode | Public |
| `PRODUCT_STORAGE` | `postgres` | PostgreSQL queue storage | Public |
| `PRODUCT_BLOB_STORE` | `supabase` | Supabase artifact storage | Public |
| `SUPABASE_STORAGE_BUCKET`| `crashlab-artifacts` | Bucket name | Public |
| `DATABASE_URL` | `postgresql://postgres.[ref]:[pass]@...` | PostgreSQL connection string | **SECRET (Never commit)** |
| `SUPABASE_URL` | `https://[ref].supabase.co` | Supabase project API URL | Configuration |
| `SUPABASE_SERVICE_ROLE_KEY` | `eyJh...` | Supabase service-role secret key | **SECRET (Never commit)** |

> [!CAUTION]
> **Zero-Commit Policy:**
> Secrets (`DATABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, private tokens) must **NEVER** be committed into git, written to `render.yaml`, or included in Dockerfile layers. Enter them directly into the Render Dashboard under **Environment**.

---

## 5. Verification & Health Probes

### 5.1 Preflight Deployment Check
Before deploying, execute the deployment configuration verification tool locally:
```bash
npm run deploy:check
```
Verify that all 11 configuration invariants pass with safe, masked status outputs.

### 5.2 API Liveness & Readiness Verification
Once `crashlab-api` is deployed:

1. **Liveness Probe (`GET /health`):**
   ```bash
   curl -i https://crashlab-api.onrender.com/health
   ```
   **Expected Response (HTTP 200 OK):**
   ```json
   {
     "status": "ok",
     "version": "0.1.0",
     "appEnvironment": "production",
     "mode": "hosted-beta",
     "requestId": "req_..."
   }
   ```

2. **Readiness Probe (`GET /readiness`):**
   ```bash
   curl -i https://crashlab-api.onrender.com/readiness
   ```
   **Expected Response (HTTP 200 OK):**
   ```json
   {
     "status": "ready",
     "database": "connected",
     "storage": "ready",
     "checks": {
       "database": "connected",
       "storage": "ready"
     },
     "requestId": "req_..."
   }
   ```
   If database connectivity or storage access fails, the readiness endpoint immediately returns **HTTP 503 Service Unavailable**.

### 5.3 Worker Liveness & Log Verification
Check the Render Background Worker logs in the Render Dashboard:
```text
[INFO] Worker starting with id="worker-render-01", concurrency=1, poll=1000ms
[INFO] Preflight validation passed for run run_...
[INFO] Claimed lease for run run_...
[INFO] Browser launched cleanly in headless mode.
[INFO] Execution completed. Artifacts stored to Supabase Storage.
```

---

## 6. Operational Procedures: Rollback & Shutdown

### Rollback Procedure
If a regression or configuration error occurs in a newly deployed container:
1. In the Render Dashboard, navigate to `crashlab-api` or `crashlab-worker`.
2. Click **Deploys** in the left sidebar.
3. Locate the previous known-good deployment.
4. Click the three dots (`...`) and select **Rollback to this deploy**.
5. Render immediately stops the failing container and launches the previous immutable image digest.

### Graceful Shutdown Procedure
Both the API and Worker containers implement standard `SIGTERM` / `SIGINT` signal trapping:
- **API Server:** Stops accepting new connections, allows in-flight HTTP requests to complete, releases PostgreSQL connection pools, and exits code `0`.
- **Worker Process:** Stops claiming new runs from the queue, waits for active Playwright runs to cleanly complete (up to `PRODUCT_WORKER_SHUTDOWN_TIMEOUT_MS = 30000ms`), closes browser contexts, releases database leases, and exits code `0`.
- **To Stop Services on Render:** In the Render Dashboard, select the service, click **Settings**, scroll to the bottom, and click **Suspend Service**.
