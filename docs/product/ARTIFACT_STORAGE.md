# Secure Artifact Blob Storage Operations Manual

**Build 12B.2A: Secure Artifact Blob Storage**

This document describes CrashLab's physical artifact blob storage architecture, security boundaries, tenant isolation rules, and operational guidelines.

---

## 1. Architecture Overview

While the relational database tracks `run_artifacts` records (metadata, checksums, byte counts, and timestamps), physical evidence files—such as screenshots, Playwright execution traces, HAR network recordings, and JSON reports—are managed by a provider-neutral blob storage layer.

```text
HTTP Request (POST /api/v1/runs/:runId/artifacts)
          │  Bearer Authorization
          ▼
IdentityContext { userId, workspaceId, requestId }
          │
          ▼
ProductService.storeArtifact(...)
   1. Validate workspace membership & RBAC (canRunProject)
   2. Verify run exists in tenant workspace
   3. Sanitize metadata (assertNoSecrets)
   4. Put physical blob via BlobStore
          │
          ├─────────────────────────┬─────────────────────────┐
          ▼                         ▼                         ▼
   LocalBlobStore (Local FS)  SupabaseBlobStore (Cloud)  S3CompatibleBlobStore (Adapter)
   - Root: PRODUCT_BLOB_ROOT  - Bucket: SUPABASE_BUCKET   - Bucket: S3_BUCKET
   - Deterministic Key        - Deterministic Key        - S3 Object Key
   - Atomic Write             - REST API (/storage/v1)   - ETag / Checksum Header
   - SHA-256 verification     - SHA-256 verification     - Conflicting overwrite blocked
   - Immutability check       - Private bucket enforced  │
          │                   - Immutability check       │
          │                         │                    │
          └─────────────────────────┴────────────────────┘
          │
          ▼
   5. Insert metadata into run_artifacts
      (storage_path = safe relative key, e.g. workspace/.../artifact/...)
   6. On DB failure -> rollback and delete physical blob
   7. Record artifact.stored audit event
```

---

## 2. Deterministic Key Layout & Path Traversal Prevention

All artifact objects are addressed by a deterministic locator:

```typescript
export interface BlobLocator {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly artifactId: string;
}
```

### Deterministic Storage Key Format
```text
workspace/<workspaceId>/project/<projectId>/run/<runId>/artifact/<artifactId>
```

### Security Guarantees:
1. **Zero Path Traversal:**
   - Segment IDs are validated against strict regex: `/^[a-zA-Z0-9_\-\.]+$/`.
   - Prohibits directory traversal tokens (`..`, `.`).
   - Prohibits path separators (`/`, `\`) inside any ID segment.
   - Prohibits control characters (`\x00-\x1f`, `\x7f`) and null bytes (`\0`).
2. **Strict Root Confinement:**
   - Paths resolve strictly inside `PRODUCT_BLOB_ROOT`.
   - Any path resolving outside or escaping via symlinks is rejected with `PathTraversalError`.
3. **Zero Absolute Path Leakage:**
   - Clients never receive server filesystem paths (e.g. `C:\...` or `/var/...`).
   - The API and database expose only the safe, relative object key.

---

## 3. Immutability & Atomic Writes

Evidence artifacts are durable forensic records of automated test execution:
- **Atomic Writes:** Local blobs are written to temporary files and atomically renamed to their final path once complete.
- **Checksum Verification:** Every artifact calculates and verifies a SHA-256 cryptographic checksum and byte length upon storage.
- **No Conflicting Overwrites:** Attempting to overwrite an existing artifact ID with differing content throws `ArtifactImmutableConflictError`.
- **Idempotent Duplicate Writes:** Storing an identical artifact with matching checksum succeeds idempotently.

---

## 4. API Endpoints

All endpoints require Bearer token authorization and enforce workspace isolation.

### 4.1 Upload Artifact
- **Endpoint:** `POST /api/v1/runs/:runId/artifacts`
- **Headers:** `Authorization: Bearer <token>`, `Content-Type: application/json`
- **Body:**
  ```json
  {
    "workspaceId": "ws_123",
    "type": "anomalies",
    "content": { "anomalyCount": 1, "signals": [] },
    "contentType": "application/json"
  }
  ```
  *(For binary files such as screenshots, pass `encoding: "base64"` and the base64-encoded string in `content`)*
- **Response:** `201 Created`
  ```json
  {
    "success": true,
    "data": {
      "artifact": {
        "id": "art_...",
        "workspaceId": "ws_123",
        "runId": "run_456",
        "type": "anomalies",
        "storagePath": "workspace/ws_123/project/prj_789/run/run_456/artifact/art_...",
        "byteSize": 128,
        "sha256": "...",
        "contentType": "application/json",
        "createdAt": "2026-10-12T22:00:00.000Z"
      },
      "blob": {
        "safeObjectKey": "workspace/ws_123/project/prj_789/run/run_456/artifact/art_...",
        "byteLength": 128,
        "checksum": "..."
      }
    },
    "requestId": "req_..."
  }
  ```

### 4.2 List Run Artifacts
- **Endpoint:** `GET /api/v1/runs/:runId/artifacts?workspaceId=ws_123`
- **Response:** `200 OK` with `{ success: true, data: { artifacts: [...] }, requestId: "..." }`

### 4.3 Get Artifact Metadata
- **Endpoint:** `GET /api/v1/artifacts/:artifactId?workspaceId=ws_123`
- **Response:** `200 OK` with artifact metadata record.

### 4.4 Download Artifact Content
- **Endpoint:** `GET /api/v1/artifacts/:artifactId/content?workspaceId=ws_123`
- **Response:** `200 OK`
  - `Content-Type`: artifact content type (e.g. `application/json`, `image/png`)
  - `Content-Length`: byte size
  - `ETag`: `"<sha256>"`
  - `X-Artifact-Type`: artifact type
  - `X-Artifact-Sha256`: SHA-256 hash
  - `X-Request-Id`: request tracing ID
  - Body: raw artifact payload

---

## 5. Configuration Reference

```ini
# Provider: 'local' (development/test) or 'supabase' (production) or 's3' (boundary)
PRODUCT_BLOB_STORE=supabase

# Safe local filesystem root for development/tests (when PRODUCT_BLOB_STORE=local)
PRODUCT_BLOB_ROOT=./.artifacts

# Production Supabase Storage configuration (when PRODUCT_BLOB_STORE=supabase)
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_STORAGE_BUCKET=crashlab-artifacts
# Server-only service-role key (never expose to client or logs)
SUPABASE_SERVICE_ROLE_KEY=eyJh...
# Maximum artifact byte size (default: 52428800 = 50MB)
PRODUCT_BLOB_MAX_BYTES=52428800

# Optional S3-compatible configuration (when PRODUCT_BLOB_STORE=s3)
# PRODUCT_BLOB_S3_BUCKET=crashlab-evidence-vault
# PRODUCT_BLOB_S3_PREFIX=artifacts/
```

See [SUPABASE_STORAGE_SETUP.md](file:///c:/Users/kxtri/Crash-labs/docs/product/SUPABASE_STORAGE_SETUP.md) for full bucket provisioning and operational instructions.
