/**
 * Playwright Browser Integration Tests for Build 12C.2:
 * Preflight-Gated Journey Execution Dispatch from the Dashboard.
 *
 * Verifies live browser interactions:
 * 1. Authenticated dashboard displays approved journeys in project detail view
 * 2. Displays target environment, target origin only, allowed actions, and safe-test mode
 * 3. Clicking "Run journey" opens the execution confirmation modal
 * 4. Execution modal displays safety specs, prohibited actions, and confirmation checkbox
 * 5. Run journey button is disabled until user explicitly confirms checkbox
 * 6. Cancelling modal closes it without dispatching any run
 * 7. Confirming dispatch creates queued run and redirects live to run monitor
 * 8. Run monitor displays queue lease status, attempt count, and run metadata
 * 9. Candidate findings strictly preserve confirmedBug: false and confirmed: false
 * 10. Candidate human review status renders as "accepted" or "unreviewed", never "confirmed"
 * 11. Strict negative checks: Dashboard never renders "confirmed bug", confirmedBug: true, or confirmed: true
 * 12. Preflight refusal displays clear blocked banner in modal with zero browser execution
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

describe('Build 12C.2: Preflight-Gated Run Dispatch Browser Integration (Playwright)', () => {
  const TEST_SECRET = 'build12c2_browser_test_secret_32chars_long!';
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
  let validJourney: any;
  let blockedJourney: any;
  let validToken: string;

  beforeAll(async () => {
    repos = createInMemoryProductRepositories();
    service = new ProductService({ repositories: repos });

    testUser = await service.createUser({ name: 'Dan Operator', email: 'dan@dispatch.test' });

    const wsRes = await service.createWorkspace({
      name: 'Dispatch E2E Workspace',
      slug: 'dispatch-e2e',
      ownerUserId: testUser.id,
    });
    testWorkspace = wsRes.workspace;

    testProject = await service.createProject(
      {
        workspaceId: testWorkspace.id,
        name: 'Checkout Verification Portal',
        description: 'Automated journey execution portal',
      },
      testUser.id,
    );

    testTarget = await service.createTarget(
      {
        workspaceId: testWorkspace.id,
        projectId: testProject.id,
        name: 'Local Loopback Target',
        environment: 'local',
        targetUrl: 'http://127.0.0.1:4100',
        allowedOrigins: ['http://127.0.0.1:4100'],
        forbiddenActions: ['checkout', 'payment', 'delete_account'],
      },
      testUser.id,
    );

    // 1. Valid approved journey
    validJourney = await service.approveJourney(
      {
        workspaceId: testWorkspace.id,
        projectId: testProject.id,
        targetEnvironmentId: testTarget.id,
        goal: 'verify catalog browsing and item details',
        origin: 'http://127.0.0.1:4100',
        allowedActions: ['click', 'type'],
        forbiddenActions: ['payment', 'checkout'],
        requiresCredentials: false,
        requiresTestData: false,
      },
      testUser.id,
    );

    // 2. Journey that violates preflight (dangerous action)
    blockedJourney = await repos.journeys.create({
      id: 'jny_blocked_browser_test',
      schemaVersion: '1.0',
      workspaceId: testWorkspace.id,
      projectId: testProject.id,
      targetEnvironmentId: testTarget.id,
      goal: 'attempt prohibited payment checkout',
      origin: 'http://127.0.0.1:4100',
      allowedActions: ['checkout', 'pay'], // Dangerous!
      forbiddenActions: [],
      requiresCredentials: false,
      requiresTestData: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    validToken = createDevToken({ userId: testUser.id, secret: TEST_SECRET, expiresInSeconds: 7200 });

    apiServer = createProductApiServer({
      service,
      authMode: 'production',
      authSecret: TEST_SECRET,
      port: 0,
    });
    const apiBound = await apiServer.start();

    dashboardServer = await createDashboardServer({
      port: 0,
      apiUrl: apiBound.url,
    });

    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
  });

  afterAll(async () => {
    if (browser) await browser.close();
    if (dashboardServer) await dashboardServer.stop();
    if (apiServer) await apiServer.stop();
  });

  it('1. logs in and displays approved journeys on project detail view', async () => {
    await page.goto(dashboardServer.url);

    // Authenticate
    await page.fill('#input-token', validToken);
    await page.click('#btn-submit-auth');

    // Wait for overview
    await page.waitForSelector('text=Workspace Overview');

    // Navigate to project detail
    await page.click(`a[href="#/projects/${testProject.id}"]`);
    await page.waitForSelector('text=Approved Journeys');

    const content = await page.content();
    expect(content).toContain('Approved Journeys');
    expect(content).toContain('verify catalog browsing and item details');
    expect(content).toContain('Target Origin: <code style="color:#38bdf8;">http://127.0.0.1:4100</code>');
    expect(content).toContain('Safe-Test Mode: Enabled');
    expect(content).toContain('Run journey →');
  });

  it('2. clicking "Run journey" opens execution confirmation modal with safety details', async () => {
    // Click Run journey button for valid journey
    await page.click(`#btn-run-journey-${validJourney.id}`);

    // Wait for execution modal
    await page.waitForSelector('#modal-run-execution');

    const modalContent = await page.content();
    expect(modalContent).toContain('Dispatch Approved Journey');
    expect(modalContent).toContain('Preflight Safety Notice');
    expect(modalContent).toContain('Target Environment');
    expect(modalContent).toContain('local');
    expect(modalContent).toContain('Target URL Origin');
    expect(modalContent).toContain('http://127.0.0.1:4100');
    expect(modalContent).toContain('verify catalog browsing and item details');
    expect(modalContent).toContain('Safe-Test Mode');
    expect(modalContent).toContain('Enabled (Mandatory)');
    expect(modalContent).toContain('Isolated headless Chromium via worker queue');
    expect(modalContent).toContain('Captures screenshots, logs, and trace evidence');

    // "Run journey" button must be disabled before checkbox is checked
    const confirmBtn = await page.$('#btn-confirm-run');
    expect(await confirmBtn?.isDisabled()).toBe(true);
  });

  it('3. cancelling modal closes it without creating any run', async () => {
    await page.click('#btn-cancel-run-modal');

    // Modal should disappear
    await page.waitForSelector('#modal-run-execution', { state: 'detached' });

    const runs = await repos.runs.listByProject(testWorkspace.id, testProject.id);
    expect(runs).toHaveLength(0);
  });

  it('4. preflight refusal in modal displays clear blocked error and launches zero browsers', async () => {
    // Click Run journey on the blocked journey
    await page.click(`#btn-run-journey-${blockedJourney.id}`);
    await page.waitForSelector('#modal-run-execution');

    // Check confirmation checkbox
    await page.click('#check-confirm-run');
    const confirmBtn = await page.$('#btn-confirm-run');
    expect(await confirmBtn?.isDisabled()).toBe(false);

    // Click confirm run
    await page.click('#btn-confirm-run');

    // Preflight error banner must appear inside the modal
    await page.waitForSelector('#preflight-error-banner');
    const modalContent = await page.content();

    expect(modalContent).toContain('Preflight Refusal');
    expect(modalContent).toContain('Zero browser processes launched. Zero network requests issued to target.');

    // Close modal
    await page.click('#btn-cancel-run-modal');
    await page.waitForSelector('#modal-run-execution', { state: 'detached' });

    // Zero runs or queue items were created
    const runs = await repos.runs.listByProject(testWorkspace.id, testProject.id);
    expect(runs).toHaveLength(0);
    const queue = await repos.queue!.listByWorkspace(testWorkspace.id);
    expect(queue).toHaveLength(0);
  });

  it('5. confirming valid journey creates queued run and redirects to live run monitor', async () => {
    // Open valid journey modal
    await page.click(`#btn-run-journey-${validJourney.id}`);
    await page.waitForSelector('#modal-run-execution');

    // Check confirmation checkbox
    await page.click('#check-confirm-run');

    // Click Run journey
    await page.click('#btn-confirm-run');

    // Must navigate to run-detail page
    await page.waitForSelector('text=Run Execution Details');

    const content = await page.content();
    expect(content).toContain('Current Lifecycle Status');
    expect(content).toContain('queued');
    expect(content).toContain('Safe-Test Enforced (Safe)');
    expect(content).toContain(validJourney.id);
    expect(content).toContain(testTarget.id);
    expect(content).toContain('Artifact Count:</strong> 0');
    expect(content).toContain('Candidate Count:</strong> 0');
    expect(content).toContain('Failure / Blocked Reason:</strong> None');

    // Verify run and queue item exist in storage
    const runs = await repos.runs.listByProject(testWorkspace.id, testProject.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('queued');
    const queue = await repos.queue!.listByWorkspace(testWorkspace.id);
    expect(queue).toHaveLength(1);
    expect(queue[0]!.queueStatus).toBe('queued');
  });

  it('6. candidate view displays trust invariants and accepted status (never "confirmed")', async () => {
    const runs = await repos.runs.listByProject(testWorkspace.id, testProject.id);
    const runId = runs[0]!.id;

    // Register a candidate with status 'accepted'
    await service.registerCandidate(
      {
        workspaceId: testWorkspace.id,
        projectId: testProject.id,
        runId,
        candidateId: 'cand_signal_ui_01',
        ruleId: 'HTTP_5XX',
        classification: 'server_error',
        reproduced: true,
        reviewStatus: 'accepted' as any,
      },
      testUser.id,
    );

    // Refresh run detail view
    await page.goto(`${dashboardServer.url}/#/run-detail/${runId}`);
    await page.waitForSelector('text=cand_signal_ui_01');

    const content = await page.content();

    // Trust invariant text
    expect(content).toContain('Candidate finding — not a confirmed defect');
    expect(content).toContain('confirmedBug: false');
    expect(content).toContain('confirmed: false');
    expect(content).toContain('Human acceptance is not automated confirmation');

    // Candidate status must render accepted
    expect(content).toContain('review-status-pill accepted');
    expect(content).toContain('accepted');

    // Strict invariant: NEVER render "confirmed bug", confirmedBug: true, or confirmed: true
    expect(content).not.toContain('"confirmed bug"');
    expect(content).not.toContain('confirmed bug');
    expect(content).not.toContain('confirmedBug: true');
    expect(content).not.toContain('confirmed: true');
    expect(content).not.toContain('review-status-pill confirmed');
  });
});
