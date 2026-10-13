# CrashLab Product API Contract

**Build 11: REST API Specification for Hosted MVP**

This document specifies the HTTP endpoints for CrashLab's hosted Product API.

---

## 1. Architectural Distinction: Product API vs Review API

CrashLab maintains a strict separation between two distinct HTTP services:

| Dimension | Review API (`src/reviewApi/`) | Product API (`src/product/api/`) |
| --- | --- | --- |
| **Build Milestone** | Build 9.1 | Build 11 |
| **Port** | `3210` | `3220` (or ephemeral) |
| **Mutability** | Strictly Read-Only | Read and Managed Writes |
| **Scope** | Single run candidate triage & inspection | Multi-tenant workspaces, projects, runs, and artifacts |
| **Authentication** | Local operator token | HMAC-SHA256 Bearer Token (`Authorization: Bearer <token>`) |

---

## 2. Global Headers & Conventions

### Request Headers
- `Content-Type: application/json`
- `Authorization: Bearer <token>`: Required in production mode (`PRODUCT_AUTH_MODE=production`).
- `X-User-Id: <user_id>`: Permitted only in explicit development mode (`PRODUCT_AUTH_MODE=development`). Untrusted and rejected in production.

### Response Headers
- `X-Request-Id: <req_...>`: Unique request correlation ID generated for every request.

### Response Format
All responses return standardized JSON with request correlation:

#### Success (200 OK, 201 Created)
```json
{
  "success": true,
  "data": { ... },
  "requestId": "req_0123456789abcdef"
}
```

#### Error (400, 401, 403, 404, 500)
```json
{
  "success": false,
  "error": {
    "code": "FORBIDDEN",
    "message": "Access denied: Actor is not a member of workspace ws_123.",
    "details": null
  },
  "requestId": "req_0123456789abcdef"
}
```

---

## 3. Endpoints

### 3.1 `GET /health`
System health check.
- **Auth:** None.
- **Response:**
  ```json
  {
    "status": "ok",
    "version": "0.1.0",
    "appEnvironment": "local",
    "mode": "hosted-mvp-foundation"
  }
  ```

### 3.2 `GET /api/v1/workspaces`
List workspaces accessible to the authenticated user.
- **Headers:** `X-User-Id: <usr_...>`
- **Response:** `200 OK`
  ```json
  {
    "success": true,
    "data": {
      "workspaces": [
        {
          "id": "ws_acme01",
          "schemaVersion": "1.0",
          "name": "Acme QA",
          "slug": "acme-qa",
          "ownerUserId": "usr_alice",
          "createdAt": "2026-10-12T00:00:00.000Z",
          "updatedAt": "2026-10-12T00:00:00.000Z"
        }
      ]
    }
  }
  ```

### 3.3 `POST /api/v1/workspaces`
Create a new workspace and establish caller as `owner`.
- **Headers:** `X-User-Id: <usr_...>`
- **Request Body:**
  ```json
  {
    "name": "Beta Testing Workspace",
    "slug": "beta-testing"
  }
  ```
- **Response:** `201 Created`

### 3.4 `GET /api/v1/projects?workspaceId=:workspaceId`
List projects within a workspace.
- **Query Params:** `workspaceId` (Required)
- **Response:** `200 OK`
  ```json
  {
    "success": true,
    "data": {
      "projects": [
        {
          "id": "prj_shop01",
          "schemaVersion": "1.0",
          "workspaceId": "ws_acme01",
          "name": "Storefront Web App",
          "description": "Public catalog and cart",
          "createdAt": "2026-10-12T00:00:00.000Z",
          "updatedAt": "2026-10-12T00:00:00.000Z"
        }
      ]
    }
  }
  ```

### 3.5 `POST /api/v1/projects`
Create a project within a workspace. Requires `owner` role.
- **Request Body:**
  ```json
  {
    "workspaceId": "ws_acme01",
    "name": "Storefront Web App",
    "description": "Public catalog and cart"
  }
  ```
- **Response:** `201 Created`

### 3.6 `GET /api/v1/projects/:projectId?workspaceId=:workspaceId`
Get single project details.
- **Response:** `200 OK`

### 3.7 `GET /api/v1/projects/:projectId/runs?workspaceId=:workspaceId`
List test runs for a project.
- **Response:** `200 OK`
  ```json
  {
    "success": true,
    "data": {
      "runs": [
        {
          "id": "run_001",
          "schemaVersion": "1.0",
          "workspaceId": "ws_acme01",
          "projectId": "prj_shop01",
          "targetEnvironmentId": "tgt_staging01",
          "journeyId": "jny_catalog01",
          "status": "completed",
          "safeTestMode": true,
          "preflightStatus": "ready",
          "createdAt": "2026-10-12T00:00:00.000Z",
          "updatedAt": "2026-10-12T00:00:00.000Z"
        }
      ]
    }
  }
  ```

### 3.8 `POST /api/v1/runs`
Create and enqueue a new test run for asynchronous worker execution.
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body:**
  ```json
  {
    "workspaceId": "ws_acme01",
    "projectId": "prj_shop01",
    "targetEnvironmentId": "tgt_staging01",
    "journeyId": "jny_catalog01",
    "maxAttempts": 2
  }
  ```
- **Response:** `201 Created`
  ```json
  {
    "success": true,
    "data": {
      "id": "run_001",
      "status": "queued",
      "attemptCount": 1,
      "maxAttempts": 2,
      "safeTestMode": true,
      "preflightStatus": "pending"
    },
    "requestId": "req_..."
  }
  ```

### 3.9 `GET /api/v1/runs/:runId?workspaceId=:workspaceId`
Get single run details and lifecycle status.
- **Response:** `200 OK`

### 3.10 `POST /api/v1/runs/:runId/cancel`
Idempotently cancels a queued or executing test run.
- **Request Body:**
  ```json
  {
    "workspaceId": "ws_acme01",
    "reason": "Operator cancelled test"
  }
  ```
- **Response:** `200 OK`

### 3.11 `POST /api/v1/runs/:runId/retry`
Explicitly retries a failed test run if attempts remain. Safety-blocked and completed runs cannot be retried.
- **Request Body:**
  ```json
  {
    "workspaceId": "ws_acme01"
  }
  ```
- **Response:** `200 OK`

### 3.12 `GET /api/v1/runs/:runId/queue?workspaceId=:workspaceId`
Retrieve queue lease and scheduling metadata for a run.
- **Response:** `200 OK`

### 3.13 `GET /api/v1/runs/:runId/artifacts?workspaceId=:workspaceId`
List evidence artifacts linked to a test run.
- **Response:** `200 OK`
  ```json
  {
    "success": true,
    "data": {
      "artifacts": [
        {
          "id": "art_exec01",
          "schemaVersion": "1.0",
          "workspaceId": "ws_acme01",
          "runId": "run_001",
          "type": "execution",
          "storagePath": "workspace/ws_acme01/project/prj_shop01/run/run_001/artifact/art_exec01",
          "byteSize": 14205,
          "sha256": "3a7b...",
          "contentType": "application/json",
          "createdAt": "2026-10-12T00:00:00.000Z"
        }
      ]
    },
    "requestId": "req_..."
  }
  ```

### 3.10 `POST /api/v1/runs/:runId/artifacts`
Upload and store a physical artifact blob and persist its database metadata record.
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Request Body:**
  ```json
  {
    "workspaceId": "ws_acme01",
    "type": "anomalies",
    "content": { "anomalyCount": 0 },
    "contentType": "application/json"
  }
  ```
- **Response:** `201 Created` with stored artifact metadata and blob info.

### 3.11 `GET /api/v1/artifacts/:artifactId?workspaceId=:workspaceId`
Retrieve metadata for a specific artifact.
- **Response:** `200 OK`

### 3.12 `GET /api/v1/artifacts/:artifactId/content?workspaceId=:workspaceId`
Download the raw artifact binary or text content.
- **Headers Returned:**
  - `Content-Type`: mime type of the artifact
  - `Content-Length`: payload size in bytes
  - `ETag`: `"<sha256>"`
  - `X-Artifact-Type`: artifact type
  - `X-Artifact-Sha256`: SHA-256 hash
  - `X-Request-Id`: request tracing ID
- **Response:** `200 OK` with raw body payload.

---

## 4. Build 12C.1 Dashboard Integration Endpoints

### 4.1 `GET /api/v1/me`
Retrieve currently authenticated user profile and identity.
- **Auth:** `Authorization: Bearer <token>`
- **Response:** `200 OK`
  ```json
  {
    "success": true,
    "data": {
      "user": {
        "id": "usr_alice",
        "email": "alice@portal.test",
        "name": "Alice Operator"
      }
    },
    "requestId": "req_..."
  }
  ```

### 4.2 `GET /api/v1/workspaces/:workspaceId`
Retrieve metadata for an authorized workspace.
- **Response:** `200 OK`

### 4.3 `GET /api/v1/targets?workspaceId=:workspaceId` & `GET /api/v1/projects/:projectId/targets?workspaceId=:workspaceId`
List target environments configured for the workspace or project.
- **Response:** `200 OK`

### 4.4 `GET /api/v1/journeys?workspaceId=:workspaceId` & `GET /api/v1/targets/:targetId/journeys?workspaceId=:workspaceId`
List approved preflight-gated journeys.
- **Response:** `200 OK`

### 4.5 `GET /api/v1/runs/:runId/candidates?workspaceId=:workspaceId` & `GET /api/v1/projects/:projectId/candidates?workspaceId=:workspaceId`
List candidate defect leads associated with a run or project.
- **Invariant:** All records returned have `confirmedBug: false` and are candidate signals for human review.
- **Response:** `200 OK`
