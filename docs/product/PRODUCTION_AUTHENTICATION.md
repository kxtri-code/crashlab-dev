# CrashLab Production Authentication & OIDC/JWT Architecture

**Build 12D.1: Production Authentication and Deployment Readiness**

This document describes CrashLab's production authentication architecture, Supabase Auth integration, cryptographic verification pipeline, and identity mapping model.

---

## 1. Architectural Overview

In earlier milestones (Build 12B.1–12C.2), CrashLab utilized local HMAC-SHA256 bearer tokens and `X-User-Id` header fallbacks to facilitate local testing and dashboard prototyping. Build 12D.1 replaces this development-only mechanism with an asymmetric, provider-neutral **OIDC/JWT verification boundary** compatible with Supabase Auth and any standard OpenID Connect provider.

```text
Incoming HTTP Request (Authorization: Bearer <jwt>)
                      │
                      ▼
        ┌───────────────────────────┐
        │ Product API Middleware    │
        │  (authenticateRequest)    │
        └─────────────┬─────────────┘
                      │
          Mode Check: PRODUCT_AUTH_MODE
          ├── 'development': Allow dev HMAC tokens & X-User-Id fallback
          └── 'production':  Strictly enforce JWT / JWKS verification
                      │
                      ▼
        ┌───────────────────────────┐
        │   JwtVerifier Boundary    │
        │  (RS256 / ES256 / EdDSA)  │
        └─────────────┬─────────────┘
                      │
     1. Parse Token Structure (Header, Payload, Signature)
     2. Reject Dev Tokens (format: dev-token-*)
     3. Fetch / Match Key from JWKS Cache (or force-refresh if kid unknown)
     4. Cryptographically Verify Signature (via node:crypto)
     5. Validate Claims:
        - exp (expiration time)
        - nbf (not-before time)
        - iss (exact issuer match against SUPABASE_JWT_ISSUER)
        - aud (audience match against SUPABASE_JWT_AUDIENCE)
        - sub (presence of non-empty subject ID)
                      │
                      ▼
        ┌───────────────────────────┐
        │  Identity Mapping Check   │
        └─────────────┬─────────────┘
                      │
     Map JWT `sub` -> CrashLab User in Database
     ├── User Exists: Proceed with verified IdentityContext
     └── User Unknown: Return 401 UNAUTHORIZED (code: USER_NOT_PROVISIONED)
```

---

## 2. Cryptographic Verification & JWKS Client

Verification is implemented using Node.js's native `node:crypto` subsystem in `src/product/auth/jwtVerifier.ts`:

- **Zero Unsafe Cryptography:** No manual signature parsing or rolling of crypto routines. Native Web Crypto / KeyObject primitives (`crypto.createPublicKey({ key: jwk, format: 'jwk' })` and `crypto.verify`) execute constant-time, platform-tested signature evaluations.
- **Supported Algorithms:** `RS256` (RSA-SHA256) and `ES256` (ECDSA P-256 with IEEE-P1363 curve encoding).
- **Safe Key ID (`kid`) Lookup:** The token header's `kid` is matched against cached public keys.
- **Bounded JWKS Cache:** The `JwksClient` caches public keys for a bounded time-to-live (`ttlMs`, default 10 minutes).
- **Key Rotation Support:** If a token arrives with an unknown `kid` before the cache expires, `JwksClient` automatically bypasses the cache to fetch a fresh JWKS payload once, preventing downtime during provider key rotations while remaining rate-bounded.

---

## 3. Strict Development vs Production Separation

CrashLab enforces absolute separation between development and production modes:

| Requirement | Development Mode (`PRODUCT_AUTH_MODE=development`) | Production Mode (`PRODUCT_AUTH_MODE=production`) |
| --- | --- | --- |
| **Default Mode** | Opt-in | **Default when unset or in hosted environments** |
| **Dev HMAC Tokens** | Allowed | **Strictly Rejected** (HTTP 401) |
| **`X-User-Id` Header** | Permitted as fallback | **Strictly Rejected** (HTTP 401) |
| **JWT Config Check** | Skipped | **Fails Closed** if `SUPABASE_JWKS_URL`, `SUPABASE_JWT_ISSUER`, or `SUPABASE_JWT_AUDIENCE` are missing |
| **Blob Storage** | `local` allowed by default | `local` refused unless `PRODUCT_BLOB_ALLOW_LOCAL_IN_PRODUCTION=true` |
| **CORS Policy** | Permissive local loopback | Explicit origin allowlist (wildcards strictly rejected) |
| **Worker Queue** | Disabled by default | Disabled by default (explicit opt-in required) |

---

## 4. Supabase Configuration Boundary

Production authentication configuration requires only public/server-safe endpoints:

```bash
# Server-Side Configuration (Never exposed to frontend assets or browser)
PRODUCT_AUTH_MODE=production
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_JWT_ISSUER=https://<project-ref>.supabase.co/auth/v1
SUPABASE_JWT_AUDIENCE=authenticated
SUPABASE_JWKS_URL=https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json
```

### Critical Security Boundaries
1. **Service-Role Key Invariant:** Supabase service-role keys (`SUPABASE_SERVICE_ROLE_KEY`) are **never required** for public-key JWT verification.
2. **Zero Bundling in Frontend:** Service-role keys, database passwords, or JWT secrets must never be placed in frontend environment files, JavaScript bundles, or dashboard assets.
3. **Safe Missing Variable Reporting:** The environment validator (`validateProductionAuthConfig`) reports only the names of missing variables; configuration values and partial secrets are never logged.

---

## 5. Identity Mapping & User Provisioning

When a client sends a valid, cryptographically verified JWT:
1. The token subject (`sub`) is extracted as the authenticated user's external ID.
2. The server queries the database for a matching `User` record (`getUser(sub)`).
3. **If Found:** The request proceeds with verified workspace membership and RBAC role checks.
4. **If Not Found:** The request fails closed with HTTP 401:
   ```json
   {
     "success": false,
     "error": {
       "code": "USER_NOT_PROVISIONED",
       "message": "Authenticated user is not provisioned in CrashLab."
     },
     "requestId": "req_..."
   }
   ```

### User Provisioning Status: Manual / Pre-Provisioned
- **Current Milestone Status:** User provisioning in Build 12D.1 is **invite-based / manual**.
- **Security Invariant:** Automatic provisioning is **not** enabled. An uninvited user with a valid Supabase token cannot auto-create an account or inherit default workspace permissions.
- **Tenant Isolation:** Workspace membership is verified exclusively on the server against the database. Client-supplied `workspaceId` headers or query parameters are never trusted without active membership validation.

---

## 6. Audit Logging & Sanitization

Security-critical authentication events are logged to the immutable audit trail:
- `auth.success`: Logged on successful token verification and identity mapping.
- `auth.failure`: Logged on invalid signatures, expired tokens, or malformed claims.
- `auth.invalid_issuer_or_audience`: Logged when token issuer or audience mismatches configuration.
- `auth.unknown_user`: Logged when a valid token contains a subject not provisioned in CrashLab.
- `config.refused`: Logged when production mode starts with incomplete auth configuration.

### Log Sanitization Guarantees
- Raw JWT strings are **never** logged.
- `Authorization` headers and cookies are stripped before request logging.
- Audit event metadata contains only safe references (`userId`, `method`, `reason`).
- No claims containing sensitive data (e.g. emails, metadata secrets) are placed into audit logs.
