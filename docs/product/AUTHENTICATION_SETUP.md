# CrashLab Product Authentication & Storage Setup Guide

**Build 12B.1: Real Authentication Boundary and Database-Backed API Wiring**

This guide documents the local development authentication model, bearer token generation, storage provider resolution, and security boundaries in CrashLab.

---

## 1. Authentication Architecture

CrashLab implements a provider-neutral authentication boundary designed to protect all product API endpoints (`/api/v1/*`):

```text
HTTP Request (Authorization: Bearer <token>)
         │
         ▼
Authentication Middleware (authenticateRequest)
  ├── 1. Valid HMAC-SHA256 Token -> IdentityContext { userId, authMethod: 'bearer_token', requestId }
  ├── 2. Invalid / Expired / Malformed Token -> HTTP 401 Unauthorized
  └── 3. Missing Token:
        ├── Production Mode (PRODUCT_AUTH_MODE=production) -> HTTP 401 Unauthorized
        └── Development Mode (PRODUCT_AUTH_MODE=development) -> Fallback to X-User-Id
```

### Why `X-User-Id` is Untrusted in Production Mode
In earlier builds (Build 11), a client-supplied `X-User-Id` was accepted as an MVP placeholder. In Build 12B.1:
- In **production mode** (`PRODUCT_AUTH_MODE=production`), any client-supplied `X-User-Id` header is **strictly rejected with HTTP 401**. An external caller cannot spoof their identity by injecting an HTTP header.
- In **development mode** (`PRODUCT_AUTH_MODE=development`), `X-User-Id` is permitted solely to facilitate fast manual and automated testing without generating tokens for every request.

---

## 2. Environment Configuration

Configure authentication and storage in your local `.env` or execution environment:

| Variable | Values | Default | Purpose |
| :--- | :--- | :--- | :--- |
| `PRODUCT_AUTH_MODE` | `development` \| `production` | `production` | Enables or disables local header fallback. |
| `PRODUCT_AUTH_SECRET` | *string* (min 32 chars recommended) | *Built-in dev fallback* | Secret key used to sign and verify HMAC-SHA256 bearer tokens. |
| `PRODUCT_STORAGE` | `in-memory` \| `postgres` | `in-memory` | Selects repository persistence provider. |
| `DATABASE_URL` | *postgresql://...* | *(none)* | PostgreSQL connection string. Required when `PRODUCT_STORAGE=postgres`. |

> [!WARNING]
> Never commit actual secret keys or `DATABASE_URL` values to version control. The `.env` file is untracked and excluded in `.gitignore`.

---

## 3. Creating and Using Development Tokens

### 3.1 Generating a Token via CLI

Generate a signed HMAC-SHA256 bearer token for local API testing:

```bash
# Generate a token for user 'usr_alice' with 1-hour lifetime (default)
npm run auth:token -- --user usr_alice

# Generate a token with a custom lifetime (e.g. 24 hours / 86400 seconds)
npm run auth:token -- --user usr_alice --expires 86400
```

Output:
```text
Generated Development Token for user: "usr_alice"
Token:      eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
Header:     Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
Expires At: 2026-10-13T12:00:00.000Z
Mode:       production

NOTICE: Development token for local test use only. Never commit or share.
```

### 3.2 Authenticating API Requests

Pass the token in the `Authorization` HTTP header:

```bash
curl -X GET http://127.0.0.1:3220/api/v1/workspaces \
  -H "Authorization: Bearer <token>"
```

Responses include an `X-Request-Id` response header:
```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
X-Request-Id: req_0123456789abcdef

{
  "success": true,
  "data": {
    "workspaces": [ ... ]
  },
  "requestId": "req_0123456789abcdef"
}
```

---

## 4. Verifying Configuration

Verify your local authentication and storage configuration safely without leaking credentials:

```bash
npm run auth:check
```

Output:
```text
CrashLab Product Configuration Check:
--------------------------------------------------
Authentication Mode: production
Auth Secret Status:  [configured: 32 chars]
Storage Provider:    in-memory
Database Target:     (In-Memory Transient Storage)
--------------------------------------------------
Configuration verified successfully.
```

---

## 5. Storage Provider Selection

CrashLab supports two repository storage providers via dependency injection:

1. **In-Memory Storage (`PRODUCT_STORAGE=in-memory`):**
   - Default for unit and browser tests.
   - Fully isolated, non-persistent, zero external setup or database required.
2. **PostgreSQL Storage (`PRODUCT_STORAGE=postgres`):**
   - Connects to PostgreSQL or Supabase using `DATABASE_URL`.
   - **No Silent Fallback:** If `PRODUCT_STORAGE=postgres` is set and `DATABASE_URL` is missing, the application fails immediately upon initialization with:
     ```
     Error: DATABASE_URL is required when PRODUCT_STORAGE=postgres.
     ```

---

## 6. Security & Audit Invariants

1. **Tokens Never Logged:** Bearer tokens, passwords, cookies, and signing secrets are never logged in terminal output or error messages.
2. **Timing-Safe Verification:** Token signatures are compared using `crypto.timingSafeEqual` to prevent timing attacks.
3. **Tenant Boundary Enforcement:** Accessing a workspace without active membership returns `403 FORBIDDEN` and records an immutable `workspace.access_denied` security audit event.
4. **Permanent Safety Invariants:** Safe test mode (`safeTestMode: true`), unconfirmed candidate trust invariants (`confirmed: false`, `confirmedBug: false`), and preflight gate enforcement remain permanently active.

---

## 7. What is Not Production-Ready Yet (Scope Boundaries)

Build 12B.1 implements local development tokens and dependency injection. The following belong to future builds:
- Public customer registration and email verification.
- Password hashing and user credential storage.
- OAuth2 / Social / OIDC / Supabase Auth hosted identity providers.
- Asynchronous browser worker queue.
- Cloud object storage (S3).
- Billing and usage quotas.
