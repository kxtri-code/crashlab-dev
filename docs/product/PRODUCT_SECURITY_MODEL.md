# CrashLab Product Security Model

**Build 11: Multi-Tenant Isolation, RBAC, Secret Boundaries, and Safety Invariants**

This document details the security architecture, threat model, and defense-in-depth principles governing CrashLab's hosted platform.

---

## 1. Foundational Trust Invariants

CrashLab is built on non-negotiable trust invariants that no role, configuration, or API endpoint may bypass:

1. **`safeTestMode: true` is Permanent:**
   Safe-test mode is hardcoded into the runtime. Dangerous financial or checkout operations are permanently prohibited.
2. **`confirmed: false` and `confirmedBug: false` are Permanent:**
   Automated testing produces candidate hypotheses with complete provenance for human operator triage. An automated agent can never declare a production defect without human confirmation.
3. **Absence of Failure is Not Evidence of Health:**
   Runs with 0 passed steps or unverified assertions are classified as `partial` and strictly refused from normal baseline registration.
4. **Mandatory Preflight Safety Gate:**
   No browser worker may launch against an external host without preflight validation status `ready`.

---

## 2. Multi-Tenant Isolation Model

CrashLab enforces strict tenant boundaries at every layer of the architecture:

```text
Incoming HTTP Request
        │
        ▼
Resolve Actor Identity (User ID)
        │
        ▼
Query Workspace Membership (WorkspaceMember)
  ├── Not Found -> HTTP 403 Forbidden
  └── Found -> Verify Role Permissions
        │
        ▼
Repository Data Query
  └── Must specify `workspaceId` parameter
        │
        ▼
Return Tenant-Scoped Entity
```

### 2.1 Repository-Level Isolation
- Every query method that reads customer-owned entities (`projects`, `targets`, `journeys`, `runs`, `artifacts`, `candidates`, `audits`) requires an explicit `workspaceId` parameter.
- Cross-tenant queries are structurally prevented: searching for an entity belonging to Workspace B with a Workspace A token returns `null` or `404 Not Found`.

---

## 3. Role-Based Access Control (RBAC)

CrashLab defines four distinct workspace roles:

| Capability | `owner` | `member` | `reviewer` | `viewer` |
| --- | :---: | :---: | :---: | :---: |
| Manage Workspace Settings | **Yes** | No | No | No |
| Manage Workspace Members | **Yes** | No | No | No |
| Create / Edit Projects | **Yes** | No | No | No |
| Configure Target Environments | **Yes** | No | No | No |
| Approve User Journeys | **Yes** | No | No | No |
| Trigger Test Runs | **Yes** | **Yes** | No | No |
| View Reports & Artifacts | **Yes** | **Yes** | **Yes** | **Yes** |
| Update Human Candidate Triage | **Yes** | No | **Yes** | No |

### 3.1 Pure Authorization Functions
Authorization decisions are evaluated by pure, deterministic functions (`src/product/auth/permissions.ts`):
- `canReadWorkspace(membership, workspaceId)`
- `canManageWorkspace(membership, workspaceId)`
- `canManageMembers(membership, workspaceId)`
- `canManageProject(membership, project)`
- `canConfigureTargets(membership, target)`
- `canApproveJourneys(membership, entity)`
- `canRunProject(membership, project)`
- `canViewReports(membership, entity)`
- `canReviewCandidate(membership, candidate)`

---

## 4. Secret Boundary and Sanitization

### 4.1 Distinction of Terms
- **Safe Metadata:** Non-sensitive operational data stored in database records (e.g. `targetUrl`, `allowedOrigins`, `appBuildId`).
- **Secret Reference:** An opaque pointer to a secured key (e.g. `vault:testdata:qa-cart`, `AUTHORIZATION_REFERENCE`).
- **Secret Value:** The raw sensitive credential or token. **Never stored in CrashLab database records, logs, or API payloads.**

### 4.2 Prohibited Fields
The following keys are strictly forbidden in product entities and audit metadata:
`password`, `passwd`, `token`, `bearer`, `apikey`, `api_key`, `cookie`, `private_key`, `access_token`.

Automated sanitizers (`src/product/secrets/sanitizer.ts`) scan all entity creations and audit payloads, rejecting any record containing prohibited secret keys.

---

## 5. Audit Trail & Compliance

Every state change or administrative action generates an immutable `AuditEvent`:
- Event Types: `workspace.created`, `workspace.member_added`, `project.created`, `target.configured`, `journey.approved`, `run.requested`, `run.preflight_passed`, `run.preflight_blocked`, `run.started`, `run.completed`, `run.transitioned`, `candidate.reviewed`.
- Audit records include: `id`, `workspaceId`, `actorUserId`, `eventType`, `entityType`, `entityId`, `metadata`, `timestamp`.
- Prohibitions: Raw request bodies, cookies, authentication tokens, and full page contents are excluded from audit metadata.
