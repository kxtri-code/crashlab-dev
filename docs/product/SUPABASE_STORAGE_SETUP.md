# Supabase Storage Setup & Operations Manual

**Build 12D.2A: Private Supabase Storage for Production Artifacts**

This document describes how to configure, provision, verify, and operate private Supabase Storage buckets for CrashLab test artifacts (screenshots, Playwright execution traces, HAR network archives, JSON reports, and execution logs).

---

## 1. Security Architecture & Privacy Mandate

CrashLab test artifacts contain sensitive operational data:
- Execution screenshots and traces of internal web interfaces
- Network headers and HAR archives
- Diagnostic logs and anomaly details

### Security Guarantees:
1. **Private Buckets Only (`public: false`):**
   - Public read access is strictly forbidden.
   - Buckets configured as `public: true` are rejected by both `storage:check` and the `SupabaseBlobStore` adapter runtime.
2. **Server-Only Credentials:**
   - The Supabase service-role key (`SUPABASE_SERVICE_ROLE_KEY`) is strictly server-only.
   - It is **never** bundled into frontend/dashboard assets.
   - It is **never** returned via API responses or printed in error logs.
   - It is **never** stored in audit records or configuration check outputs.
3. **No Direct Browser Uploads / Downloads:**
   - Browsers never communicate directly with Supabase Storage.
   - All artifact writes and reads are brokered and authenticated through the CrashLab Product API (`POST /api/v1/runs/:runId/artifacts` and `GET /api/v1/artifacts/:artifactId/content`).
   - Every download requires a valid production JWT, workspace membership, and RBAC authorization.

---

## 2. Configuration Reference

In production mode (`PRODUCT_AUTH_MODE=production`), set the following server environment variables:

```ini
# Enable Supabase Storage provider
PRODUCT_BLOB_STORE=supabase

# Supabase Project URL (e.g. https://<project-ref>.supabase.co)
SUPABASE_URL=https://<project-ref>.supabase.co

# Private Storage Bucket Name
SUPABASE_STORAGE_BUCKET=crashlab-artifacts

# Server-Only Service-Role Secret Key (MUST be kept confidential)
SUPABASE_SERVICE_ROLE_KEY=eyJh...<server-only-secret>

# Bounded Maximum Artifact File Size (in bytes, default: 52428800 = 50MB)
PRODUCT_BLOB_MAX_BYTES=52428800
```

### Fail-Closed Behavior
In production mode (`PRODUCT_AUTH_MODE=production`), the application **fails closed** during startup if:
- `SUPABASE_URL` is missing or invalid
- `SUPABASE_STORAGE_BUCKET` is missing
- `SUPABASE_SERVICE_ROLE_KEY` is missing
- `PRODUCT_BLOB_STORE` is set to `local` without `PRODUCT_BLOB_ALLOW_LOCAL_IN_PRODUCTION=true`

There is **no silent fallback** to local storage in production.

---

## 3. Storage CLI Commands

CrashLab provides explicit CLI tools to verify and provision Supabase Storage.

### 3.1 Verify Storage (`npm run storage:check`)
Verifies reachability, credentials, and bucket privacy without mutating any data or exposing secrets:

```bash
npm run storage:check
```

Example Output:
```text
CrashLab Artifact Storage Check:
--------------------------------------------------
Storage Provider:    supabase
Supabase Host:       https://<project-ref>.supabase.co
Storage Bucket:      crashlab-artifacts
Service Key Status:  [configured: 52 chars]
Max Artifact Bytes:  52428800 bytes
--------------------------------------------------
Bucket Status:       Reachable
Privacy Check:       PRIVATE (Secure)
--------------------------------------------------
Storage configuration verified successfully.
```

If the bucket is misconfigured as public, the command exits with code `1`:
```text
SECURITY VIOLATION: Bucket "crashlab-artifacts" is marked PUBLIC.
Artifact buckets must be private. Please update bucket settings in Supabase to public: false.
```

### 3.2 Provision Private Bucket (`npm run storage:setup`)
To create the bucket programmatically with strict private settings (`public: false`), use `storage:setup`.

> [!IMPORTANT]
> Bucket creation requires an explicit `--confirm` flag to prevent accidental provisioning.

```bash
npm run storage:setup -- --confirm
```

Options:
- `--confirm`: Required confirmation flag to proceed with bucket creation.
- `-h, --help`: Display command usage.

The setup command:
1. Validates `SUPABASE_URL`, `SUPABASE_STORAGE_BUCKET`, and `SUPABASE_SERVICE_ROLE_KEY`.
2. Inspects whether the bucket already exists.
3. If not found, creates the bucket with:
   - `public: false` (strictly private)
   - `file_size_limit: PRODUCT_BLOB_MAX_BYTES` (bounded file size)
   - `allowed_mime_types: null` (allows standard artifact formats: images, traces, JSON, text)

---

## 4. Manual Bucket Creation in Supabase Studio

If you prefer provisioning via Supabase Studio UI:
1. Log in to [Supabase Dashboard](https://supabase.com/dashboard) and select your project.
2. Navigate to **Storage** in the left sidebar.
3. Click **New Bucket**.
4. Enter bucket name: `crashlab-artifacts`.
5. Ensure **Public bucket** toggle is turned **OFF** (Private).
6. Set **File size limit** (e.g. `50MB`).
7. Save the bucket.
8. Run `npm run storage:check` to verify the configuration.

---

## 5. Object Key Structure & Immutability

Artifacts are addressed deterministically across workspaces:
```text
workspace/<workspaceId>/project/<projectId>/run/<runId>/artifact/<artifactId>
```

### Immutability & Checksums:
- Every uploaded artifact verifies the SHA-256 digest and payload length before recording metadata in PostgreSQL.
- Overwriting an existing artifact with differing content is rejected (`ArtifactImmutableConflictError`).
- Re-uploading identical content with the same hash succeeds idempotently (`idempotent: true`).
- If metadata creation in the database fails, the uploaded object is immediately deleted from Supabase Storage to prevent orphaned objects.

---

## 6. Safe Cleanup & Testing

Artifact cleanup is strictly controlled:
- **No Broad Deletions:** The system never deletes entire buckets or unreferenced prefixes.
- **Test-Only Safe Cleanup Helper:** `deleteTestArtifactSafely(locator, client)` targets only specific test artifacts within designated test workspaces.
- **Production Retention:** Production artifacts are retained according to workspace compliance policies.

---

## 7. Remaining Production Limitations (Build 12D.2A)

While private Supabase Storage is fully functional and verified:
1. **Asynchronous Worker Deployment:** The background worker currently runs in-process or local polling; independent standalone worker fleet deployment is slated for Build 12D.2B / Build 13.
2. **Lifecycle Expiration Policies:** Automated lifecycle transitions (e.g. archiving objects older than 90 days to cold storage) should be configured in cloud storage policies.
3. **Streaming Downloads for Multi-Gigabyte Traces:** Current downloads stream in chunks through the Product API server; large multi-GB traces may benefit from short-lived pre-signed download URLs in a future build.
