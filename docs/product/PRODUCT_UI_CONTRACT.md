# CrashLab Product Dashboard UI Contract

**Build 11: Product Dashboard Shell Specification**

This document specifies the layout, components, and interaction contracts for the future CrashLab Hosted SaaS Dashboard.

---

## 1. Architectural Role & Boundary

The **Product Dashboard** serves as the primary multi-tenant management interface for engineering teams, QA leads, and workspace owners.

### Relationship to the Review UI (Build 9.2):
- **Product Dashboard:** Multi-project navigation, workspace management, target environment status, run triggering, and aggregate metrics.
- **Review UI (`http://127.0.0.1:3211`):** Deep, focused candidate defect triage interface with 4-way visual separation and read-only event log inspection.
- The Product Dashboard links directly into the Review UI for individual run candidate inspections (`#/candidates/:candidateId`).

---

## 2. Core Dashboard Layout & Navigation

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ [CrashLab Logo]   Workspace: [ Acme QA ▾ ]            User: Alice (Owner)│
├───────────────┬──────────────────────────────────────────────────────────┤
│ Navigation    │ Project Overview: Storefront Web App                     │
│               ├──────────────────────────────────────────────────────────┤
│ 📁 Projects   │ Targets: 2 Active (staging, local)                       │
│ 🎯 Targets    │ Approved Journeys: 3 Approved                            │
│ 🚀 Test Runs  │ Safe-Test Mode: ACTIVE (Permanent)                       │
│ 🛡️ Audit Log  ├──────────────────────────────────────────────────────────┤
│ ⚙️ Settings   │ Recent Test Runs                                         │
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

### 3.1 Workspace Selector
- Displays current active workspace name and slug.
- Dropdown allows switching between workspaces where the user holds membership (`GET /api/v1/workspaces`).
- Includes `+ Create Workspace` action for authorized users.

### 3.2 Project List & Detail View
- **List View:** Displays all projects in the selected workspace with target counts and recent run activity.
- **Detail View:**
  - Target environments list (origin, environment type, authorization reference status).
  - Approved journeys with preflight readiness badges.
  - Quick action: `Run Approved Journey` (triggers preflight evaluation).

### 3.3 Test Run Monitor
- Real-time run status indicators following the lifecycle state machine:
  - `created` (Blue outline)
  - `preflight` (Yellow pulsing)
  - `queued` (Purple badge)
  - `running` (Blue pulsing)
  - `completed` (Green solid)
  - `partial` (Orange solid with tooltip: *"Absence of signals is not evidence of health"*)
  - `failed` (Red solid)
  - `blocked` (Red striped with tooltip: *"Preflight safety checks blocked execution"*)
  - `cancelled` (Gray badge)

### 3.4 Candidate Review Linkage
- For any run with identified candidate defects, displays candidate badge (e.g. `2 Candidates`).
- Clicking `Review Findings` deep-links directly into the Review UI for triage.
- Invariant banner prominently displayed:
  > **Invariant:** `confirmedBug: false` — Automated findings are leads for engineering review, not confirmed application bugs.

---

## 4. Security & Browser Constraints

1. **Read-Only Default:** All browser dashboard interactions are strictly read-only by default.
2. **Zero In-Browser Execution:** The UI never launches a local browser directly; runs are evaluated and queued via the backend API.
3. **Zero Secret Display:** Target credentials, tokens, and cookies are never rendered in DOM elements or network payloads.
