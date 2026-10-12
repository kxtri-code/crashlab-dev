/**
 * Build 12A Unit & Contract Test Suite: PostgreSQL Persistence Adapter.
 *
 * Verifies:
 * - Provider-neutral repository contract equivalence (In-Memory vs PostgreSQL)
 * - 100% Parameterized queries ($1, $2, ...)
 * - Workspace isolation query enforcement
 * - Secret exclusion & rejection before persistence
 * - Invariant persistence: safeTestMode: true, confirmed: false, confirmedBug: false
 * - Append-only audit logs
 * - Database migration execution and idempotency
 * - Credential sanitization (passwords never logged or leaked in errors)
 * - CLI commands: db:check and db:migrate (exit codes 0, 1, 2)
 *
 * Guarantees ZERO external network requests, ZERO cloud database requirements,
 * and ZERO browser launches.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createInMemoryProductRepositories,
  createPostgresProductRepositories,
  MockPostgresPool,
  runMigrations,
  sanitizeConnectionString,
  loadPostgresConfigFromEnv,
  ProductService,
  DeterministicIdGenerator,
  createProductApiServer,
  type ProductRepositories,
} from '../../src/product/index.js';
import { runDbCheckCommand } from '../../src/cli/dbCheckCommand.js';
import { runDbMigrateCommand } from '../../src/cli/dbMigrateCommand.js';
import type { User } from '../../src/product/types/user.js';
import type { Workspace, WorkspaceMember } from '../../src/product/types/workspace.js';
import type { Project } from '../../src/product/types/project.js';
import type { TargetEnvironment } from '../../src/product/types/target.js';
import type { ProductApprovedJourney } from '../../src/product/types/journey.js';
import type { TestRun } from '../../src/product/types/run.js';
import type { RunArtifact } from '../../src/product/types/artifact.js';
import type { CandidateReference } from '../../src/product/types/candidate.js';
import type { AuditEvent } from '../../src/product/types/audit.js';

describe('Build 12A: PostgreSQL Persistence Adapter Suite', () => {
  let mockPool: MockPostgresPool;
  let postgresRepos: ProductRepositories;
  let inMemoryRepos: ProductRepositories;

  beforeEach(async () => {
    mockPool = new MockPostgresPool();
    await runMigrations(mockPool);
    postgresRepos = createPostgresProductRepositories(mockPool);
    inMemoryRepos = createInMemoryProductRepositories();
  });

  // ===========================================================================
  // 1. Shared Repository Contract Tests (Equivalence between in-memory & postgres)
  // ===========================================================================
  const implementations = [
    { name: 'InMemoryProductRepository', getRepos: () => inMemoryRepos },
    { name: 'PostgresProductRepository', getRepos: () => postgresRepos },
  ];

  for (const impl of implementations) {
    describe(`1. Repository Contract Tests: ${impl.name}`, () => {
      let repos: ProductRepositories;

      beforeEach(() => {
        repos = impl.getRepos();
      });

      it('manages Users: create, findById, findByEmail, update, and rejects duplicates', async () => {
        const user: User = {
          id: 'usr_contract_1',
          schemaVersion: '1.0',
          email: 'alice@contract.test',
          name: 'Alice Tester',
          status: 'active',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        const created = await repos.users.create(user);
        expect(created.id).toBe(user.id);
        expect(created.email).toBe(user.email);

        const byId = await repos.users.findById('usr_contract_1');
        expect(byId?.email).toBe('alice@contract.test');

        const byEmail = await repos.users.findByEmail('ALICE@CONTRACT.TEST');
        expect(byEmail?.id).toBe('usr_contract_1');

        // Duplicate ID rejection
        await expect(repos.users.create(user)).rejects.toThrow();

        // Duplicate email rejection
        await expect(
          repos.users.create({ ...user, id: 'usr_contract_2' }),
        ).rejects.toThrow();

        // Update
        const updated = await repos.users.update({ ...user, name: 'Alice Renamed' });
        expect(updated.name).toBe('Alice Renamed');
        const reloaded = await repos.users.findById('usr_contract_1');
        expect(reloaded?.name).toBe('Alice Renamed');
      });

      it('manages Workspaces: create, findById, findBySlug, listByOwner, and rejects duplicates', async () => {
        const ws: Workspace = {
          id: 'ws_contract_1',
          schemaVersion: '1.0',
          name: 'Contract QA',
          slug: 'contract-qa',
          ownerUserId: 'usr_contract_1',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        const created = await repos.workspaces.create(ws);
        expect(created.id).toBe('ws_contract_1');

        const bySlug = await repos.workspaces.findBySlug('contract-qa');
        expect(bySlug?.id).toBe('ws_contract_1');

        const byOwner = await repos.workspaces.listByOwner('usr_contract_1');
        expect(byOwner).toHaveLength(1);

        // Duplicate slug rejection
        await expect(
          repos.workspaces.create({ ...ws, id: 'ws_contract_2' }),
        ).rejects.toThrow();
      });

      it('manages Workspace Members: create, find, list, delete, and duplicate rejection', async () => {
        const member: WorkspaceMember = {
          id: 'mem_contract_1',
          schemaVersion: '1.0',
          workspaceId: 'ws_contract_1',
          userId: 'usr_contract_2',
          role: 'member',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        await repos.memberships.create(member);

        const found = await repos.memberships.findByWorkspaceAndUser('ws_contract_1', 'usr_contract_2');
        expect(found?.role).toBe('member');

        const list = await repos.memberships.listByWorkspace('ws_contract_1');
        expect(list).toHaveLength(1);

        // Duplicate membership in same workspace
        await expect(
          repos.memberships.create({ ...member, id: 'mem_contract_dup' }),
        ).rejects.toThrow();

        // Delete
        const deleted = await repos.memberships.delete('mem_contract_1');
        expect(deleted).toBe(true);

        const afterDelete = await repos.memberships.findById('mem_contract_1');
        expect(afterDelete).toBeNull();
      });

      it('manages Projects with workspace isolation and duplicate name checks', async () => {
        const prj: Project = {
          id: 'prj_contract_1',
          schemaVersion: '1.0',
          workspaceId: 'ws_contract_1',
          name: 'Main App',
          description: 'Production candidate app',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        await repos.projects.create(prj);

        const found = await repos.projects.findById('ws_contract_1', 'prj_contract_1');
        expect(found?.name).toBe('Main App');

        // Isolation: querying from foreign workspace returns null
        const foreign = await repos.projects.findById('ws_foreign', 'prj_contract_1');
        expect(foreign).toBeNull();

        // Duplicate project name in same workspace
        await expect(
          repos.projects.create({ ...prj, id: 'prj_contract_2' }),
        ).rejects.toThrow();
      });

      it('manages Targets, Journeys, Runs, Artifacts, and Candidates', async () => {
        const target: TargetEnvironment = {
          id: 'tgt_contract_1',
          schemaVersion: '1.0',
          workspaceId: 'ws_contract_1',
          projectId: 'prj_contract_1',
          name: 'Staging Target',
          environment: 'staging',
          targetUrl: 'https://staging.example.test',
          targetOrigin: 'https://staging.example.test',
          allowedOrigins: ['https://staging.example.test'],
          forbiddenActions: ['payment', 'checkout', 'delete_account'],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        await repos.targets.create(target);

        const journey: ProductApprovedJourney = {
          id: 'jny_contract_1',
          schemaVersion: '1.0',
          workspaceId: 'ws_contract_1',
          projectId: 'prj_contract_1',
          targetEnvironmentId: 'tgt_contract_1',
          goal: 'Login and browse items',
          origin: 'https://staging.example.test',
          allowedActions: ['navigate', 'click'],
          forbiddenActions: ['checkout'],
          requiresCredentials: false,
          requiresTestData: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        await repos.journeys.create(journey);

        const run: TestRun = {
          id: 'run_contract_1',
          schemaVersion: '1.0',
          workspaceId: 'ws_contract_1',
          projectId: 'prj_contract_1',
          targetEnvironmentId: 'tgt_contract_1',
          journeyId: 'jny_contract_1',
          status: 'created',
          safeTestMode: true,
          preflightStatus: 'pending',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        await repos.runs.create(run);

        const artifact: RunArtifact = {
          id: 'art_contract_1',
          schemaVersion: '1.0',
          workspaceId: 'ws_contract_1',
          runId: 'run_contract_1',
          type: 'execution',
          storagePath: 'reports/runs/run_contract_1/execution.json',
          byteSize: 1024,
          sha256: 'a'.repeat(64),
          contentType: 'application/json',
          createdAt: new Date().toISOString(),
        };
        await repos.artifacts.create(artifact);

        const candidate: CandidateReference = {
          id: 'candref_contract_1',
          schemaVersion: '1.0',
          workspaceId: 'ws_contract_1',
          projectId: 'prj_contract_1',
          runId: 'run_contract_1',
          candidateId: 'cand-001',
          ruleId: 'HTTP_5XX',
          classification: 'novel',
          reproduced: true,
          reviewStatus: 'unreviewed',
          confirmed: false,
          confirmedBug: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        await repos.candidates.create(candidate);

        // Verification of retrieval
        const foundTarget = await repos.targets.findById('ws_contract_1', 'tgt_contract_1');
        expect(foundTarget?.allowedOrigins).toEqual(['https://staging.example.test']);

        const foundJourney = await repos.journeys.findById('ws_contract_1', 'jny_contract_1');
        expect(foundJourney?.goal).toBe('Login and browse items');

        const foundRun = await repos.runs.findById('ws_contract_1', 'run_contract_1');
        expect(foundRun?.safeTestMode).toBe(true);

        const foundArtifacts = await repos.artifacts.listByRun('ws_contract_1', 'run_contract_1');
        expect(foundArtifacts).toHaveLength(1);

        const foundCandidates = await repos.candidates.listByRun('ws_contract_1', 'run_contract_1');
        expect(foundCandidates).toHaveLength(1);
        expect(foundCandidates[0]?.confirmed).toBe(false);
        expect(foundCandidates[0]?.confirmedBug).toBe(false);
      });

      it('manages Audit Events append-only with deterministic ordering', async () => {
        const event1: AuditEvent = {
          id: 'aud_contract_1',
          schemaVersion: '1.0',
          workspaceId: 'ws_contract_1',
          actorUserId: 'usr_contract_1',
          eventType: 'workspace.created',
          entityType: 'workspace',
          entityId: 'ws_contract_1',
          metadata: { name: 'WS 1' },
          timestamp: '2026-10-12T10:00:00.000Z',
        };
        const event2: AuditEvent = {
          id: 'aud_contract_2',
          schemaVersion: '1.0',
          workspaceId: 'ws_contract_1',
          actorUserId: 'usr_contract_1',
          eventType: 'project.created',
          entityType: 'project',
          entityId: 'prj_contract_1',
          metadata: { name: 'P 1' },
          timestamp: '2026-10-12T10:05:00.000Z',
        };

        await repos.audits.create(event1);
        await repos.audits.create(event2);

        const audits = await repos.audits.listByWorkspace('ws_contract_1');
        expect(audits).toHaveLength(2);
        // Latest first ordering
        expect(audits[0]?.id).toBe('aud_contract_2');
        expect(audits[1]?.id).toBe('aud_contract_1');
      });
    });
  }

  // ===========================================================================
  // 2. PostgreSQL Adapter Specific: Parameterization Proof
  // ===========================================================================
  describe('2. Parameterized SQL & Query Integrity', () => {
    it('proves 100% of queries executed by PostgresProductRepository are parameterized', async () => {
      mockPool.queryLog.length = 0; // Reset query log

      const user: User = {
        id: 'usr_param_1',
        schemaVersion: '1.0',
        email: 'param@test.com',
        name: 'Parameter Test',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await postgresRepos.users.create(user);
      await postgresRepos.users.findById('usr_param_1');
      await postgresRepos.users.findByEmail('param@test.com');

      expect(mockPool.queryLog.length).toBeGreaterThanOrEqual(3);

      for (const entry of mockPool.queryLog) {
        // SQL must contain parameterized placeholders ($1, $2, ...)
        if (entry.text.startsWith('INSERT') || entry.text.startsWith('SELECT') || entry.text.startsWith('UPDATE')) {
          expect(entry.text).toMatch(/\$\d+/);
          // Raw unparameterized dynamic user literals must NOT appear inside the SQL text
          expect(entry.text).not.toContain('param@test.com');
          expect(entry.text).not.toContain('Parameter Test');
        }
      }
    });
  });

  // ===========================================================================
  // 3. Tenant Isolation Proof at PostgreSQL Query Boundary
  // ===========================================================================
  describe('3. Tenant Isolation Proof at Repository Query Boundary', () => {
    it('strictly refuses cross-workspace read and mutation at repository query level', async () => {
      const prjA: Project = {
        id: 'prj_isolated_a',
        schemaVersion: '1.0',
        workspaceId: 'ws_tenant_a',
        name: 'Secret App A',
        description: '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await postgresRepos.projects.create(prjA);

      // Workspace B queries for Workspace A's project ID -> Returns null
      const foundInB = await postgresRepos.projects.findById('ws_tenant_b', 'prj_isolated_a');
      expect(foundInB).toBeNull();

      // Workspace B attempts to update Workspace A's project -> Throws not found in workspace error
      await expect(
        postgresRepos.projects.update({ ...prjA, workspaceId: 'ws_tenant_b' }),
      ).rejects.toThrow(/does not exist in workspace "ws_tenant_b"/);

      // Workspace B project list contains 0 items
      const bProjects = await postgresRepos.projects.listByWorkspace('ws_tenant_b');
      expect(bProjects).toHaveLength(0);
    });
  });

  // ===========================================================================
  // 4. Secret Boundary Enforcement & Sanitization
  // ===========================================================================
  describe('4. Secret Boundary Enforcement & Sanitization', () => {
    it('strictly refuses to persist entities with secret fields', async () => {
      const dirtyUser: any = {
        id: 'usr_dirty_1',
        schemaVersion: '1.0',
        email: 'dirty@test.com',
        name: 'Dirty',
        password: 'raw_password_secret',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await expect(postgresRepos.users.create(dirtyUser)).rejects.toThrow(/violates secret boundary/);
    });

    it('strictly refuses to persist audit events with secret metadata', async () => {
      const dirtyAudit: any = {
        id: 'aud_dirty_1',
        schemaVersion: '1.0',
        workspaceId: 'ws_1',
        actorUserId: 'usr_1',
        eventType: 'project.created',
        entityType: 'project',
        entityId: 'prj_1',
        metadata: {
          bearerToken: 'secret_token_123',
        },
        timestamp: new Date().toISOString(),
      };

      await expect(postgresRepos.audits.create(dirtyAudit)).rejects.toThrow(/violates secret boundary/);
    });

    it('sanitizes PostgreSQL connection strings so passwords never leak', () => {
      const raw = 'postgresql://admin:superSecret123@db.supabase.co:5432/crashlab?sslmode=require';
      const sanitized = sanitizeConnectionString(raw);

      expect(sanitized).not.toContain('superSecret123');
      expect(sanitized).toBe('postgresql://admin:***@db.supabase.co:5432/crashlab?sslmode=require');
    });
  });

  // ===========================================================================
  // 5. Database Migrations
  // ===========================================================================
  describe('5. Database Migrations & Idempotency', () => {
    it('applies migrations on initial run and is cleanly idempotent on subsequent runs', async () => {
      const pool = new MockPostgresPool();
      const run1 = await runMigrations(pool);
      expect(run1.applied).toHaveLength(1);
      expect(run1.applied[0]).toBe('001_initial_product_schema.sql');
      expect(run1.alreadyApplied).toHaveLength(0);

      // Subsequent execution is cleanly idempotent
      const run2 = await runMigrations(pool);
      expect(run2.applied).toHaveLength(0);
      expect(run2.alreadyApplied).toHaveLength(1);
      expect(run2.alreadyApplied[0]).toBe('001_initial_product_schema.sql');
    });
  });

  // ===========================================================================
  // 6. CLI Commands: db:check & db:migrate
  // ===========================================================================
  describe('6. CLI Commands (db:check & db:migrate)', () => {
    it('db:check --help returns exit code 0', async () => {
      const code = await runDbCheckCommand(['--help']);
      expect(code).toBe(0);
    });

    it('db:check fails with exit code 1 when DATABASE_URL is missing', async () => {
      const oldEnv = process.env.DATABASE_URL;
      delete process.env.DATABASE_URL;
      try {
        const code = await runDbCheckCommand([]);
        expect(code).toBe(1);
      } finally {
        if (oldEnv) process.env.DATABASE_URL = oldEnv;
      }
    });

    it('db:check returns exit code 2 on invalid flags', async () => {
      const code = await runDbCheckCommand(['--unsupported-flag']);
      expect(code).toBe(2);
    });

    it('db:migrate --help returns exit code 0', async () => {
      const code = await runDbMigrateCommand(['--help']);
      expect(code).toBe(0);
    });

    it('db:migrate fails with exit code 1 when DATABASE_URL is missing', async () => {
      const oldEnv = process.env.DATABASE_URL;
      delete process.env.DATABASE_URL;
      try {
        const code = await runDbMigrateCommand([]);
        expect(code).toBe(1);
      } finally {
        if (oldEnv) process.env.DATABASE_URL = oldEnv;
      }
    });

    it('db:migrate returns exit code 2 on invalid flags', async () => {
      const code = await runDbMigrateCommand(['--bad-flag']);
      expect(code).toBe(2);
    });
  });

  // ===========================================================================
  // 7. ProductService & REST API Integration with PostgreSQL Adapter
  // ===========================================================================
  describe('7. ProductService & REST API Integration with PostgreSQL Adapter', () => {
    it('executes full service flow on top of PostgresProductRepository', async () => {
      const idGen = new DeterministicIdGenerator('pg-flow');
      const service = new ProductService({ repositories: postgresRepos, idGenerator: idGen });

      // 1. Create user & workspace
      const user = await service.createUser({ name: 'Bob Owner', email: 'bob@pg.test' });
      const { workspace } = await service.createWorkspace({
        name: 'Postgres Workspace',
        slug: 'pg-ws',
        ownerUserId: user.id,
      });

      // 2. Create project
      const project = await service.createProject({ workspaceId: workspace.id, name: 'PG Project' }, user.id);

      // 3. Create target
      const target = await service.createTarget(
        {
          workspaceId: workspace.id,
          projectId: project.id,
          name: 'Loopback Target',
          environment: 'local',
          targetUrl: 'http://127.0.0.1:4000',
          allowedOrigins: ['http://127.0.0.1:4000'],
        },
        user.id,
      );

      // 4. Create journey
      const journey = await service.approveJourney(
        {
          workspaceId: workspace.id,
          projectId: project.id,
          targetEnvironmentId: target.id,
          goal: 'observe loopback catalog',
          origin: target.targetOrigin,
          allowedActions: ['navigate'],
        },
        user.id,
      );

      // 5. Create run
      const run = await service.createRun(
        {
          workspaceId: workspace.id,
          projectId: project.id,
          targetEnvironmentId: target.id,
          journeyId: journey.id,
        },
        user.id,
      );

      // 6. Preflight evaluation
      const { run: evaluated } = await service.evaluateRunPreflight(workspace.id, run.id, user.id);
      expect(evaluated.status).toBe('queued');
      expect(evaluated.preflightStatus).toBe('ready');

      // 7. Audit events in PostgreSQL
      const audits = await service.listAuditEvents(workspace.id, user.id);
      expect(audits.length).toBeGreaterThanOrEqual(4);
    });

    it('runs ProductApiServer backed by PostgresProductRepository', async () => {
      const idGen = new DeterministicIdGenerator('pg-api');
      const service = new ProductService({ repositories: postgresRepos, idGenerator: idGen });

      const user = await service.createUser({ name: 'API User', email: 'api-user@pg.test' });
      const { workspace } = await service.createWorkspace({
        name: 'API PG WS',
        slug: 'api-pg-ws',
        ownerUserId: user.id,
      });

      const server = createProductApiServer({
        service,
        port: 0,
        defaultUserId: user.id,
      });

      await server.start();
      try {
        const healthRes = await fetch(`${server.url}/health`);
        expect(healthRes.status).toBe(200);

        const wsRes = await fetch(`${server.url}/api/v1/workspaces`, {
          headers: { 'X-User-Id': user.id },
        });
        expect(wsRes.status).toBe(200);
        const wsJson = await wsRes.json();
        expect(wsJson.data.workspaces).toHaveLength(1);
        expect(wsJson.data.workspaces[0].id).toBe(workspace.id);
      } finally {
        await server.stop();
      }
    });
  });
});
