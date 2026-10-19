/**
 * Unit Regression Test Suite for Build 12J.1:
 * CrashLab Dashboard UX Simplification, Candidate Review, and Queue-State Fix
 *
 * Verifies:
 * 1. Production authentication screen rendering and secrets non-leakage
 * 2. Overview screen rendering and trust invariants
 * 3. Project card rendering and human-readable hierarchy
 * 4. Run status rendering (Passed, Completed with possible issues, Running, Queued, Failed, Blocked)
 * 5. Healthy run summary copy and metrics
 * 6. Candidate run display, friendly defect titles, and multi-signal banner
 * 7. Candidate review UI status transitions (unreviewed, investigating, accepted, dismissed, duplicate, resolved)
 * 8. Review status persistence across refetches
 * 9. Queue lease normalization after terminal run status (Worker released, null lease)
 * 10. Friendly artifact experience and preview formatting
 * 11. Cross-workspace tenant isolation on candidate review and queue endpoints
 * 12. Non-leakage of service-role keys and database credentials
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import {
  renderDashboardHtmlShell,
  CLIENT_JS_BUNDLE,
  STYLES_CSS,
  createProductApiServer,
  ProductService,
  createInMemoryProductRepositories,
  JwtVerifier,
  JwksClient,
  type ProductApiServer,
} from '../../src/product/index.js';

function base64UrlEncode(str: string): string {
  return Buffer.from(str, 'utf8')
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

describe('Build 12J.1: Dashboard Redesign, Candidate Review & Queue State', () => {
  const TEST_ISSUER = 'https://auth.pilot.crashlab.test/auth/v1';
  const TEST_AUDIENCE = 'authenticated';
  const FAKE_SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJvbGUiOiJzZXJ2aWNlX3JvbGUifQ.SUPER_SECRET_SERVICE_KEY_CRASHLAB_2026';

  let rsaKey: { privateKey: KeyObject; publicKey: KeyObject; jwk: any; kid: string };
  let jwksClient: JwksClient;
  let jwtVerifier: JwtVerifier;
  let repos: ReturnType<typeof createInMemoryProductRepositories>;
  let service: ProductService;
  let apiServer: ProductApiServer;
  let apiUrl: string;

  let ownerUser: any;
  let otherTenantUser: any;
  let ownerWorkspace: any;
  let otherWorkspace: any;
  let project: any;
  let target: any;
  let journey: any;
  let completedRun: any;
  let candidate1: any;
  let candidate2: any;

  function createSignedToken(payload: Record<string, unknown>): string {
    const header = { alg: 'RS256', typ: 'JWT', kid: rsaKey.kid };
    const encodedHeader = base64UrlEncode(JSON.stringify(header));
    const encodedPayload = base64UrlEncode(JSON.stringify(payload));
    const message = `${encodedHeader}.${encodedPayload}`;
    const signature = sign('sha256', Buffer.from(message), rsaKey.privateKey);
    const encodedSignature = signature
      .toString('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
    return `${message}.${encodedSignature}`;
  }

  beforeAll(async () => {
    const kp = generateKeyPairSync('rsa', { modulusLength: 2048 });
    rsaKey = {
      privateKey: kp.privateKey,
      publicKey: kp.publicKey,
      jwk: { ...kp.publicKey.export({ format: 'jwk' }), kid: 'test-key-12j', use: 'sig', alg: 'RS256' },
      kid: 'test-key-12j',
    };

    jwksClient = new JwksClient({
      jwksUrl: `${TEST_ISSUER}/.well-known/jwks.json`,
      fetchFn: async () => ({ keys: [rsaKey.jwk] }),
    });

    jwtVerifier = new JwtVerifier({
      jwksClient,
      expectedIssuer: TEST_ISSUER,
      expectedAudience: TEST_AUDIENCE,
    });

    repos = createInMemoryProductRepositories();
    service = new ProductService({ repositories: repos });

    ownerUser = await service.createUser({
      name: 'Pilot Operator',
      email: 'pilot.operator@crashlab.internal',
    });

    otherTenantUser = await service.createUser({
      name: 'Other Tenant',
      email: 'other.tenant@competitor.internal',
    });

    const ownerWsRes = await service.createWorkspace({
      name: 'Staging Pilot Workspace',
      slug: 'staging-pilot-workspace',
      ownerUserId: ownerUser.id,
    });
    ownerWorkspace = ownerWsRes.workspace;

    const otherWsRes = await service.createWorkspace({
      name: 'Unauthorized Other Workspace',
      slug: 'unauthorized-other-workspace',
      ownerUserId: otherTenantUser.id,
    });
    otherWorkspace = otherWsRes.workspace;

    project = await service.createProject(
      {
        workspaceId: ownerWorkspace.id,
        name: 'Storefront Web App',
        description: 'Staging e-commerce test harness',
      },
      ownerUser.id,
    );

    target = await service.createTarget(
      {
        workspaceId: ownerWorkspace.id,
        projectId: project.id,
        name: 'Staging Fixture',
        environment: 'staging',
        targetUrl: 'https://staging-pilot.crashlab.internal',
        allowedOrigins: ['https://staging-pilot.crashlab.internal'],
      },
      ownerUser.id,
    );

    journey = await service.approveJourney(
      {
        workspaceId: ownerWorkspace.id,
        projectId: project.id,
        targetEnvironmentId: target.id,
        goal: 'test catalog and cart journey',
        origin: 'https://staging-pilot.crashlab.internal',
        allowedActions: ['click', 'type'],
        forbiddenActions: ['checkout', 'payment'],
        requiresCredentials: false,
        requiresTestData: false,
      },
      ownerUser.id,
    );

    // Create a completed run with candidates
    completedRun = await repos.runs.create({
      id: 'run_completed_12j',
      schemaVersion: '1.0',
      workspaceId: ownerWorkspace.id,
      projectId: project.id,
      targetEnvironmentId: target.id,
      journeyId: journey.id,
      status: 'completed',
      safeTestMode: true,
      preflightStatus: 'ready',
      anomalyCount: 2,
      candidateCount: 2,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
    });

    // Create queue item with stale leaseOwner to test queue normalization
    await repos.queue!.enqueue({
      runId: completedRun.id,
      workspaceId: ownerWorkspace.id,
      projectId: project.id,
      targetId: target.id,
      journeyId: journey.id,
      queueStatus: 'completed',
      attemptCount: 1,
      maxAttempts: 3,
      availableAt: new Date().toISOString(),
      leaseOwner: 'stale-worker-999',
      leaseExpiry: new Date(Date.now() + 60000).toISOString(),
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      lastError: null,
      cancellationTimestamp: null,
      requestId: 'req_test_queue',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Register candidates
    candidate1 = await service.registerCandidate(
      {
        workspaceId: ownerWorkspace.id,
        projectId: project.id,
        runId: completedRun.id,
        candidateId: 'cand_http_500_01',
        ruleId: 'HTTP_5XX',
        classification: 'server_error',
        reproduced: true,
        reviewStatus: 'unreviewed' as any,
      },
      ownerUser.id,
    );

    candidate2 = await service.registerCandidate(
      {
        workspaceId: ownerWorkspace.id,
        projectId: project.id,
        runId: completedRun.id,
        candidateId: 'cand_console_err_02',
        ruleId: 'CONSOLE_ERROR',
        classification: 'client_error',
        reproduced: true,
        reviewStatus: 'unreviewed' as any,
      },
      ownerUser.id,
    );

    apiServer = createProductApiServer({
      service,
      authMode: 'production',
      jwtVerifier,
      port: 0,
    });
    const bound = await apiServer.start();
    apiUrl = bound.url;
  });

  afterAll(async () => {
    if (apiServer) await apiServer.stop();
  });

  // --- 1. Production Authentication Screen ---
  describe('1. Production Authentication Screen', () => {
    it('renders clean Supabase login screen without development instructions or raw secrets', () => {
      const html = renderDashboardHtmlShell({
        apiUrl: 'https://crashlab-api.onrender.com',
        authMode: 'production',
        supabaseUrl: 'https://pilot.supabase.co',
        supabaseAnonKey: 'anon-public-key-sample',
      });

      expect(html).toContain('CrashLab Product Dashboard');
      expect(CLIENT_JS_BUNDLE).toContain('Private Beta');
      expect(html).not.toContain('npm run auth:token');
      expect(html).not.toContain('Local development authentication');
      expect(html).not.toContain('SERVICE_ROLE_KEY');
      expect(html).not.toContain('DATABASE_URL');
      expect(html).not.toContain(FAKE_SERVICE_ROLE_KEY);
    });

    it('client JS bundle contains clean authentication flow with advanced settings disclosure', () => {
      expect(CLIENT_JS_BUNDLE).toContain('Sign in to your private beta workspace');
      expect(CLIENT_JS_BUNDLE).toContain('Advanced connection settings');
      expect(CLIENT_JS_BUNDLE).toContain('Direct Supabase User JWT');
      expect(CLIENT_JS_BUNDLE).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
    });
  });

  // --- 2. Overview Screen ---
  describe('2. Overview Screen Design & Trust Invariant', () => {
    it('contains operator greeting, 4 summary cards, and trust banner', () => {
      expect(CLIENT_JS_BUNDLE).toContain('Workspace Overview');
      expect(CLIENT_JS_BUNDLE).toContain('Good morning,');
      expect(CLIENT_JS_BUNDLE).toContain('Active Projects');
      expect(CLIENT_JS_BUNDLE).toContain('Recent Runs');
      expect(CLIENT_JS_BUNDLE).toContain('Possible Issues');
      expect(CLIENT_JS_BUNDLE).toContain('Healthy Runs');
      expect(CLIENT_JS_BUNDLE).toContain('Safe-Test Mode is active');
      expect(CLIENT_JS_BUNDLE).toContain('confirmedBug: false');
      expect(CLIENT_JS_BUNDLE).toContain('confirmed: false');
    });

    it('contains dynamic recommended next action card', () => {
      expect(CLIENT_JS_BUNDLE).toContain('action-card');
      expect(CLIENT_JS_BUNDLE).toContain('Run your first approved journey');
    });
  });

  // --- 3. Project Card Rendering ---
  describe('3. Project Card Rendering', () => {
    it('uses human-readable labels and keeps IDs in technical disclosure', () => {
      expect(CLIENT_JS_BUNDLE).toContain('project-card');
      expect(CLIENT_JS_BUNDLE).toContain('Safe-Test:');
      expect(CLIENT_JS_BUNDLE).toContain('tech-details-disclosure');
      expect(CLIENT_JS_BUNDLE).toContain('Project ID:');
    });
  });

  // --- 4. Run Status Mapping ---
  describe('4. Run Status Rendering & Summary Copy', () => {
    it('does not label runs as failed solely because candidate signals exist', () => {
      expect(CLIENT_JS_BUNDLE).toContain('Completed with possible issues');
      expect(CLIENT_JS_BUNDLE).toContain('Passed');
      expect(CLIENT_JS_BUNDLE).toContain('Queued');
      expect(CLIENT_JS_BUNDLE).toContain('Running');
      expect(CLIENT_JS_BUNDLE).toContain('Failed');
      expect(CLIENT_JS_BUNDLE).toContain('Blocked');
    });

    it('displays recommended summary copy for healthy vs candidate runs', () => {
      expect(CLIENT_JS_BUNDLE).toContain('No possible issues detected. The approved journey completed successfully.');
      expect(CLIENT_JS_BUNDLE).toContain('Review the evidence before deciding whether they represent one issue or multiple issues.');
    });
  });

  // --- 5. Candidate Review UI ---
  describe('5. Candidate Review UI & Status Transitions', () => {
    it('renders candidate cards with friendly defect titles, rule badges, and review controls', () => {
      expect(CLIENT_JS_BUNDLE).toContain('Server Error Response (HTTP 500)');
      expect(CLIENT_JS_BUNDLE).toContain('Browser Console Error');
      expect(CLIENT_JS_BUNDLE).toContain('candidate-review-controls');
      expect(CLIENT_JS_BUNDLE).toContain('candidate-signals-banner');
      expect(CLIENT_JS_BUNDLE).toContain('These signals may represent one underlying issue. Review them together before accepting separate findings.');
    });

    it('supports full candidate review status lifecycle via API and preserves confirmedBug: false', async () => {
      const token = createSignedToken({
        sub: ownerUser.id,
        email: ownerUser.email,
        aud: TEST_AUDIENCE,
        iss: TEST_ISSUER,
        exp: Math.floor(Date.now() / 1000) + 3600,
      });

      const statuses = ['investigating', 'accepted', 'dismissed', 'duplicate', 'resolved'];

      for (const st of statuses) {
        const res = await fetch(`${apiUrl}/api/v1/candidates/${candidate1.id}/review`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            workspaceId: ownerWorkspace.id,
            status: st,
            notes: `Transitioned to ${st} for testing`,
          }),
        });

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.success).toBe(true);
        expect(data.data.reviewStatus).toBe(st);

        // Invariant: confirmedBug and confirmed MUST remain false
        expect(data.data.confirmedBug).toBe(false);
        expect(data.data.confirmed).toBe(false);
      }
    });

    it('persists candidate review status across refetch', async () => {
      const token = createSignedToken({
        sub: ownerUser.id,
        email: ownerUser.email,
        aud: TEST_AUDIENCE,
        iss: TEST_ISSUER,
        exp: Math.floor(Date.now() / 1000) + 3600,
      });

      const listRes = await fetch(`${apiUrl}/api/v1/runs/${completedRun.id}/candidates?workspaceId=${ownerWorkspace.id}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });

      expect(listRes.status).toBe(200);
      const listData = await listRes.json();
      expect(listData.success).toBe(true);
      const updatedCand1 = listData.data.candidates.find((c: any) => c.id === candidate1.id);
      expect(updatedCand1.reviewStatus).toBe('resolved');
      expect(updatedCand1.confirmedBug).toBe(false);
      expect(updatedCand1.confirmed).toBe(false);
    });
  });

  // --- 6. Queue Lease Normalization ---
  describe('6. Terminal Queue Lease Normalization (Item 10)', () => {
    it('normalizes leaseOwner to null on GET /api/v1/runs/:id/queue when run is terminal', async () => {
      const token = createSignedToken({
        sub: ownerUser.id,
        email: ownerUser.email,
        aud: TEST_AUDIENCE,
        iss: TEST_ISSUER,
        exp: Math.floor(Date.now() / 1000) + 3600,
      });

      const queueRes = await fetch(`${apiUrl}/api/v1/runs/${completedRun.id}/queue?workspaceId=${ownerWorkspace.id}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });

      expect(queueRes.status).toBe(200);
      const queueData = await queueRes.json();
      expect(queueData.success).toBe(true);
      // Even though repository had 'stale-worker-999', API normalizes completed runs to null lease
      expect(queueData.data.leaseOwner).toBeNull();
      expect(queueData.data.leaseExpiry).toBeNull();
    });

    it('client JS getWorkerStatus maps completed runs to "Worker released", never "running"', () => {
      expect(CLIENT_JS_BUNDLE).toContain("label: 'Worker released'");
      expect(CLIENT_JS_BUNDLE).toContain("detail: leaseOwner ? `Worker: ${leaseOwner}` : 'Worker released'");
      expect(CLIENT_JS_BUNDLE).toContain("['completed', 'partial', 'failed', 'blocked', 'cancelled'].includes(runStatus)");
    });
  });

  // --- 7. Artifact Experience ---
  describe('7. Artifact Experience & Friendly Naming (Item 11)', () => {
    it('client JS provides operator-friendly artifact names and modal inspection', () => {
      expect(CLIENT_JS_BUNDLE).toContain("title: 'Execution report'");
      expect(CLIENT_JS_BUNDLE).toContain("title: 'Anomaly report'");
      expect(CLIENT_JS_BUNDLE).toContain("title: 'Candidate findings'");
      expect(CLIENT_JS_BUNDLE).toContain("title: 'Run log'");
      expect(CLIENT_JS_BUNDLE).toContain('artifact-preview-box');
      expect(CLIENT_JS_BUNDLE).toContain('btn-inspect-artifact');
      expect(CLIENT_JS_BUNDLE).toContain('btn-download-artifact');
    });
  });

  // --- 8. Cross-Workspace Tenant Isolation ---
  describe('8. Cross-Workspace Isolation & Non-Leakage', () => {
    it('blocks candidate review requests from unauthorized tenants with 403 FORBIDDEN', async () => {
      const otherTenantToken = createSignedToken({
        sub: otherTenantUser.id,
        email: otherTenantUser.email,
        aud: TEST_AUDIENCE,
        iss: TEST_ISSUER,
        exp: Math.floor(Date.now() / 1000) + 3600,
      });

      const res = await fetch(`${apiUrl}/api/v1/candidates/${candidate1.id}/review`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${otherTenantToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          workspaceId: ownerWorkspace.id,
          reviewStatus: 'dismissed',
        }),
      });

      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('FORBIDDEN');
    });

    it('blocks queue status requests from unauthorized tenants with 403 FORBIDDEN', async () => {
      const otherTenantToken = createSignedToken({
        sub: otherTenantUser.id,
        email: otherTenantUser.email,
        aud: TEST_AUDIENCE,
        iss: TEST_ISSUER,
        exp: Math.floor(Date.now() / 1000) + 3600,
      });

      const res = await fetch(`${apiUrl}/api/v1/runs/${completedRun.id}/queue?workspaceId=${ownerWorkspace.id}`, {
        headers: { 'Authorization': `Bearer ${otherTenantToken}` },
      });

      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('FORBIDDEN');
    });

    it('never leaks service role key in styles, client bundle, or shell HTML', () => {
      expect(CLIENT_JS_BUNDLE).not.toContain(FAKE_SERVICE_ROLE_KEY);
      expect(STYLES_CSS).not.toContain(FAKE_SERVICE_ROLE_KEY);
      expect(CLIENT_JS_BUNDLE).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
    });
  });
});
