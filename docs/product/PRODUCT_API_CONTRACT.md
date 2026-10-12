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
| **Authentication** | Local operator token | Tenant-scoped User Identity (`X-User-Id`) |

---

## 2. Global Headers & Conventions

### Request Headers
- `Content-Type: application/json`
- `X-User-Id: <user_id>`: Identifies the requesting user (in Build 11, fake local identity).

### Response Format
All responses return standardized JSON:

#### Success (200 OK, 201 Created)
```json
{
  "success": true,
  "data": { ... }
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
  }
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

### 3.8 `GET /api/v1/runs/:runId?workspaceId=:workspaceId`
Get single run details and lifecycle status.
- **Response:** `200 OK`

### 3.9 `GET /api/v1/runs/:runId/artifacts?workspaceId=:workspaceId`
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
          "storagePath": "reports/run_001/execution.json",
          "byteSize": 14205,
          "sha256": "3a7b...",
          "contentType": "application/json",
          "createdAt": "2026-10-12T00:00:00.000Z"
        }
      ]
    }
  }
  ```
