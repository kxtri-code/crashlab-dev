/**
 * Playwright Browser Integration Tests for Review UI (Build 9.2).
 *
 * Verifies:
 *  - Overview page loads with summary metrics, read-only indicator, and trust invariants
 *  - Interactive candidate list and filtering by classification and review status
 *  - Candidate detail view with strict 4-way separation
 *  - Interactive CLI command snippet generator and copy button
 *  - Candidate history timeline (with events and empty unreviewed state)
 *  - Baseline registry and run context views
 *  - XSS injection prevention (malicious payloads are rendered safely escaped)
 *  - Read-only network guarantee: zero mutation requests (POST/PUT/DELETE) sent by browser
 *  - Backing artifact immutability: all reports and files remain byte-identical
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium, type Browser, type Page } from 'playwright';
import { createReviewApiServer, type RunningReviewApiServer } from '../../src/reviewApi/server.js';
import { createReviewUiServer } from '../../src/reviewUi/staticServer.js';
import type { RunningReviewUiServer } from '../../src/reviewUi/types.js';

async function sha256File(path: string): Promise<string> {
  const content = await readFile(path);
  return createHash('sha256').update(content).digest('hex');
}

async function hashDirectoryFiles(dir: string): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile()) {
      const fullPath = join(entry.parentPath || dir, entry.name);
      hashes.set(fullPath, await sha256File(fullPath));
    }
  }
  return hashes;
}

describe('Review UI: Browser Integration (Playwright)', () => {
  let tempDir: string;
  let apiServer: RunningReviewApiServer;
  let uiServer: RunningReviewUiServer;
  let browser: Browser;
  let page: Page;
  let fileHashesBefore: Map<string, string>;
  const recordedMethods: string[] = [];

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'crashlab-ui-browser-'));
    const reportsDir = join(tempDir, 'reports');
    const reviewStateDir = join(reportsDir, 'review-state');
    const baselinesDir = join(reportsDir, 'baselines');
    await mkdir(reviewStateDir, { recursive: true });
    await mkdir(baselinesDir, { recursive: true });

    // 1. Candidate report with test data including an XSS attempt payload
    const candidatesPath = join(reportsDir, 'candidates.json');
    const candidateReport = {
      schemaVersion: '1.0',
      baseline: { baselineId: 'base-browser-001', report: 'reports/baselines/base-browser-001.json' },
      current: {
        executionReport: 'reports/execution.json',
        anomalyReport: 'reports/anomalies.json',
        reproductionReport: 'reports/reproduction.json',
        journeyReport: 'reports/journey.json',
      },
      comparison: {
        classification: 'same-environment',
        targetOrigin: 'https://browser.test',
        journeyHash: 'sha256:11112222',
        environmentFingerprint: 'sha256:33334444',
        differences: [],
        reason: null,
      },
      baselineVerification: {
        status: 'complete',
        coverage: 'full-plan',
        unverifiedAssertions: 0,
      },
      comparisonLimitations: ['Deterministic fixture testing only.'],
      summary: {
        totalSignals: 3,
        novel: 2,
        reintroduced: 1,
        persistent: 0,
        resolved: 0,
        changed: 0,
        unknown: 0,
        crossEnvironment: 0,
        differentBuild: 0,
        reproducedSignals: 2,
      },
      candidates: [
        {
          id: 'candidate-001',
          candidateId: 'cand-0000000000000001',
          signalKeyHash: 'key-hash-1',
          ruleId: 'http-status-500',
          kind: 'http',
          classification: 'novel',
          reproduced: true,
          baselinePresent: false,
          currentPresent: true,
          environmentComparison: 'same-environment',
          requiresInvestigation: true,
          reproductionClassification: 'consistent',
          stepOrder: 1,
          evidence: {
            currentAnomalyIds: ['anom-001'],
            reproductionResultIds: ['repro-001'],
            baselineSignalKeys: [],
            relatedBaselineSignalKey: null,
          },
          message: 'Server responded with HTTP 500 Internal Server Error',
          knownLimitations: [],
          confirmed: false,
        },
        {
          id: 'candidate-002',
          candidateId: 'cand-0000000000000002',
          signalKeyHash: 'key-hash-2',
          ruleId: 'console-error',
          kind: 'console',
          classification: 'novel',
          reproduced: false,
          baselinePresent: false,
          currentPresent: true,
          environmentComparison: 'same-environment',
          requiresInvestigation: true,
          reproductionClassification: null,
          stepOrder: 2,
          evidence: {
            currentAnomalyIds: ['anom-002'],
            reproductionResultIds: [],
            baselineSignalKeys: [],
            relatedBaselineSignalKey: null,
          },
          message: 'Uncaught TypeError: Cannot read properties of undefined',
          knownLimitations: ['Intermittent console error'],
          confirmed: false,
        },
        {
          id: 'candidate-003',
          candidateId: 'cand-0000000000000003',
          signalKeyHash: 'key-hash-3',
          ruleId: 'page-error',
          kind: 'page-error',
          classification: 'reintroduced',
          reproduced: true,
          baselinePresent: true,
          currentPresent: true,
          environmentComparison: 'same-environment',
          requiresInvestigation: true,
          reproductionClassification: 'consistent',
          stepOrder: 3,
          evidence: {
            currentAnomalyIds: ['anom-003'],
            reproductionResultIds: ['repro-003'],
            baselineSignalKeys: ['base-sig-3'],
            relatedBaselineSignalKey: 'base-sig-3',
          },
          message: '<script>window.__xss_executed=true;</script><img src=x onerror="window.__xss_img_executed=true;"> Malicious payload test',
          knownLimitations: [],
          confirmed: false,
        },
      ],
    };
    await writeFile(candidatesPath, JSON.stringify(candidateReport, null, 2), 'utf-8');

    // 2. Review State events and projection
    const eventsPath = join(reviewStateDir, 'events.jsonl');
    const event1 = {
      schemaVersion: '1.0',
      eventId: 'evt-browser-001',
      candidateId: 'cand-0000000000000001',
      revision: 1,
      previousRevision: 0,
      previousStatus: null,
      newStatus: 'open',
      reviewer: 'qa-tester',
      note: 'Initial triage in progress',
      duplicateOf: null,
      reason: null,
      timestamp: '2026-10-11T12:00:00.000Z',
      sourceCandidate: {
        report: 'reports/candidates.json',
        candidateId: 'cand-0000000000000001',
        signalKeyHash: 'key-hash-1',
        ruleId: 'http-status-500',
      },
      automaticClassification: 'novel',
      confirmed: false,
      confirmedBug: false,
    };
    await writeFile(eventsPath, JSON.stringify(event1) + '\n', 'utf-8');

    const statePath = join(reviewStateDir, 'state.json');
    const stateDoc = {
      schemaVersion: '1.0',
      generatedAt: '2026-10-11T12:00:00.000Z',
      eventCount: 1,
      lastEventId: 'evt-browser-001',
      candidateCount: 1,
      candidates: {
        'cand-0000000000000001': {
          candidateId: 'cand-0000000000000001',
          currentStatus: 'open',
          revision: 1,
          firstSeenAt: '2026-10-11T12:00:00.000Z',
          lastUpdatedAt: '2026-10-11T12:00:00.000Z',
          reviewer: 'qa-tester',
          latestNote: 'Initial triage in progress',
          duplicateOf: null,
          history: [
            {
              eventId: 'evt-browser-001',
              revision: 1,
              previousStatus: null,
              newStatus: 'open',
              reviewer: 'qa-tester',
              note: 'Initial triage in progress',
              duplicateOf: null,
              reason: null,
              timestamp: '2026-10-11T12:00:00.000Z',
              confirmed: false,
            },
          ],
        },
      },
    };
    await writeFile(statePath, JSON.stringify(stateDoc, null, 2), 'utf-8');

    // 3. Baseline document
    const baselinePath = join(baselinesDir, 'base-browser-001.json');
    const baselineDoc = {
      schemaVersion: '1.0',
      baselineId: 'base-browser-001',
      name: 'Browser Test Baseline',
      status: 'known-good',
      createdAt: '2026-10-11T10:00:00.000Z',
      confirmation: {
        explicit: true,
        confirmedBy: 'operator',
        acceptedSignalIds: [],
      },
      source: {
        executionReport: 'reports/execution.json',
        anomalyReport: 'reports/anomalies.json',
        journeyReport: 'reports/journey.json',
      },
      identity: {
        targetOrigin: 'https://browser.test',
        journeyHash: 'sha256:11112222',
        journeySchemaVersion: '1.0',
        journeyType: 'linear',
        environmentFingerprint: 'sha256:33334444',
        environmentId: null,
        applicationBuildId: 'build-v1',
        plannerVersion: '0.1.0',
        executorVersion: '0.1.0',
      },
      knownSignals: [],
      safety: {
        safeTestMode: true,
        livePaymentAllowed: false,
        executionHadFailures: false,
        executionIncomplete: false,
      },
      verification: {
        complete: true,
        coverage: 'full-plan',
        unverifiedAssertions: 0,
        operatorApproved: false,
      },
      lineage: {
        parentBaselineId: null,
        rootBaselineId: 'base-browser-001',
        depth: 0,
        ancestors: [],
        truncated: false,
      },
      signalsSummary: {
        totalSignals: 1,
        acceptedSignals: 1,
        rules: ['page-error'],
      },
      rationale: 'Verified baseline for browser integration suite.',
      interpretation: {
        confirmedBug: false,
        automaticSeverity: false,
        note: 'Baseline records known-good state.',
      },
    };
    await writeFile(baselinePath, JSON.stringify(baselineDoc, null, 2), 'utf-8');

    const indexDoc = {
      schemaVersion: '1.0',
      baselines: [
        {
          baselineId: 'base-browser-001',
          name: 'Browser Test Baseline',
          report: 'reports/baselines/base-browser-001.json',
          createdAt: '2026-10-11T10:00:00.000Z',
          targetOrigin: 'https://browser.test',
          environmentFingerprint: 'sha256:33334444',
          journeyHash: 'sha256:11112222',
          status: 'known-good',
          verificationCoverage: 'full-plan',
          applicationBuildId: 'build-v1',
        },
      ],
    };
    await writeFile(join(baselinesDir, 'index.json'), JSON.stringify(indexDoc, null, 2), 'utf-8');

    // 4. Execution report
    const executionPath = join(reportsDir, 'execution.json');
    const execDoc = {
      schemaVersion: '1.0',
      runId: 'exec-browser-001',
      status: 'completed',
      target: { url: 'https://browser.test/app' },
      targetUrl: 'https://browser.test/app',
      targetOrigin: 'https://browser.test',
      journeyHash: 'sha256:11112222',
      applicationBuildId: 'build-v1',
      environmentFingerprint: 'sha256:33334444',
      steps: [
        { index: 1, action: 'navigate', target: 'https://browser.test/app', status: 'passed' },
        { index: 2, action: 'click', target: '#submit-btn', status: 'passed' },
      ],
      stepCounts: { total: 2, passed: 2, failed: 0, skipped: 0, blocked: 0 },
      anomalies: [
        { id: 'anom-001', ruleId: 'http-status-500', kind: 'http' },
        { id: 'anom-002', ruleId: 'console-error', kind: 'console' },
        { id: 'anom-003', ruleId: 'page-error', kind: 'page-error' },
      ],
      verification: { complete: true, coverage: 'full-plan', unverifiedAssertions: 0 },
      confirmedBug: false,
    };
    await writeFile(executionPath, JSON.stringify(execDoc, null, 2), 'utf-8');

    // 5. Reproduction report
    const reproductionPath = join(reportsDir, 'reproduction.json');
    const reproDoc = {
      schemaVersion: '1.0',
      reproductionRunId: 'repro-browser-001',
      status: 'completed',
      totalAttempted: 3,
      reproducedCount: 2,
      summary: { totalAttempted: 3, reproduced: 2, notReproduced: 1, inconclusive: 0, blocked: 0 },
      results: [
        { id: 'repro-1', ruleId: 'http-status-500', classification: 'reproduced' },
        { id: 'repro-2', ruleId: 'page-error', classification: 'reproduced' },
        { id: 'repro-3', ruleId: 'console-error', classification: 'not-reproduced' },
      ],
      stepCounts: { total: 2, passed: 2, failed: 0, skipped: 0, blocked: 0 },
      provenance: {
        targetOrigin: 'https://browser.test',
        journeyHash: 'sha256:11112222',
        applicationBuildId: 'build-v1',
        environmentFingerprint: 'sha256:33334444',
      },
    };
    await writeFile(reproductionPath, JSON.stringify(reproDoc, null, 2), 'utf-8');

    // Capture pre-session file hashes
    fileHashesBefore = await hashDirectoryFiles(tempDir);

    // Start backing Review API server
    const apiInstance = await createReviewApiServer({
      host: '127.0.0.1',
      port: 0,
      paths: {
        candidatesPath,
        reviewStateDir,
        baselinesDir,
        executionPath,
        reproductionPath,
      },
    });
    apiServer = await apiInstance.start();

    // Start Review UI server proxying to apiServer
    uiServer = await createReviewUiServer({
      host: '127.0.0.1',
      port: 0,
      apiUrl: apiServer.url,
      noOpen: true,
    });

    // Launch Playwright browser
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    page = await context.newPage();

    page.on('console', (msg) => console.log('BROWSER CONSOLE:', msg.text()));
    page.on('pageerror', (err) => console.log('BROWSER PAGE ERROR:', err));

    // Listen to network requests to ensure NO mutations are sent
    page.on('request', (req) => {
      recordedMethods.push(req.method().toUpperCase());
    });
  });

  afterAll(async () => {
    if (browser) await browser.close();
    if (uiServer) await uiServer.stop();
    if (apiServer) await apiServer.stop();
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('Overview view: loads UI, displays READ-ONLY badge, metrics, and trust invariants', async () => {
    await page.goto(`${uiServer.url}/#/`);
    await page.waitForSelector('#readonly-indicator');

    // Verify Read-Only badge is present and visible
    const badge = page.locator('#readonly-indicator');
    expect(await badge.isVisible()).toBe(true);
    expect((await badge.textContent())?.trim()).toBe('READ-ONLY');

    // Verify Trust Invariant banner is displayed
    const banner = page.locator('.banner-invariant');
    expect(await banner.isVisible()).toBe(true);
    const bannerText = await banner.textContent();
    expect(bannerText).toContain('confirmedBug: false');
    expect(bannerText).toContain('confirmed: false');

    // Verify Metric numbers match our fixture summary
    const totalEl = page.locator('#metric-total-candidates');
    expect((await totalEl.textContent())?.trim()).toBe('3');

    const novelEl = page.locator('#metric-novel-candidates');
    expect((await novelEl.textContent())?.trim()).toBe('2');

    const unreviewedEl = page.locator('#metric-unreviewed-candidates');
    expect((await unreviewedEl.textContent())?.trim()).toBe('2'); // cand-002 and cand-003 are unreviewed

    const reproEl = page.locator('#metric-reproduced-candidates');
    expect((await reproEl.textContent())?.trim()).toBe('2');
  });

  it('Candidates view: lists candidates and supports interactive filtering', async () => {
    // Navigate to candidates view
    await page.click('a[href="#/candidates"]');
    await page.waitForSelector('#candidates-table');

    // Verify all 3 candidates rendered
    const rows = page.locator('#candidates-table tbody tr');
    expect(await rows.count()).toBe(3);

    // Verify candidate IDs
    const text = await page.textContent('#candidates-table');
    expect(text).toContain('cand-0000000000000001');
    expect(text).toContain('candidate-001');
    expect(text).toContain('cand-0000000000000002');
    expect(text).toContain('cand-0000000000000003');

    // Filter by classification: "reintroduced"
    await page.selectOption('#filter-classification', 'reintroduced');
    await page.waitForTimeout(200);

    // Only cand-0000000000000003 is reintroduced
    expect(await page.locator('#candidates-table tbody tr').count()).toBe(1);
    const filteredText = await page.textContent('#candidates-table');
    expect(filteredText).toContain('cand-0000000000000003');
    expect(filteredText).not.toContain('cand-0000000000000001');

    // Reset filters
    await page.click('#btn-reset-filters');
    await page.waitForTimeout(200);
    expect(await page.locator('#candidates-table tbody tr').count()).toBe(3);
  });

  it('Candidate detail view: displays strict 4-way visual separation', async () => {
    // Click inspect on cand-0000000000000001
    await page.click('a[data-candidate-id="cand-0000000000000001"]');
    await page.waitForSelector('#panel-calculated-result');

    // 1. Automatic Calculated Result panel
    const panel1 = page.locator('#panel-calculated-result');
    expect(await panel1.isVisible()).toBe(true);
    const p1Text = await panel1.textContent();
    expect(p1Text).toContain('http-status-500');
    expect(p1Text).toContain('novel');
    expect(p1Text).toContain('Reproduced');

    // 2. Human Review State panel
    const panel2 = page.locator('#panel-human-review-state');
    expect(await panel2.isVisible()).toBe(true);
    const p2Text = await panel2.textContent();
    expect(p2Text).toContain('open');
    expect(p2Text).toContain('qa-tester');
    expect(p2Text).toContain('Initial triage in progress');

    // 3. Supporting Evidence & Provenance panel
    const panel3 = page.locator('#panel-supporting-evidence');
    expect(await panel3.isVisible()).toBe(true);
    const p3Text = await panel3.textContent();
    expect(p3Text).toContain('Server responded with HTTP 500');
    expect(p3Text).toContain('https://browser.test');

    // 4. Limitations & Invariants panel
    const panel4 = page.locator('#panel-limitations-invariants');
    expect(await panel4.isVisible()).toBe(true);
    const p4Text = await panel4.textContent();
    expect(p4Text).toContain('confirmedBug: false');
    expect(p4Text).toContain('confirmed: false');
  });

  it('CLI command generator: updates snippet and provides interactive copy feedback', async () => {
    // Change transition status to "accepted"
    await page.selectOption('#cli-status-select', 'accepted');

    // Fill reviewer and notes
    await page.fill('#cli-reviewer-input', 'alice-qa');
    await page.fill('#cli-notes-input', 'Confirmed expected behavior');

    // Check snippet preview updates
    const snippet = page.locator('#cli-command-preview');
    expect((await snippet.textContent())?.trim()).toBe(
      'npm run review-state -- --candidate cand-0000000000000001 --status accepted --reviewer "alice-qa" --notes "Confirmed expected behavior"',
    );

    // Click copy button
    await page.click('#btn-copy-cli');
    await page.waitForSelector('#copy-confirmation:not(.hidden)');

    // Check confirmation feedback appears
    const confirm = page.locator('#copy-confirmation');
    expect(await confirm.isVisible()).toBe(true);
    expect((await confirm.textContent())?.trim()).toBe('✓ Copied to clipboard! Run this in your terminal.');
  });

  it('Candidate history view: renders timeline and handles unreviewed candidates', async () => {
    // Navigate to candidate 1 history
    await page.click('#btn-view-history');
    await page.waitForSelector('#history-timeline');

    const timelineText = await page.textContent('#history-timeline');
    expect(timelineText).toContain('evt-browser-001');
    expect(timelineText).toContain('qa-tester');
    expect(timelineText).toContain('unreviewed → open');

    // Navigate to unreviewed candidate 2 history
    await page.goto(`${uiServer.url}/#/candidates/cand-0000000000000002/history`);
    await page.waitForSelector('#empty-history-notice');

    const emptyNotice = page.locator('#empty-history-notice');
    expect(await emptyNotice.isVisible()).toBe(true);
    expect(await emptyNotice.textContent()).toMatch(
      /Unreviewed Candidate[\s\S]*No human review decisions have been recorded yet/,
    );
  });

  it('Baselines and Runs views: renders registry and execution provenance', async () => {
    // Baselines view
    await page.click('a[href="#/baselines"]');
    await page.waitForSelector('#baselines-table');
    const baseText = await page.textContent('#baselines-table');
    expect(baseText).toContain('base-browser-001');
    expect(baseText).toContain('Browser Test Baseline');

    // Runs view
    await page.click('a[href="#/runs"]');
    await page.waitForSelector('#panel-current-run');
    const runText = await page.textContent('#panel-current-run');
    expect(runText).toContain('completed');
    expect(runText).toContain('https://browser.test');

    const reproText = await page.textContent('#panel-repro-run');
    expect(reproText).toContain('2 reproduced');
  });

  it('XSS prevention: escapes malicious scripts and payloads safely without execution', async () => {
    // Candidate 3 contains: <script>window.__xss_executed=true;</script>
    await page.goto(`${uiServer.url}/#/candidates/cand-0000000000000003`);
    await page.waitForSelector('#panel-supporting-evidence');

    // Verify window.__xss_executed was NOT set
    const xssExecuted = await page.evaluate(() => (window as unknown as { __xss_executed?: boolean }).__xss_executed);
    expect(xssExecuted).toBeUndefined();

    const imgExecuted = await page.evaluate(() => (window as unknown as { __xss_img_executed?: boolean }).__xss_img_executed);
    expect(imgExecuted).toBeUndefined();

    // Verify message is visible as safe text inside pre element
    const preview = page.locator('.message-preview');
    const text = await preview.textContent();
    expect(text).toContain('<script>window.__xss_executed=true;</script>');
  });

  it('Read-only guarantee: zero mutation requests sent and backing files remain 100% byte-identical', async () => {
    // 1. Check all recorded network methods
    expect(recordedMethods.length).toBeGreaterThan(0);
    for (const method of recordedMethods) {
      expect(['GET', 'HEAD']).toContain(method);
      expect(['POST', 'PUT', 'PATCH', 'DELETE']).not.toContain(method);
    }

    // 2. Check backing file immutability
    const fileHashesAfter = await hashDirectoryFiles(tempDir);
    expect(fileHashesAfter.size).toBe(fileHashesBefore.size);

    for (const [filePath, hashBefore] of fileHashesBefore.entries()) {
      const hashAfter = fileHashesAfter.get(filePath);
      expect(hashAfter).toBeDefined();
      expect(hashAfter).toBe(hashBefore);
    }
  });
});
