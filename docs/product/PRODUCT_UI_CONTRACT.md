# CrashLab Product Dashboard UI Contract

**Build 12C.1: Authenticated Product Dashboard Implementation**

This document specifies the layout, components, and interaction contracts for the CrashLab Hosted SaaS Dashboard.

---

## 1. Architectural Role & Boundary

The **Product Dashboard** serves as the primary multi-tenant management interface for engineering teams, QA leads, and workspace owners.

### Relationship to the Review UI (Build 9.2):
- **Product Dashboard (`http://127.0.0.1:3221`):** Multi-project navigation, workspace management, target environment status, run lifecycle monitor, queue state, candidate findings, and artifact previews.
- **Review UI (`http://127.0.0.1:3211`):** Deep, focused candidate defect triage interface with 4-way visual separation and read-only event log inspection.
- The Product Dashboard displays candidate leads and links into review-state tooling while leaving the Review UI untouched.

---

## 2. Core Dashboard Layout & Navigation

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ [CrashLab Logo]   Workspace: [ Acme QA ▾ ]            User: Alice (Owner)│
├───────────────┬──────────────────────────────────────────────────────────┤
│ Navigation    │ Project Overview: Storefront Web App                     │
│               ├──────────────────────────────────────────────────────────┤
│ 📊 Overview   │ Targets: 2 Active (staging, local)                       │
│ 📁 Projects   │ Approved Journeys: 3 Approved                            │
│ 🛡️ Security   │ Safe-Test Mode: ACTIVE (Permanent)                       │
│               ├──────────────────────────────────────────────────────────┤
│               │ Recent Test Runs                                         │
│               │ ┌───────┬────────────┬─────────────┬──────────┬────────┐ │
│               │ │ Run ID│ Target     │ Status      │ Findings │ Action │ │
│               │ ├───────┼────────────┼─────────────┼──────────┼────────┤ │
│               │ │ #1042 │ Staging    │ Completed   │ 0 Cand   │ View   │ │
│               │ │ #1041 │ Staging    │ Partial     │ 0 Cand   │ View   │ │
│               │ │ #1040 │ Staging-500│ Completed   │ 2 Cand   │ Review │ │
│               │ └───────┴────────────┴─────────────┴──────────┴────────┘ │
└───────────────┴──────────────────────────────────────────────────────────┘
```

---

## 3. Component Contracts

### 3.1 Local Development Authentication Screen
- In-memory token management with zero filesystem persistence by default.
- Prominently labeled: *"Local development authentication — not production login."*
- Safe 401 handling on token expiration or invalid signatures.
- Logout cleanly purges in-memory token, user profile, and active workspace state.

### 3.2 Workspace Selector
- Displays current active workspace name and slug.
- Dropdown allows switching between workspaces where the user holds authorized membership (`GET /api/v1/workspaces`).
- Workspace context is passed to all sub-resource API queries (`?workspaceId=...`).

### 3.3 Project List & Detail View
- **List View:** Displays all projects in the selected workspace with target counts and recent run activity.
- **Detail View:**
  - Configured target environments list (origin, environment type, authorization reference status).
  - Recent test runs list with status pills, attempt counts, and deep navigation.

### 3.4 Test Run Monitor & Queue Status
- Real-time run status indicators following the lifecycle state machine:
  - `created` (Neutral outline)
  - `preflight` (Yellow pulsing)
  - `queued` (Purple badge)
  - `running` (Blue pulsing)
  - `completed` (Green solid)
  - `partial` (Orange solid with tooltip: *"Absence of signals is not evidence of health"*)
  - `failed` (Red solid)
  - `blocked` (Red striped with tooltip: *"Preflight safety checks blocked execution"*)
  - `cancelled` (Gray badge)
- Worker lease owner and queue lease status indicators.
- Attempt counter tracking (`attempts / maxAttempts`).

### 3.5 Bounded Run Polling
- Base polling interval: 2.5 seconds.
- Exponential backoff on temporary network failures up to 10 seconds.
- Terminal state detection stops polling automatically upon entering terminal status (`completed`, `partial`, `failed`, `blocked`, `cancelled`).
- Page visibility aware: pauses polling when the browser tab is hidden.
- Timer cleanup: timers are destroyed on route navigation or component unmount.

### 3.6 Candidate Findings & Trust Invariant
- Candidate findings table displaying candidate ID, rule ID, classification, reproduction signal, and human review status.
- Mandatory Trust Invariant banner:
  > **Trust Invariant:** Candidate finding — not a confirmed defect. `confirmedBug: false` • `confirmed: false`. Automated findings are investigation leads, not confirmed application defects. Human acceptance is not automated confirmation.
- Review state display is read-only; mutation CLI instructions (`npm run review-state`) are clearly provided.
- Permitted review statuses: `open`, `investigating`, `accepted`, `dismissed`, `duplicate`, `resolved`, `unreviewed`. Legacy or candidate status named `confirmed` is never displayed and automatically mapped to `accepted`.

### 3.7 Evidence Artifact Viewer
- Renders artifact metadata without exposing server filesystem paths or cloud storage buckets.
- Safe authenticated in-browser preview for JSON reports, text logs, and screenshots.
- Direct authenticated download button with sanitized filenames.
- Strict Content Security Policy blocks arbitrary script execution.

### 3.8 Safe Actions: Run Cancellation
- Cancel button is displayed only for active runs (`queued`, `preflight`, `running`, `cancelling`).
- Requires explicit user confirmation in a dedicated modal.
- Sends idempotent POST request to `/api/v1/runs/:runId/cancel`.
- Terminal runs (`completed`, `partial`, `failed`, `blocked`, `cancelled`) immediately hide cancellation triggers.
- Cancellation preserves all captured evidence and never deletes artifacts.

### 3.9 Approved Journey Execution Modal (Build 12C.2)
The dashboard provides a dedicated, preflight-gated dispatch modal (`#modal-run-execution`) accessible from the Approved Journeys card on any project page:
- **Display Elements:**
  - **"Approved journey" label:** Clearly demarcates that only pre-reviewed, non-arbitrary journeys can be executed.
  - **Target Environment:** Displays environment badge (e.g., `local`, `staging`).
  - **Target URL Origin Only:** Displays origin (e.g., `http://127.0.0.1:4100`) without raw query parameters, paths, or secrets.
  - **Journey Goal:** Human-readable intent of the journey.
  - **Safe-Test Mode:** Displays `Enabled (Mandatory)`. Safe-test mode cannot be disabled from the dashboard.
  - **Expected Actions:** Displays explicit approved actions (e.g., `click`, `type`).
  - **Prohibited Actions:** Prominently displays safety guards prohibiting payment, checkout, credential modification, and data deletion.
  - **Test Data Security:** Displays `Protected test data configured` or `Protected test data missing`. Never displays raw credential or test data values.
  - **Expected Browser Activity:** Clarifies that an isolated headless Chromium browser will be spawned asynchronously via the PostgreSQL worker queue.
  - **Artifact Behavior:** Explains that trace, screenshot, and log evidence will be captured and stored with tenant isolation.
  - **Preflight Refusal Banner:** If the server preflight gate rejects the dispatch, renders `.preflight-error-banner` displaying the exact blocked reasons, confirming zero browsers launched and zero target network requests made.
  - **Confirmation Checkbox:** User must explicitly check: *"I explicitly confirm dispatching this approved journey against the designated non-production target origin under safe-test constraints."*
  - **Buttons:**
    - "Cancel" button: Discards modal state.
    - "Run journey" button: Disabled until confirmation checkbox is checked. Submits `{ workspaceId, projectId, targetEnvironmentId, journeyId }` to `POST /api/v1/runs` and redirects to the live run monitor upon success.
- **Strict Browser Boundary:**
  - The browser dashboard NEVER launches Playwright or Chromium directly.
  - The dashboard UI NEVER accepts or forwards raw target URLs, action lists, locators, passwords, payment details, or safe-test bypasses.

---

## 4. Security & Trust Invariants

1. **Read-Only / Managed Action Default:** Browser dashboard interactions reference trusted entity IDs only.
2. **Zero In-Browser Execution:** The UI never launches a browser process directly; runs are evaluated and queued via the backend worker queue.
3. **Zero Secret Display:** Target credentials, tokens, and cookies are never rendered in DOM elements or network payloads.
4. **Tenant Isolation:** All operations enforce workspace membership checks at the Product API layer.
5. **No "Confirmed Bug":** The dashboard NEVER renders "confirmed bug", `confirmedBug: true`, or `confirmed: true`.
6. **Human Acceptance:** "Accepted" means a human operator accepted the candidate for triage tracking; it is not automated confirmation.
