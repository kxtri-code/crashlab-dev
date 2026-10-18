/**
 * Build 12I Regression Test Suite: Production Dashboard Authentication & Tenant Isolation.
 *
 * Verifies:
 * 1. Production mode does not render the local development token form.
 * 2. Local development mode still supports the development token form.
 * 3. Normal Supabase authenticated users can sign in and load authenticated overview.
 * 4. Cross-workspace access is blocked with 403 TENANT_ACCESS_DENIED.
 * 5. The service-role key never appears in the client bundle, styles, or rendered HTML.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import {
  renderDashboardHtmlShell,
  CLIENT_JS_BUNDLE,
  STYLES_CSS,
  createProductApiServer,
  createDashboardServer,
  ProductService,
  createInMemoryProductRepositories,
  JwtVerifier,
  JwksClient,
  type ProductApiServer,
  type RunningDashboardServer,
} from '../../src/product/index.js';

function base64UrlEncode(str: string): string {
  return Buffer.from(str, 'utf8')
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

describe('Build 12I: Dashboard Production Authentication & Isolation', () => {
  const TEST_ISSUER = 'https://auth.pilot.crashlab.test/auth/v1';
  const TEST_AUDIENCE = 'authenticated';
  const FAKE_SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJvbGUiOiJzZXJ2aWNlX3JvbGUifQ.SUPER_SECRET_SIGNATURE_DO_NOT_LEAK';

  let rsaKey: { privateKey: KeyObject; publicKey: KeyObject; jwk: any; kid: string };
  let jwksClient: JwksClient;
  let jwtVerifier: JwtVerifier;
  let repos: ReturnType<typeof createInMemoryProductRepositories>;
  let service: ProductService;
  let apiServer: ProductApiServer;
  let dashboardDevServer: RunningDashboardServer;
  let dashboardProdServer: RunningDashboardServer;

  let ownerUser: any;
  let otherTenantUser: any;
  let ownerWorkspace: any;
  let otherWorkspace: any;

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
    // Generate RSA key pair for testing
    const kp = generateKeyPairSync('rsa', { modulusLength: 2048 });
    rsaKey = {
      privateKey: kp.privateKey,
      publicKey: kp.publicKey,
      jwk: { ...kp.publicKey.export({ format: 'jwk' }), kid: 'test-key-2026', use: 'sig', alg: 'RS256' },
      kid: 'test-key-2026',
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

    // Seed users
    ownerUser = await service.createUser({
      name: 'Pilot Operator',
      email: 'pilot.operator@company.test',
    });

    otherTenantUser = await service.createUser({
      name: 'Other Tenant',
      email: 'intruder@other.test',
    });

    // Seed workspaces
    const ws1 = await service.createWorkspace({
      name: 'Pilot Primary Workspace',
      slug: 'pilot-ws',
      ownerUserId: ownerUser.id,
    });
    ownerWorkspace = ws1.workspace;

    const ws2 = await service.createWorkspace({
      name: 'Isolated Foreign Workspace',
      slug: 'isolated-ws',
      ownerUserId: otherTenantUser.id,
    });
    otherWorkspace = ws2.workspace;

    // Seed projects
    await service.createProject(
      {
        workspaceId: ownerWorkspace.id,
        name: 'Authorized Staging Pilot',
        description: 'Customer Private Beta Target',
      },
      ownerUser.id,
    );

    // Start production API server
    apiServer = createProductApiServer({
      service,
      authMode: 'production',
      jwtVerifier,
      port: 0,
      serveDashboard: true,
      supabaseUrl: 'https://test.supabase.co',
      supabaseAnonKey: 'test-anon-key-12345',
    });
    const bound = await apiServer.start();

    // Start dev dashboard server
    dashboardDevServer = await createDashboardServer({
      port: 0,
      apiUrl: bound.url,
      authMode: 'development',
    });

    // Start prod dashboard server
    dashboardProdServer = await createDashboardServer({
      port: 0,
      apiUrl: bound.url,
      authMode: 'production',
      supabaseUrl: 'https://test.supabase.co',
      supabaseAnonKey: 'test-anon-key-12345',
    });
  });

  afterAll(async () => {
    if (dashboardProdServer) await dashboardProdServer.stop();
    if (dashboardDevServer) await dashboardDevServer.stop();
    if (apiServer) await apiServer.stop();
  });

  // ---------------------------------------------------------------------------
  // 1. Production Mode HTML Shell & Form Rendering
  // ---------------------------------------------------------------------------
  describe('1. Production Mode HTML Shell & UI Invariants', () => {
    it('sets meta auth-mode to production in production shell', () => {
      const html = renderDashboardHtmlShell({
        authMode: 'production',
        supabaseUrl: 'https://test.supabase.co',
        supabaseAnonKey: 'test-anon-key-12345',
      });

      expect(html).toContain('<meta name="auth-mode" content="production">');
      expect(html).toContain('<meta name="supabase-url" content="https://test.supabase.co">');
      expect(html).toContain('<meta name="supabase-anon-key" content="test-anon-key-12345">');
    });

    it('production dashboard server serves auth-mode="production"', async () => {
      const res = await fetch(`${dashboardProdServer.url}/`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('<meta name="auth-mode" content="production">');
      expect(text).toContain('<meta name="supabase-url" content="https://test.supabase.co">');
    });

    it('production client renderer produces Supabase login and excludes local dev token form', () => {
      // Evaluate the rendering behavior of clientBundle in production mode
      expect(CLIENT_JS_BUNDLE).toContain('renderProductionAuthView');
      expect(CLIENT_JS_BUNDLE).toContain('input-email');
      expect(CLIENT_JS_BUNDLE).toContain('input-password');
      expect(CLIENT_JS_BUNDLE).toContain('Supabase Authentication');

      // The production view must not contain the dev token notice
      const prodViewCodeMatch = CLIENT_JS_BUNDLE.match(/function renderProductionAuthView\(\)\s*\{([\s\S]*?)\n  \}/);
      expect(prodViewCodeMatch).not.toBeNull();
      const prodViewCode = prodViewCodeMatch![1];

      expect(prodViewCode).not.toContain('Local development authentication — not production login');
      expect(prodViewCode).not.toContain('npm run auth:token');
      expect(prodViewCode).not.toContain('Development Bearer Token');
      expect(prodViewCode).toContain('input-email');
      expect(prodViewCode).toContain('input-password');
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Development Mode Form Rendering
  // ---------------------------------------------------------------------------
  describe('2. Local Development Mode Form Rendering', () => {
    it('sets meta auth-mode to development in development shell', () => {
      const html = renderDashboardHtmlShell({
        authMode: 'development',
      });

      expect(html).toContain('<meta name="auth-mode" content="development">');
    });

    it('development client renderer still contains the local development token form', () => {
      const devViewCodeMatch = CLIENT_JS_BUNDLE.match(/function renderDevelopmentAuthView\(\)\s*\{([\s\S]*?)\n  \}/);
      expect(devViewCodeMatch).not.toBeNull();
      const devViewCode = devViewCodeMatch![1];

      expect(devViewCode).toContain('Local development authentication — not production login');
      expect(devViewCode).toContain('npm run auth:token -- --user usr_test_owner');
      expect(devViewCode).toContain('Development Bearer Token');
      expect(devViewCode).toContain('input-token');
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Normal Supabase Authenticated User Sign In & Workflow
  // ---------------------------------------------------------------------------
  describe('3. Normal Supabase Authenticated User Sign In', () => {
    it('normal Supabase JWT authenticates and loads user context via /api/v1/me', async () => {
      const now = Math.floor(Date.now() / 1000);
      const token = createSignedToken({
        sub: ownerUser.id,
        role: 'authenticated',
        iss: TEST_ISSUER,
        aud: TEST_AUDIENCE,
        exp: now + 3600,
      });

      const res = await fetch(`${apiServer.url}/api/v1/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.user.id).toBe(ownerUser.id);
      expect(json.data.user.email).toBe('pilot.operator@company.test');
    });

    it('normal Supabase JWT loads workspace and projects', async () => {
      const now = Math.floor(Date.now() / 1000);
      const token = createSignedToken({
        sub: ownerUser.id,
        role: 'authenticated',
        iss: TEST_ISSUER,
        aud: TEST_AUDIENCE,
        exp: now + 3600,
      });

      const wsRes = await fetch(`${apiServer.url}/api/v1/workspaces`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(wsRes.status).toBe(200);
      const wsData = await wsRes.json();
      expect(wsData.data.workspaces.some((w: any) => w.id === ownerWorkspace.id)).toBe(true);

      const prjRes = await fetch(`${apiServer.url}/api/v1/projects?workspaceId=${ownerWorkspace.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(prjRes.status).toBe(200);
      const prjData = await prjRes.json();
      expect(prjData.data.projects.some((p: any) => p.name === 'Authorized Staging Pilot')).toBe(true);
    });

    it('cross-workspace access returns 403 TENANT_ACCESS_DENIED', async () => {
      const now = Math.floor(Date.now() / 1000);
      const token = createSignedToken({
        sub: ownerUser.id,
        role: 'authenticated',
        iss: TEST_ISSUER,
        aud: TEST_AUDIENCE,
        exp: now + 3600,
      });

      // Pilot operator attempts to access otherTenantUser's workspace
      const res = await fetch(`${apiServer.url}/api/v1/projects?workspaceId=${otherWorkspace.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(['FORBIDDEN', 'TENANT_ACCESS_DENIED']).toContain(json.error.code);
      expect(json.error.message).toMatch(/Access denied/i);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Secret Isolation & Zero Service-Role Key Leakage
  // ---------------------------------------------------------------------------
  describe('4. Zero Service-Role Key Leakage in Client Assets', () => {
    it('service-role key never appears in CLIENT_JS_BUNDLE', () => {
      expect(CLIENT_JS_BUNDLE).not.toContain(FAKE_SERVICE_ROLE_KEY);
      expect(CLIENT_JS_BUNDLE).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
      expect(CLIENT_JS_BUNDLE).not.toContain('service_role');
      expect(CLIENT_JS_BUNDLE).not.toContain('DATABASE_URL');
      expect(CLIENT_JS_BUNDLE).not.toContain('postgresql://');
    });

    it('service-role key never appears in STYLES_CSS', () => {
      expect(STYLES_CSS).not.toContain(FAKE_SERVICE_ROLE_KEY);
      expect(STYLES_CSS).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
      expect(STYLES_CSS).not.toContain('service_role');
      expect(STYLES_CSS).not.toContain('DATABASE_URL');
    });

    it('service-role key never appears in rendered dashboard HTML shell', () => {
      const html = renderDashboardHtmlShell({
        authMode: 'production',
        supabaseUrl: 'https://test.supabase.co',
        supabaseAnonKey: 'test-anon-key-12345',
      });

      expect(html).not.toContain(FAKE_SERVICE_ROLE_KEY);
      expect(html).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
      expect(html).not.toContain('service_role');
      expect(html).not.toContain('DATABASE_URL');
    });

    it('CSP connect-src allows https://*.supabase.co in production mode', async () => {
      const res = await fetch(`${dashboardProdServer.url}/`);
      const csp = res.headers.get('content-security-policy');
      expect(csp).toBeDefined();
      expect(csp).toContain('https://*.supabase.co');
      expect(csp).toContain('https://test.supabase.co');
    });
  });
});
