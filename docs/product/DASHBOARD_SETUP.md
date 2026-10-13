# CrashLab Authenticated Product Dashboard Setup Guide

**Build 12C.1: Product Dashboard Architecture & Setup**

---

## 1. Overview & Architecture

The **CrashLab Authenticated Product Dashboard** provides an interactive web interface for engineering teams and QA operators to view their workspaces, projects, target environments, approved journeys, asynchronous runs, queue leases, candidate findings, and run artifacts.

```
┌─────────────────────────────────────────────────────────────┐
│             Web Browser (Local Loopback)                    │
│   • Single-page dashboard client (port 3221)                │
│   • In-memory bearer token state (never stored to disk)     │
│   • Reverse proxy for /api/* to avoid CORS                  │
└──────────────────────────────┬──────────────────────────────┘
                               │ HTTP /api/v1/* (Bearer Token)
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                 Product API (port 3220)                     │
│   • HMAC-SHA256 Bearer Token authentication                 │
│   • Strict tenant isolation (workspace membership checks)   │
│   • Safe error formatting (no raw DB paths or credentials)  │
│   • Correlation request IDs (X-Request-Id)                  │
└──────────────┬──────────────────────────────┬───────────────┘
               │                              │
               ▼                              ▼
┌──────────────────────────────┐ ┌────────────────────────────┐
│      PostgreSQL Database     │ │     BlobStore (Artifacts)  │
│   • Multi-tenant schema      │ │   • Local / S3-compatible  │
│   • Worker run queue         │ │   • Tenant-scoped paths    │
└──────────────────────────────┘ └────────────────────────────┘
```

### Critical Boundaries
- **Zero direct database access:** The frontend connects *strictly* through the Product API. No database credentials, connection strings, or service keys exist in client assets.
- **Zero in-browser target execution:** The dashboard never launches local browsers or interacts directly with target URLs.
- **Zero unauthenticated access:** All dashboard data requires an authenticated workspace member context.

---

## 2. Quickstart

### Step 1: Start the Product API
In your terminal, start the Product API server:
```bash
npm run api
# Or with explicit port/host:
node --env-file=.env --import tsx src/cli.ts api:serve --port 3220
```

### Step 2: Generate a Local Development Bearer Token
Create a signed development token for your user:
```bash
npm run auth:token -- --user usr_test_owner
```
Output:
```
Token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
Expires: 2026-10-14T00:00:00.000Z
```

> **Important:** This is local development authentication for private beta only — not a production identity provider (IdP). Never place tokens in source code or share them publicly.

### Step 3: Start the Product Dashboard
In a separate terminal, launch the dashboard static/proxy server:
```bash
npm run dashboard
# Or with custom options:
npm run dashboard -- --port 3221 --api-url http://127.0.0.1:3220
```

### Step 4: Access and Authenticate
1. Open your browser and navigate to: `http://127.0.0.1:3221/`
2. You will be greeted by the **Local Development Authentication** screen.
3. Verify the **API Server URL** (defaults to `http://127.0.0.1:3221` via loopback proxy or your direct API port).
4. Paste the generated bearer token into the token input.
5. Click **Connect & Authenticate**.
6. The dashboard will validate your token against `/api/v1/me`, load your authorized workspaces, and transition to the **Workspace Overview**.

---

## 3. What the Dashboard Can and Cannot Do

| Capability | Supported? | Details |
|---|---|---|
| **View Workspace Data** | Yes | Projects, targets, journeys, runs, candidates, and artifacts. |
| **Multi-Tenant Navigation** | Yes | Switch between authorized workspaces in the top navigation bar. |
| **Inspect Lifecycle & Queue** | Yes | View run states (`queued`, `preflight`, `running`, `completed`, etc.) and worker lease owners. |
| **Candidate Defect Triage** | Yes (Read-only) | View signal reproductions, classification, and rule IDs with permanent `confirmedBug: false` invariant. |
| **Artifact Previews & Downloads** | Yes | Authenticated previews of JSON reports, logs, and screenshots without exposing server filesystem paths. |
| **Safe Run Cancellation** | Yes | Idempotently cancel queued or running runs with explicit operator confirmation. |
| **Direct Supabase / DB Access** | **No** | Forbidden by design. The browser communicates solely with the Product API. |
| **Arbitrary Target Execution** | **No** | Target execution runs only through the worker queue with preflight authorization. |
| **Public Signup / Passwords** | **No** | Out of scope for Build 12C.1. Authentication uses signed development tokens. |
| **Automatic Bug Confirmation** | **No** | Invariant: Automated findings are investigation leads; human engineering review is required. |

---

## 4. Tenant Isolation

The Product API is the sole authority for tenant isolation:
- Every data request requires an authenticated caller whose user ID is verified via the bearer token signature.
- Workspace membership is checked on every operation. If a user attempts to access a project, run, candidate, or artifact belonging to another workspace, the API returns `403 Forbidden` with a sanitized error message.
- The dashboard never trusts identifiers from the URL hash alone; every view re-queries the authenticated API client.
- Cross-tenant leakage is strictly prevented.

---

## 5. Safe Queue Polling Design

For active runs (`queued`, `preflight`, `running`), the dashboard uses a bounded polling manager:
- **Bounded interval:** Polls run and queue status at 2.5s base intervals.
- **Exponential backoff:** Temporary API failures trigger exponential backoff up to 10s.
- **Terminal state cutoff:** Polling immediately stops when the run enters a terminal status (`completed`, `partial`, `failed`, `blocked`, `cancelled`).
- **Page visibility awareness:** When the browser tab is hidden, polling pauses (or slows down) to prevent background resource waste.
- **Timer cleanup:** Timers are cleanly cleared whenever the operator navigates away from the run detail page or logs out.
- **Concurrency control:** Overlapping polling requests are prevented by an `isPolling` lock.

---

## 6. Artifact Protection

Evidence artifacts (execution logs, Playwright traces, network HAR files, screenshots) are protected by strict access controls:
- **Authenticated streaming:** All artifact previews and downloads require `Authorization: Bearer <token>`.
- **Zero filesystem disclosure:** Physical storage paths (e.g. `C:\Users\...` or `/tmp/...`) are never sent in API metadata or DOM elements.
- **Content-Type validation:** JSON payloads and text logs are rendered safely as escaped text. Screenshots are previewed via secure object URLs.
- **Executable script blocking:** Scripts or HTML artifacts are never executed within the dashboard origin.

---

## 7. Candidate Defect Trust Invariant

In accordance with CrashLab's core trust invariants:
- **`confirmedBug: false`** is permanently enforced and visibly displayed across all candidate finding panels.
- Automated tests produce **candidate findings** — reproducible signals indicating an unexpected response or error.
- Findings are leads for engineer triage. They are never classified or reported as confirmed application defects without human verification.
- Review state changes (`investigating`, `confirmed`, `dismissed`) must be performed through verified CLI or authorized mutation workflows.
