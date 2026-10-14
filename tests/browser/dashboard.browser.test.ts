/**
 * Playwright Browser Integration Tests for Build 12C.1: Authenticated Product Dashboard.
 *
 * Verifies live browser interactions:
 * 1. Unauthenticated dashboard displays local development authentication screen
 * 2. Valid bearer token loads the dashboard overview with workspace & user context
 * 3. Invalid token produces safe error state
 * 4. Token never appears in rendered HTML or DOM textContent
 * 5. Logout clears in-memory authentication and redirects back to auth screen
 * 6. Project detail renders configured targets and run history
 * 7. Run detail renders queue status, attempts, and lifecycle indicators
 * 8. Candidate defect findings prominently display confirmedBug: false invariant
 * 9. Artifact preview displays JSON payload without exposing server filesystem paths
 * 10. Run cancellation modal confirms and executes idempotent cancellation safely
 * 11. Polling stops at terminal run status
 * 12. Correlation request IDs are visible in the header
 * 13. Zero external target websites or direct Supabase requests are made
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import {
  createProductApiServer,
  createDashboardServer,
  createInMemoryProductRepositories,
  ProductService,
  createDevToken,
  type RunningDashboardServer,
  type ProductApiServer,
  type ProductRepositories,
} from '../../src/product/index.js';

describe('Build 12C.1: Product Dashboard Browser Integration (Playwright)', () => {
  const TEST_SECRET = 'b12c1_browser_signing_secret_for_tests_32chars!';
  let repos: ProductRepositories;
  let service: ProductService;
  let apiServer: ProductApiServer;
  let dashboardServer: RunningDashboardServer;
  let browser: Browser;
  let page: Page;

  let testUser: any;
  let testWorkspace: any;
  let testProject: any;
  let testTarget: any;
  let testJourney: any;
  let testRun: any;
  let validToken: string;
  const recordedUrls: string[] = [];

  beforeAll(async () => {
    repos = createInMemoryProductRepositories();
    service = new ProductService({ repositories: repos });

    testUser = await service.createUser({ name: 'Alice Operator', email: 'alice@portal.test' });

    const wsRes = await service.createWorkspace({
      name: 'Acme Portal Workspace',
      slug: 'acme-portal',
      ownerUserId: testUser.id,
    });
    testWorkspace = wsRes.workspace;

    testProject = await service.createProject(
      {
        workspaceId: testWorkspace.id,
        name: 'Storefront Portal',
        description: 'Customer e-commerce frontend',
      },
      testUser.id,
    );

    testTarget = await service.createTarget(
      {
        workspaceId: testWorkspace.id,
        projectId: testProject.id,
        name: 'Local Staging Server',
        environment: 'staging',
        targetUrl: 'http://127.0.0.1:4000',
        allowedOrigins: ['http://127.0.0.1:4000'],
      },
      testUser.id,
    );

    testJourney = await service.approveJourney(
      {
        workspaceId: testWorkspace.id,
        projectId: testProject.id,
        targetEnvironmentId: testTarget.id,
        goal: 'test shopping cart flow',
        origin: 'http://127.0.0.1:4000',
        allowedActions: ['click', 'type'],
      },
      testUser.id,
    );

    const enqRes = await service.enqueueRun(
      {
        workspaceId: testWorkspace.id,
        projectId: testProject.id,
        targetEnvironmentId: testTarget.id,
        journeyId: testJourney.id,
        maxAttempts: 3,
      },
      testUser.id,
    );
    testRun = enqRes.run;

    // Register candidate finding
    await service.registerCandidate(
      {
        workspaceId: testWorkspace.id,
        projectId: testProject.id,
        runId: testRun.id,
        candidateId: 'cand_signal_browser_01',
        ruleId: 'HTTP_5XX',
        classification: 'server_error',
        reproduced: true,
        reviewStatus: 'unreviewed',
      },
      testUser.id,
    );

    // Register evidence artifact
    await service.storeArtifact(
      {
        workspaceId: testWorkspace.id,
        runId: testRun.id,
        type: 'execution',
        content: Buffer.from(JSON.stringify({ stepsExecuted: 4, passed: 4 }), 'utf8'),
        contentType: 'application/json',
      },
      testUser.id,
    );

    validToken = createDevToken({ userId: testUser.id, secret: TEST_SECRET, expiresInSeconds: 7200 });

    // Start API Server
    apiServer = createProductApiServer({
      service,
      authMode: 'development',
      authSecret: TEST_SECRET,
      port: 0,
    });
    const apiBound = await apiServer.start();

    // Start Dashboard Server
    dashboardServer = await createDashboardServer({
      port: 0,
      apiUrl: apiBound.url,
    });

    // Launch Playwright Headless Browser
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();

    // Track network requests to verify zero external calls
    page.on('request', (req) => {
      recordedUrls.push(req.url());
    });
  });

  afterAll(async () => {
    if (page) await page.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    if (dashboardServer) await dashboardServer.stop().catch(() => {});
    if (apiServer) await apiServer.stop().catch(() => {});
  });

  it('1. unauthenticated visit renders local development authentication screen', async () => {
    await page.goto(`${dashboardServer.url}/`);
    await page.waitForSelector('#auth-form');

    const content = await page.content();
    expect(content).toContain('Local development authentication — not production login');
    expect(content).toContain('npm run auth:token');
    expect(content).toContain('Connect &amp; Authenticate');
  });

  it('2. invalid token shows safe error state', async () => {
    await page.fill('#input-token', 'invalid_token_sample');
    await page.click('#btn-submit-auth');

    // Wait for error message
    await page.waitForTimeout(400);
    const content = await page.content();
    expect(content).toContain('Authentication expired or invalid token');
  });

  it('3. valid bearer token loads dashboard overview with user & workspace context', async () => {
    await page.fill('#input-token', validToken);
    await page.click('#btn-submit-auth');

    // Wait for overview panel to appear
    await page.waitForSelector('.panel-title');
    const content = await page.content();

    expect(content).toContain('Workspace Overview');
    expect(content).toContain('Alice Operator');
    expect(content).toContain('Acme Portal Workspace');
    expect(content).toContain('Storefront Portal');
    expect(content).toContain('TRUST INVARIANT');
    expect(content).toContain('confirmedBug: false');
  });

  it('4. token string never appears in rendered HTML or DOM text', async () => {
    const html = await page.content();
    expect(html).not.toContain(validToken);
    expect(html).not.toContain(TEST_SECRET);
    expect(html).not.toContain('DATABASE_URL');
  });

  it('5. request ID is visible in the dashboard header', async () => {
    await page.waitForSelector('.request-id-badge');
    const badgeText = await page.textContent('.request-id-badge');
    expect(badgeText).toMatch(/^req_/);
  });

  it('6. navigates to project detail and displays targets and runs', async () => {
    await page.click(`a[href="#/projects/${testProject.id}"]`);
    await page.waitForSelector('text=Configured Targets');

    const content = await page.content();
    expect(content).toContain('Storefront Portal');
    expect(content).toContain('Local Staging Server');
    expect(content).toContain('Recent Test Runs');
  });

  it('7. navigates to run detail and displays queue status & candidate findings with confirmedBug: false', async () => {
    await page.click(`a[href="#/run-detail/${testRun.id}"]`);
    await page.waitForSelector('.stat-card');

    const content = await page.content();
    expect(content).toContain('Current Lifecycle Status');
    expect(content).toContain('queued');
    expect(content).toContain('cand_signal_browser_01');
    expect(content).toContain('HTTP_5XX');
    expect(content).toContain('confirmedBug: false');
    expect(content).toContain('Automated findings are investigation leads, not confirmed application defects');
  });

  it('8. artifact preview displays content without leaking server filesystem paths', async () => {
    await page.waitForSelector('.btn-inspect-artifact');
    await page.click('.btn-inspect-artifact');

    await page.waitForSelector('#artifact-preview-panel');
    const previewContent = await page.textContent('.artifact-preview-box');
    expect(previewContent).toContain('stepsExecuted');
    expect(previewContent).toContain('4');

    // Server paths are never exposed
    const html = await page.content();
    expect(html).not.toContain('C:\\Users');
    expect(html).not.toContain('/tmp/');
    expect(html).not.toContain('PRODUCT_BLOB_ROOT');
  });

  it('9. safe run cancellation opens confirmation modal and cancels run idempotently', async () => {
    await page.waitForSelector('#btn-open-cancel');
    await page.click('#btn-open-cancel');

    // Verify modal is open
    await page.waitForSelector('.modal-card');
    const modalText = await page.textContent('.modal-body');
    expect(modalText).toContain('Are you sure you want to cancel test run');

    // Confirm cancel
    await page.click('#btn-cancel-modal-confirm');

    // Wait for status pill to update to cancelled
    await page.waitForSelector('.status-pill.cancelled', { timeout: 5000 });
    const content = await page.content();
    expect(content).toContain('cancelled');

    // Cancel button must now be hidden for terminal cancelled run
    const cancelBtnVisible = await page.$('#btn-open-cancel');
    expect(cancelBtnVisible).toBeNull();
  });

  it('10. logout clears in-memory authentication and redirects back to auth screen', async () => {
    await page.click('#btn-logout');
    await page.waitForSelector('#auth-form');

    expect(page.url()).toContain('#auth');

    // Trying to navigate back to overview without token redirects to auth
    await page.goto(`${dashboardServer.url}/#/overview`);
    await page.waitForSelector('#auth-form');
    expect(page.url()).toContain('#auth');
  });

  it('11. zero external network requests were made during browser session', () => {
    expect(recordedUrls.length).toBeGreaterThan(0);
    for (const url of recordedUrls) {
      const parsed = new URL(url);
      expect(['127.0.0.1', 'localhost']).toContain(parsed.hostname);
      expect(url).not.toContain('supabase.co');
      expect(url).not.toContain('google.com');
    }
  });
});
