# PostgreSQL / Supabase Setup Guide

**Build 12A: PostgreSQL Persistence Adapter**

This document describes how to configure, connect, and verify a PostgreSQL or Supabase database for CrashLab's hosted SaaS foundation.

---

## 1. Why PostgreSQL for CrashLab?

CrashLab requires a robust relational database engine because:
1. **Multi-Tenant Isolation:** Relational foreign keys and workspace scoping guarantee strict tenant boundaries between customer environments.
2. **ACID Invariants:** Test runs execute through a deterministic state machine where state transitions, preflight checks, and candidate registrations must be atomic.
3. **Structured Review Audits:** Human triage decisions and audit logs are append-only; relational queries with b-tree indexes enable efficient historical inspection.
4. **Complex Filtered Views:** Queries filtering by workspace, project, rule ID, recurrence, and triage status perform optimally in relational storage.

---

## 2. Adapter Architecture: In-Memory vs PostgreSQL

CrashLab domain logic and product services depend solely on the provider-neutral repository interfaces defined in `src/product/repository/interfaces.ts`.

```
Product Service / API
         │
         ▼
ProductRepositories (Interface)
    ├── InMemoryProductRepository   (Zero-dependency tests & local development)
    └── PostgresProductRepository   (Production & staging persistence)
         │
         ▼
PostgreSQL / Supabase Postgres
```

- **Local Unit Tests & CI:** Use `InMemoryProductRepository` or `MockPostgresPool`. Zero external network calls, zero database processes required.
- **Hosted Private-Beta / Production:** Use `PostgresProductRepository` connected to PostgreSQL or Supabase via standard pooled connections.
- The business logic never changes between storage adapters.

---

## 3. How Supabase Fits In

Supabase is a hosted PostgreSQL platform. CrashLab communicates with Supabase via standard PostgreSQL connection pooling (`pg.Pool` over port 5432 or 6543 pooler).

- Supabase Postgres is fully compatible with CrashLab's SQL migrations and parameterized queries.
- CrashLab does **not** hardcode Supabase proprietary client libraries into domain logic.
- Connecting to Supabase requires only setting `DATABASE_URL` to your project's connection pooler URI.

---

## 4. Local Configuration

To configure a local PostgreSQL instance:

1. Copy `.env.example` to `.env` (gitignored):
   ```bash
   cp .env.example .env
   ```

2. Set the connection string placeholder in `.env`:
   ```bash
   DATABASE_URL=postgresql://user:password@localhost:5432/crashlab
   DATABASE_SSL=false
   DATABASE_POOL_MAX=10
   DATABASE_CONNECT_TIMEOUT_MS=5000
   ```

> [!CAUTION]
> Never commit `.env` or any connection string with real passwords, tokens, or cloud hostnames to version control.

---

## 5. Checking Connectivity

Verify that CrashLab can reach the database:

```bash
npm run db:check
```

Example successful output:
```text
Checking connection to PostgreSQL (localhost:5432/crashlab)...
Database connection verified successfully.
Target: host=localhost, port=5432, database=crashlab, ssl=false
```

If `DATABASE_URL` is omitted, the CLI fails cleanly with exit code 1:
```text
DATABASE_URL is required for this command.
```

---

## 6. Running Migrations

Apply database schema migrations:

```bash
npm run db:migrate
```

See [DATABASE_MIGRATIONS.md](file:///c:/Users/kxtri/Crash-labs/docs/product/DATABASE_MIGRATIONS.md) for full migration details.
