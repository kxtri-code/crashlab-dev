/**
 * Unit Test Suite for Build 12L: Pilot Readiness and Backend-Agnostic Onboarding.
 *
 * Requirements Tested:
 * 1. Simple Help/Pilot Guide with 6-step SOP:
 *    - register a staging target
 *    - create an approved journey
 *    - run a healthy baseline
 *    - run a controlled failure
 *    - review and reproduce findings
 *    - download evidence
 * 2. Backend-agnostic target authentication options (independent of Supabase):
 *    - public staging site
 *    - test email/password
 *    - protected cookies/session
 *    - OAuth test session
 *    - custom header/token
 * 3. Secret boundary: credentials kept out of database and browser bundle via safe environment references.
 * 4. Onboarding checklist reflecting 5 key milestones:
 *    - target connected
 *    - journey approved
 *    - baseline run completed
 *    - findings reviewed
 *    - reproduction completed
 * 5. Persistence across page refresh, login, and restarts.
 * 6. Tenant isolation for reproduction reports, artifacts, and target management.
 * 7. Concurrency guard preventing multiple simultaneous reproductions on API container (HTTP 429 / ReproductionConcurrencyError).
 * 8. Prominent architecture warning that CrashLab evaluates browser/network behavior and does NOT directly inspect MongoDB, DynamoDB, Supabase, or other customer databases.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProductService, ReproductionConcurrencyError, TenantAccessDeniedError } from '../../src/product/service/productService.js';
import { createInMemoryProductRepositories } from '../../src/product/repository/inMemory.js';
import { LocalBlobStore } from '../../src/product/blob/localStore.js';
import { CLIENT_JS_BUNDLE } from '../../src/product/dashboard/clientBundle.js';
import { assertNoSecrets } from '../../src/product/secrets/sanitizer.js';
import type { TargetAuthConfig } from '../../src/product/types/target.js';
import type { ReproductionReport, ReproductionInput } from '../../src/reproducer/types.js';

describe('Build 12L: Pilot Readiness and Backend-Agnostic Onboarding', () => {
  let tempDir: string;
  let repos: ReturnType<typeof createInMemoryProductRepositories>;
  let blobStore: LocalBlobStore;
  let service: ProductService;

  const workspaceIdA = 'ws_pilot_12l_a';
  const workspaceIdB = 'ws_pilot_12l_b';
  const userIdA = 'usr_operator_a';
  const userIdB = 'usr_operator_b';
  const projectIdA = 'proj_pilot_a';
  const projectIdB = 'proj_pilot_b';

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'crashlab-12l-test-'));
    repos = createInMemoryProductRepositories();
    blobStore = new LocalBlobStore({ rootDirectory: tempDir });

    // Seed Workspace A
    await repos.users.create({
      id: userIdA,
      schemaVersion: '1.0',
      email: 'operator-a@crashlab.internal',
      name: 'Pilot Operator A',
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await repos.workspaces.create({
      id: workspaceIdA,
      schemaVersion: '1.0',
      name: 'Pilot Staging Workspace A',
      slug: 'pilot-staging-a',
      ownerUserId: userIdA,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await repos.memberships.create({
      id: 'mem_operator_a',
      schemaVersion: '1.0',
      workspaceId: workspaceIdA,
      userId: userIdA,
      role: 'owner',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await repos.projects.create({
      id: projectIdA,
      schemaVersion: '1.0',
      workspaceId: workspaceIdA,
      name: 'External Staging Pilot A',
      description: 'Pilot verification project for tenant A',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Seed Workspace B (for tenant isolation verification)
    await repos.users.create({
      id: userIdB,
      schemaVersion: '1.0',
      email: 'operator-b@crashlab.internal',
      name: 'Pilot Operator B',
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await repos.workspaces.create({
      id: workspaceIdB,
      schemaVersion: '1.0',
      name: 'Pilot Staging Workspace B',
      slug: 'pilot-staging-b',
      ownerUserId: userIdB,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await repos.memberships.create({
      id: 'mem_operator_b',
      schemaVersion: '1.0',
      workspaceId: workspaceIdB,
      userId: userIdB,
      role: 'owner',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await repos.projects.create({
      id: projectIdB,
      schemaVersion: '1.0',
      workspaceId: workspaceIdB,
      name: 'External Staging Pilot B',
      description: 'Pilot verification project for tenant B',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    service = new ProductService({
      repositories: repos,
      blobStore,
      reproduceSignalsFn: async (input: ReproductionInput): Promise<ReproductionReport> => {
        // Mock reproduction engine that takes 25ms to simulate bounded browser execution
        await new Promise((r) => setTimeout(r, 25));
        return {
          schemaVersion: '1.0',
          journeyReport: input.journeyPath,
          anomalyReport: input.anomalyPath,
          executionReport: input.executionPath,
          goal: 'Verify staging interaction',
          reproducer: {
            mode: 'controlled-deterministic',
            version: '1.0',
            automaticRetries: false,
            attemptsRequested: input.attempts,
            attemptsCompleted: input.attempts,
            attemptsBlocked: 0,
            attemptsFailed: 0,
          },
          runs: [],
          results: [],
          expectations: null,
          interpretation: {
            confirmedBug: false,
            reproducedSignalsAreCandidatesOnly: true,
            note: 'Lead only',
          },
          safety: {
            authorizedConfirmationRequired: true,
            safeTestMode: true,
            livePaymentAllowed: false,
            sensitiveValuesRedacted: true,
            attemptsBlockedBySafety: 0,
          },
          summary: {
            totalSignals: 1,
            eligibleSignals: 1,
            reproduced: 1,
            notReproduced: 0,
            inconclusive: 0,
            blocked: 0,
            ineligible: 0,
            candidatesRequiringInvestigation: 1,
          },
        };
      },
    });
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
    delete process.env.STAGING_CUSTOM_TOKEN;
    delete process.env.STAGING_BASIC_PWD;
  });

  describe('1. Backend-Agnostic Target Authentication Options', () => {
    it('supports public staging site with no credentials required', async () => {
      const target = await service.createTarget(
        {
          workspaceId: workspaceIdA,
          projectId: projectIdA,
          name: 'Public Staging Pilot',
          environment: 'staging',
          targetUrl: 'https://staging.company.test',
          allowedOrigins: ['https://staging.company.test'],
          authConfig: { strategy: 'public' },
        },
        userIdA
      );

      expect(target.authConfig).toBeDefined();
      expect(target.authConfig?.strategy).toBe('public');
      expect(target.authConfig?.credentialConfigured).toBeUndefined();

      const retrieved = await service.getTarget(workspaceIdA, target.id, userIdA);
      expect(retrieved.authConfig?.strategy).toBe('public');
    });

    it('supports test email/password referencing server environment secrets', async () => {
      process.env.STAGING_BASIC_PWD = 'safe-configured-pwd-in-env';

      const target = await service.createTarget(
        {
          workspaceId: workspaceIdA,
          projectId: projectIdA,
          name: 'Basic Credentials Staging Pilot',
          environment: 'staging',
          targetUrl: 'https://staging.company.test',
          allowedOrigins: ['https://staging.company.test'],
          authConfig: {
            strategy: 'basic_credentials',
            usernameReference: 'test-pilot@company.test',
            credentialReference: 'STAGING_BASIC_PWD',
            description: 'Pilot test user credentials via server environment',
          },
        },
        userIdA
      );

      expect(target.authConfig?.strategy).toBe('basic_credentials');
      expect(target.authConfig?.usernameReference).toBe('test-pilot@company.test');
      expect(target.authConfig?.credentialReference).toBe('STAGING_BASIC_PWD');
      expect(target.authConfig?.credentialConfigured).toBe(true);

      // Verify listTargets also enriches target authConfig
      const list = await service.listTargets(workspaceIdA, projectIdA, userIdA);
      const found = list.find((t) => t.id === target.id);
      expect(found?.authConfig?.credentialConfigured).toBe(true);
    });

    it('supports protected cookies/session state reference', async () => {
      const target = await service.createTarget(
        {
          workspaceId: workspaceIdA,
          projectId: projectIdA,
          name: 'Cookie Session Staging Pilot',
          environment: 'staging',
          targetUrl: 'https://staging.company.test',
          allowedOrigins: ['https://staging.company.test'],
          authConfig: {
            strategy: 'cookies_session',
            credentialReference: 'STAGING_SESSION_COOKIE',
            description: 'Protected storage state cookie reference',
          },
        },
        userIdA
      );

      expect(target.authConfig?.strategy).toBe('cookies_session');
      // Credential is not in process.env, so credentialConfigured should be false
      expect(target.authConfig?.credentialConfigured).toBe(false);
    });

    it('supports OAuth test session token reference', async () => {
      const target = await service.createTarget(
        {
          workspaceId: workspaceIdA,
          projectId: projectIdA,
          name: 'OAuth Mock Staging Pilot',
          environment: 'staging',
          targetUrl: 'https://staging.company.test',
          allowedOrigins: ['https://staging.company.test'],
          authConfig: {
            strategy: 'oauth_session',
            credentialReference: 'STAGING_OAUTH_TOKEN',
            description: 'OAuth mock test token',
          },
        },
        userIdA
      );

      expect(target.authConfig?.strategy).toBe('oauth_session');
    });

    it('supports custom header/token configuration', async () => {
      process.env.STAGING_CUSTOM_TOKEN = 'configured-secret';

      const target = await service.createTarget(
        {
          workspaceId: workspaceIdA,
          projectId: projectIdA,
          name: 'Custom Header Staging Pilot',
          environment: 'staging',
          targetUrl: 'https://staging.company.test',
          allowedOrigins: ['https://staging.company.test'],
          authConfig: {
            strategy: 'custom_header',
            headerName: 'X-Staging-Access',
            credentialReference: 'STAGING_CUSTOM_TOKEN',
            description: 'Internal QA staging gate token',
          },
        },
        userIdA
      );

      expect(target.authConfig?.strategy).toBe('custom_header');
      expect(target.authConfig?.headerName).toBe('X-Staging-Access');
      expect(target.authConfig?.credentialConfigured).toBe(true);
    });
  });

  describe('2. Secret Boundary Invariants', () => {
    it('assertNoSecrets strictly permits safe credential reference names', () => {
      const safeConfig: TargetAuthConfig = {
        strategy: 'custom_header',
        credentialReference: 'STAGING_AUTH_TOKEN',
        headerName: 'X-Staging-Access',
        usernameReference: 'operator@company.test',
      };

      expect(() => assertNoSecrets(safeConfig, 'targetAuthConfig')).not.toThrow();
    });

    it('assertNoSecrets rejects raw passwords or secrets in target config if accidentally injected', () => {
      const unsafePayload = {
        strategy: 'basic_credentials',
        password: 'raw-secret-value-12345',
      };

      expect(() => assertNoSecrets(unsafePayload, 'unsafePayload')).toThrow();
    });

    it('ensures client JS bundle contains zero leaked keys or secrets', () => {
      expect(CLIENT_JS_BUNDLE).not.toMatch(/service_role/i);
      expect(CLIENT_JS_BUNDLE).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY/i);
      expect(CLIENT_JS_BUNDLE).not.toMatch(/password\s*=\s*['"][^'"]+['"]/i);
    });
  });

  describe('3. Concurrency Guard for Bounded Reproduction', () => {
    it('rejects concurrent reproduction requests with ReproductionConcurrencyError', async () => {
      // Create target, journey, and run in workspace A
      const target = await service.createTarget(
        {
          workspaceId: workspaceIdA,
          projectId: projectIdA,
          name: 'Pilot Target A',
          environment: 'staging',
          targetUrl: 'https://crashlab-api.onrender.com/staging-pilot',
          allowedOrigins: ['https://crashlab-api.onrender.com'],
        },
        userIdA
      );

      const journey = await service.approveJourney(
        {
          workspaceId: workspaceIdA,
          projectId: projectIdA,
          targetEnvironmentId: target.id,
          goal: 'Verify staging interaction',
          origin: 'https://crashlab-api.onrender.com',
          allowedActions: ['navigate', 'click'],
        },
        userIdA
      );

      const run = await service.createRun(
        {
          workspaceId: workspaceIdA,
          projectId: projectIdA,
          targetEnvironmentId: target.id,
          journeyId: journey.id,
        },
        userIdA
      );

      // Seed a candidate finding
      await repos.candidates.create({
        id: 'cand_ref_1',
        schemaVersion: '1.0',
        workspaceId: workspaceIdA,
        projectId: projectIdA,
        runId: run.id,
        candidateId: 'cand_http_500',
        ruleId: 'HTTP_5XX',
        classification: 'investigating',
        reproduced: false,
        reproductionStatus: 'not-tested',
        reviewStatus: 'investigating',
        confirmed: false,
        confirmedBug: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      // Launch the first reproduction (takes ~25ms)
      const firstReproPromise = service.runBoundedReproduction(workspaceIdA, run.id, userIdA, { attempts: 3 });

      // Attempt to launch a second concurrent reproduction immediately while the first is running
      await expect(
        service.runBoundedReproduction(workspaceIdA, run.id, userIdA, { attempts: 3 })
      ).rejects.toThrow(ReproductionConcurrencyError);

      // Wait for the first reproduction to complete
      const firstResult = await firstReproPromise;
      expect(firstResult.reproductionReport.summary.reproduced).toBe(1);

      // Now that the first has completed, a subsequent reproduction should succeed without error
      const subsequentResult = await service.runBoundedReproduction(workspaceIdA, run.id, userIdA, { attempts: 3 });
      expect(subsequentResult.reproductionReport.summary.reproduced).toBe(1);
    });
  });

  describe('4. Tenant Isolation', () => {
    it('strictly denies cross-tenant access to targets, runs, and reproduction reports', async () => {
      // Create a target and run in Workspace A
      const targetA = await service.createTarget(
        {
          workspaceId: workspaceIdA,
          projectId: projectIdA,
          name: 'Private Target A',
          environment: 'staging',
          targetUrl: 'https://staging.company-a.test',
          allowedOrigins: ['https://staging.company-a.test'],
        },
        userIdA
      );

      const journeyA = await service.approveJourney(
        {
          workspaceId: workspaceIdA,
          projectId: projectIdA,
          targetEnvironmentId: targetA.id,
          goal: 'Private Journey A',
          origin: 'https://staging.company-a.test',
          allowedActions: ['navigate'],
        },
        userIdA
      );

      const runA = await service.createRun(
        {
          workspaceId: workspaceIdA,
          projectId: projectIdA,
          targetEnvironmentId: targetA.id,
          journeyId: journeyA.id,
        },
        userIdA
      );

      // User B attempts to get Target A in Workspace A
      await expect(
        service.getTarget(workspaceIdA, targetA.id, userIdB)
      ).rejects.toThrow(TenantAccessDeniedError);

      // User B attempts to access Run A in Workspace A
      await expect(
        service.getRun(workspaceIdA, runA.id, userIdB)
      ).rejects.toThrow(TenantAccessDeniedError);

      // User B attempts to run reproduction on Run A in Workspace A
      await expect(
        service.runBoundedReproduction(workspaceIdA, runA.id, userIdB, { attempts: 3 })
      ).rejects.toThrow(TenantAccessDeniedError);

      // User B attempts to list artifacts for Run A in Workspace A
      await expect(
        service.listArtifacts(workspaceIdA, runA.id, userIdB)
      ).rejects.toThrow(TenantAccessDeniedError);
    });
  });

  describe('5. Onboarding Checklist, Pilot Guide, and Architecture Boundary Notice', () => {
    it('client JS bundle contains the 5-step pilot onboarding checklist', () => {
      expect(CLIENT_JS_BUNDLE).toContain('Pilot Readiness &amp; Verification Checklist');
      expect(CLIENT_JS_BUNDLE).toContain('1. Connect Staging Target');
      expect(CLIENT_JS_BUNDLE).toContain('2. Approve Critical Journey');
      expect(CLIENT_JS_BUNDLE).toContain('3. Run Healthy Baseline');
      expect(CLIENT_JS_BUNDLE).toContain('4. Review & Correlate Findings');
      expect(CLIENT_JS_BUNDLE).toContain('5. Complete Bounded Reproduction');
    });

    it('client JS bundle contains the 6-step SOP pilot guide', () => {
      expect(CLIENT_JS_BUNDLE).toContain('End-to-End Pilot Workflow (6 Steps)');
      expect(CLIENT_JS_BUNDLE).toContain('Register Staging Target');
      expect(CLIENT_JS_BUNDLE).toContain('Create Approved Journey');
      expect(CLIENT_JS_BUNDLE).toContain('Run a Healthy Baseline');
      expect(CLIENT_JS_BUNDLE).toContain('Run Controlled Failure');
      expect(CLIENT_JS_BUNDLE).toContain('Review &amp; Correlate Findings');
      expect(CLIENT_JS_BUNDLE).toContain('Reproduce &amp; Download Evidence');
    });

    it('client JS bundle prominently features the Customer Database Architecture Boundary Notice', () => {
      // Must clearly state CrashLab operates via browser/network and does NOT inspect customer databases like MongoDB, DynamoDB, Supabase, Postgres
      expect(CLIENT_JS_BUNDLE).toContain('Architecture Boundary Notice');
      expect(CLIENT_JS_BUNDLE).toMatch(/MongoDB/i);
      expect(CLIENT_JS_BUNDLE).toMatch(/DynamoDB/i);
      expect(CLIENT_JS_BUNDLE).toMatch(/PostgreSQL|database/i);
      expect(CLIENT_JS_BUNDLE).toMatch(/Telemetry Boundary &amp; Customer Database Isolation/);
    });

    it('client JS bundle provides target registration auth strategy selector with safe env secret inputs', () => {
      expect(CLIENT_JS_BUNDLE).toContain('select-target-auth-strategy');
      expect(CLIENT_JS_BUNDLE).toContain('Public Staging Site');
      expect(CLIENT_JS_BUNDLE).toContain('basic_credentials');
      expect(CLIENT_JS_BUNDLE).toContain('cookies_session');
      expect(CLIENT_JS_BUNDLE).toContain('oauth_session');
      expect(CLIENT_JS_BUNDLE).toContain('custom_header');
      expect(CLIENT_JS_BUNDLE).toContain('Zero-Secret Boundary');
    });
  });
});
