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
Authentication Middleware (Authorization: Bearer <token>)
  ├── Production: Valid HMAC-SHA256 Token Required (X-User-Id strictly rejected)
  └── Development: Token or X-User-Id accepted
        │
        ▼
IdentityContext { userId, authMethod, requestId }
        │
        ▼
Query Workspace Membership (WorkspaceMember)
  ├── Not Found -> HTTP 403 Forbidden (Logs workspace.access_denied audit event)
  └── Found -> Verify Role Permissions
        │
        ▼
Repository Data Query
  └── Must specify `workspaceId` parameter ($1 in parameterized SQL)
        │
        ▼
Return Tenant-Scoped Entity (with X-Request-Id)
```

### 2.1 Authentication Boundary (Build 12B.1)
- **Token Verification:** All requests to `/api/v1/*` in production mode require a valid, unexpired HMAC-SHA256 bearer token signed with `PRODUCT_AUTH_SECRET`.
- **Zero Client Spoofing:** Client-supplied `X-User-Id` headers are untrusted and rejected with HTTP 401 when `PRODUCT_AUTH_MODE=production`.
- **Timing-Safe Comparison:** Signatures are evaluated using timing-safe comparisons to eliminate side-channel timing leaks.
- **Request Tracing:** Every request receives a unique `requestId` (`req_...`) propagated in response headers (`X-Request-Id`).

### 2.2 Repository-Level Isolation
- Every query method that reads customer-owned entities (`projects`, `targets`, `journeys`, `runs`, `artifacts`, `candidates`, `audits`) requires an explicit `workspaceId` parameter.
- Cross-tenant queries are structurally prevented: searching for an entity belonging to Workspace B with a Workspace A token returns `null` or `404 Not Found`.

### 2.3 Physical Blob Storage Boundary (Build 12B.2A)
- **Path Traversal Protection:** All storage keys follow the deterministic format `workspace/<workspaceId>/project/<projectId>/run/<runId>/artifact/<artifactId>`. Slashes, `..`, null bytes, and non-alphanumeric special characters are rejected at the locator validation boundary.
- **Root Confinement:** All file access is bounded by `PRODUCT_BLOB_ROOT`. Prohibits symlinks pointing outside the storage root.
- **Zero Local Path Exposure:** Database records and API responses expose only relative storage keys (`storagePath`); absolute server filesystem paths are never leaked.
- **Cryptographic Immutability:** Artifacts calculate and verify SHA-256 hashes upon storage. Conflicting overwrites of existing artifacts are strictly prohibited.
- **Authorization Before Access:** Reading or downloading artifact binary payloads requires workspace membership and role authorization (`viewer`, `reviewer`, `member`, `owner`). Cross-workspace downloads return 403 Forbidden.

### 2.4 Asynchronous Run Queue Boundary (Build 12B.2B)
- **Atomic Concurrency Protection:** Worker run claiming utilizes PostgreSQL transactions and row locking (`FOR UPDATE SKIP LOCKED`). Two workers cannot claim the same run simultaneously.
- **Live Lease Integrity:** Runs under an unexpired lease cannot be stolen. Expired leases may be reclaimed safely by healthy workers.
- **Worker Identity Sanitization:** Worker IDs are validated against strict alphanumeric/dash/dot patterns (`assertSafeWorkerId`), preventing SQL injection, control characters, or credential leakage in lease fields.
- **Mandatory Preflight Gate Enforcement:** Workers execute `validateProductTargetPreflight` before launching any browser or contacting any target. Blocked preflight runs launch 0 browsers and make 0 target requests.
- **Bounded Retries:** Automatic retries are permanently disabled. Manual retries must be explicitly requested, increment `attemptCount`, and remain strictly bounded by `maxAttempts`.

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

---

## 6. Dashboard Security Model (Build 12C.1)

### 6.1 Frontend Architectural Boundaries
- **Zero Direct Database / Supabase Access:** The dashboard browser application connects solely to the Product API through an authenticated loopback HTTP interface. Database credentials (`DATABASE_URL`), service keys, and internal secrets never exist in client code or browser memory.
- **Zero In-Browser Browser Launches:** The dashboard client cannot trigger headless browser execution directly on the client machine; all execution flows through the preflight-gated worker queue.

### 6.2 Token Security & Local Beta Authentication
- **In-Memory Token Storage:** Tokens are retained strictly in memory during an active session and cleared completely on logout.
- **Zero Token Leakage:** Bearer tokens are never rendered in HTML tags, never displayed in text elements, and never logged in console output.
- **Explicit Development Boundary:** The login screen clearly warns: *"Local development authentication — not production login."*

### 6.3 Browser Hardening & CSP
- Strict Content Security Policy:
  - `default-src 'self'`
  - `script-src 'self'`
  - `style-src 'self' 'unsafe-inline'`
  - `img-src 'self' data: blob:`
  - `connect-src 'self' http://127.0.0.1:* http://localhost:* ws:`
  - `object-src 'none'`
  - `frame-src 'none'`
  - `base-uri 'self'`
- Anti-sniffing (`X-Content-Type-Options: nosniff`) and no-cache policies (`Cache-Control: no-store`) enforced on all responses.
- Path traversal protection on all static and reverse-proxy routes.

### 6.4 Artifact Access Controls
- Artifact files (screenshots, traces, logs) require authenticated API requests with verified workspace membership.
- Server filesystem storage paths (`storagePath`) are redacted or sanitized; no physical operating system paths are exposed to the client.
- Downloaded artifacts cannot execute inside the application origin.

---

## 7. Preflight-Gated Run Dispatch & Journey Immutability (Build 12C.2)

### 7.1 Immutability of Approved Journeys
CrashLab strictly forbids dashboard users from modifying or injecting journey actions, steps, selectors, locators, target URLs, or credentials during run dispatch:
1. **IDs-Only Contract:** The dispatch endpoint (`POST /api/v1/runs`) accepts references to trusted, pre-approved entity IDs only (`workspaceId`, `projectId`, `targetEnvironmentId`, `journeyId`).
2. **Rejection of Client Overrides:** Any request payload containing `targetUrl`, `actions`, `steps`, `locators`, `credentials`, `password`, `payment`, `safeTestMode`, or `authorizationReference` is immediately rejected with HTTP `400 BAD_REQUEST`.
3. **No Arbitrary Script Injection:** Test journeys must pass formal human QA review (`approveJourney`) before they can ever be dispatched. An operator cannot use the dashboard to craft arbitrary web requests or bypass origin boundaries.

### 7.2 Preflight Safety Gate Boundary
Before any run is created in storage or committed to the PostgreSQL queue, the server runs the proven Build 10.2 safety preflight gate:
- **Refusal Conditions:**
  - Production-like environment keywords (`production`, `prod`, `live`)
  - Target URL missing or invalid scheme
  - Non-local host in local environment or HTTP protocol in staging
  - Origin outside the target's explicit `allowedOrigins` whitelist
  - Forbidden actions (payment, checkout, balance adjustments, password resets, account deletion)
  - Missing safe test data reference when credentials/test data are required
  - Disabled safe-test mode
  - Malformed or schema-invalid journey definitions
  - Target/project or journey/target ownership mismatches
- **Preflight Refusal Semantics:**
  - Refused requests return HTTP `422 Unprocessable Entity` with error code `PREFLIGHT_BLOCKED`.
  - Zero run records and zero queue items are committed to PostgreSQL.
  - Exactly **zero browser instances** are launched.
  - Exactly **zero network requests** are sent to the target environment.
  - The security audit log records an immutable `run.preflight_blocked` event with failure reasons.

### 7.3 Candidate Findings & Trust Invariants
- **Non-Negotiable Invariants:** `confirmed: false` and `confirmedBug: false` remain permanent across all dashboard screens, database tables, and API contracts.
- **Human Acceptance vs Bug Confirmation:** The candidate status `accepted` means an authorized engineer has acknowledged the candidate lead for tracking or triage. It does **not** mean the bug is automatically confirmed. The dashboard strictly prohibits displaying or using `confirmed` as a defect status.
