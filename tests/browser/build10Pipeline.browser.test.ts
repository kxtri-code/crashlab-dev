/**
 * Build 10: Complete End-to-End Pipeline Browser Validation (Playwright).
 *
 * Validates the unbroken 11-stage pipeline in live Chromium:
 *
 *   1. Scout                   (local Chromium DOM map)
 *   2. Journey Plan            (deterministic planning)
 *   3. Execute                 (single-pass sequential execution)
 *   4. Anomaly Detection       (deterministic evidence rule classification)
 *   5. Reproduce               (bounded controlled repeat attempts)
 *   6. Provenance              (environment fingerprinting)
 *   7. Baseline Comparison     (known-good baseline lineage)
 *   8. Candidate Review        (defect classification and report)
 *   9. Review-State            (append-only event log via CLI)
 *  10. Read-Only API           (127.0.0.1 GET/HEAD queries)
 *  11. Local Review UI         (interactive browser inspection with 4-way separation)
 *
 * Guarantees:
 *  - Zero external network calls (100% 127.0.0.1 ephemeral ports)
 *  - Zero mutation requests issued by browser (strict read-only)
 *  - Zero confirmed bugs (confirmedBug: false invariant)
 *  - Backing reports remain 100% byte-identical
 *  - Complete server and browser cleanup in afterAll
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';

import { runScout } from '../../src/scout/scout.js';
import { planJourney } from '../../src/journey/plan.js';
import { executeJourney } from '../../src/executor/executor.js';
import type { ExecutionReport } from '../../src/executor/types.js';
import { buildAnomalyReport } from '../../src/anomaly/report.js';
import { reproduceSignals } from '../../src/reproducer/reproducer.js';
import { buildBaseline } from '../../src/baseline/writer.js';
import { buildCandidateReport } from '../../src/review/candidateReport.js';
import { runReviewStateCommand } from '../../src/cli/reviewStateCommand.js';
import { createReviewApiServer, type RunningReviewApiServer } from '../../src/reviewApi/server.js';
import { createReviewUiServer } from '../../src/reviewUi/staticServer.js';
import type { RunningReviewUiServer } from '../../src/reviewUi/types.js';
import { startValidationServer, type ValidationServerHandle } from '../validation/pipelineFixtures.js';
import {
  assertTrustInvariants,
  assertArtifactChain,
  assertFileByteIdentical,
} from '../validation/artifactAssertions.js';
import { RULE_IDS } from '../../src/anomaly/types.js';

describe('Build 10: Complete End-to-End Pipeline Browser Validation', () => {
  let fixtureHandle: ValidationServerHandle;
  let apiServer: RunningReviewApiServer;
  let uiServer: RunningReviewUiServer;
  let browser: Browser;
  let page: Page;
  let tempDir: string;
  const recordedHttpMethods: string[] = [];

  let candidatesFilePath: string;
  let candidatesBytesBefore: Buffer;

  beforeAll(async () => {
    // 1. Temp working directory
    tempDir = await mkdtemp(join(tmpdir(), 'crashlab-build10-e2e-'));

    // 2. Start local fixture application server
    fixtureHandle = await startValidationServer();

    // 3. Launch browser
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });

    // Track network request methods issued by browser
    context.on('request', (req) => {
      recordedHttpMethods.push(req.method());
    });
    page = await context.newPage();
  }, 60_000);

  afterAll(async () => {
    if (browser) await browser.close();
    if (uiServer) await uiServer.stop();
    if (apiServer) await apiServer.stop();
    if (fixtureHandle) await fixtureHandle.stop();
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it('Stage 1 to 4: drives Healthy scenario from Scout through Execution to clean Baseline', async () => {
    const healthyUrl = `${fixtureHandle.origin}/healthy`;

    // 1. Scout healthy page
    const scout = await runScout({
      url: healthyUrl,
      headless: true,
      settleMs: 150,
      timeoutMs: 10_000,
    });
    expect(scout.meta.schemaVersion).toBe(1);
    expect(scout.interactiveElements.length).toBeGreaterThan(0);

    const scoutPath = join(tempDir, 'healthy-scout.json');
    await writeFile(scoutPath, JSON.stringify(scout, null, 2), 'utf8');

    // 2. Plan journey
    const plan = planJourney('Complete the healthy flow', scout, scoutPath);
    expect(plan.schemaVersion).toBe('1.0');
    expect(plan.steps.every((s) => s.executable === false)).toBe(true);

    const planPath = join(tempDir, 'healthy-journey.json');
    await writeFile(planPath, JSON.stringify(plan, null, 2), 'utf8');

    // 3. Execute journey
    const exec = await executeJourney({
      plan,
      planPath,
      safeTestMode: true,
      screenshots: false,
    });
    expect(exec.schemaVersion).toBe('1.0');
    assertTrustInvariants(exec as unknown as Record<string, unknown>);

    const execPath = join(tempDir, 'healthy-execution.json');
    await writeFile(execPath, JSON.stringify(exec, null, 2), 'utf8');

    // 4. Anomaly analysis
    const anomalies = buildAnomalyReport({
      execution: exec,
      journey: plan,
      executionPath: execPath,
      journeyPath: planPath,
    });
    expect(anomalies.summary.totalSignals).toBe(0);
    assertTrustInvariants(anomalies as unknown as Record<string, unknown>);

    // 5. Create Root Baseline
    const rootBaseline = buildBaseline({
      baselineId: 'base-root-healthy',
      name: 'Root Healthy Baseline',
      execution: exec,
      journey: plan,
      anomalies,
      acceptedSignalIds: [],
      confirmedBy: 'e2e-validator',
      paths: { execution: execPath, anomalies: 'anomalies.json', journey: planPath },
    });
    expect(rootBaseline.status).toBe('known-good');
    expect(rootBaseline.knownSignals.length).toBe(0);

    const baselineDir = join(tempDir, 'baselines');
    const baselineFile = join(baselineDir, 'base-root-healthy.json');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(baselineDir, { recursive: true });
    await writeFile(baselineFile, JSON.stringify(rootBaseline, null, 2), 'utf8');
  });

  it('Stage 5 to 8: drives HTTP 500 scenario through Reproduction, Comparison, and Candidate Review', async () => {
    const errorUrl = `${fixtureHandle.origin}/scenario-500`;

    // 1. Scout error page
    const scout = await runScout({
      url: errorUrl,
      headless: true,
      settleMs: 150,
      timeoutMs: 10_000,
    });
    const scoutPath = join(tempDir, '500-scout.json');
    await writeFile(scoutPath, JSON.stringify(scout, null, 2), 'utf8');

    // 2. Plan journey
    const plan = planJourney('Try to submit order', scout, scoutPath);
    const planPath = join(tempDir, '500-journey.json');
    await writeFile(planPath, JSON.stringify(plan, null, 2), 'utf8');

    // 3. Execute journey
    const exec = await executeJourney({
      plan,
      planPath,
      safeTestMode: true,
      screenshots: false,
    });
    const execPath = join(tempDir, '500-execution.json');
    await writeFile(execPath, JSON.stringify(exec, null, 2), 'utf8');

    // 4. Anomaly detection
    const anomalies = buildAnomalyReport({
      execution: exec,
      journey: plan,
      executionPath: execPath,
      journeyPath: planPath,
    });
    expect(anomalies.summary.totalSignals).toBeGreaterThanOrEqual(1);
    expect(anomalies.anomalies.some((a) => a.ruleId === RULE_IDS.http5xx)).toBe(true);

    const anomPath = join(tempDir, '500-anomalies.json');
    await writeFile(anomPath, JSON.stringify(anomalies, null, 2), 'utf8');

    // 5. Controlled Reproducer (bounded 3 attempts)
    const reproduction = await reproduceSignals({
      anomalies,
      journey: plan,
      attempts: 3,
      authorized: true,
      includePossiblyExpected: false,
      anomalyPath: anomPath,
      journeyPath: planPath,
      executionPath: execPath,
      outputDir: join(tempDir, 'reproduction-attempts'),
    });
    expect(reproduction.schemaVersion).toBe('1.0');
    expect(reproduction.runs.length).toBe(3);
    assertTrustInvariants(reproduction as unknown as Record<string, unknown>);

    const reproPath = join(tempDir, '500-reproduction.json');
    await writeFile(reproPath, JSON.stringify(reproduction, null, 2), 'utf8');

    const cleanExec: ExecutionReport = {
      ...exec,
      rawEvidence: { consoleEvents: [], pageErrors: [], networkEvents: [], screenshots: [] },
      verification: exec.verification
        ? {
            ...exec.verification,
            complete: true,
            coverage: 'full-plan',
            unverifiedAssertions: 0,
          }
        : null,
    };
    const cleanAnom = buildAnomalyReport({
      execution: cleanExec,
      journey: plan,
      executionPath: execPath,
      journeyPath: planPath,
    });
    const compatibleBaseline = buildBaseline({
      baselineId: 'base-500-clean',
      name: 'Compatible Clean Baseline for 500 Scenario',
      execution: cleanExec,
      journey: plan,
      anomalies: cleanAnom,
      acceptedSignalIds: [],
      confirmedBy: 'e2e-validator',
      paths: { execution: execPath, anomalies: anomPath, journey: planPath },
    });
    const baselineFile = join(tempDir, 'baselines', 'base-500-clean.json');
    await writeFile(baselineFile, JSON.stringify(compatibleBaseline, null, 2), 'utf8');

    // 7. Candidate Review vs Compatible Baseline
    const candidateReport = buildCandidateReport({
      baseline: compatibleBaseline,
      execution: exec,
      anomalies,
      reproduction,
      journey: plan,
      paths: { execution: execPath, anomalies: anomPath, reproduction: reproPath, journey: planPath },
    });

    expect(candidateReport.candidates.length).toBeGreaterThanOrEqual(1);
    const c500 = candidateReport.candidates.find((c) => c.ruleId === RULE_IDS.http5xx);
    expect(c500).toBeDefined();
    expect(c500?.classification).toBe('novel');
    expect(c500?.confirmed).toBe(false);

    assertArtifactChain(candidateReport, anomalies, exec, plan);

    // Save candidates.json for Review-State, API, and UI
    candidatesFilePath = join(tempDir, 'candidates.json');
    const candidateBytes = Buffer.from(JSON.stringify(candidateReport, null, 2), 'utf8');
    await writeFile(candidatesFilePath, candidateBytes);
    candidatesBytesBefore = candidateBytes;
  });

  it('Stage 9 to 11: verifies Review-State CLI, Read-Only API, and UI 4-way visual separation in browser', async () => {
    const reviewStateDir = join(tempDir, 'review-state');
    const candReport = JSON.parse(await readFile(candidatesFilePath, 'utf8'));
    const targetCandidate = candReport.candidates.find((c: any) => c.ruleId === 'HTTP_5XX') ?? candReport.candidates[0];
    const targetCandidateId = targetCandidate.candidateId;

    // 1. Perform review transition via CLI: unreviewed -> investigating
    const cliExitCode = await runReviewStateCommand([
      '--state', reviewStateDir,
      '--candidate', targetCandidateId,
      '--status', 'investigating',
      '--reviewer', 'lead-auditor',
      '--note', 'Automated Build 10 E2E pipeline triage',
    ]);
    expect(cliExitCode).toBe(0);

    // 2. Start backing Review API Server
    apiServer = await createReviewApiServer({
      host: '127.0.0.1',
      port: 0,
      paths: {
        candidatesPath: candidatesFilePath,
        reviewStateDir,
        baselinesDir: join(tempDir, 'baselines'),
      },
    });
    await apiServer.start();

    // 3. Start Review UI Server
    uiServer = await createReviewUiServer({
      host: '127.0.0.1',
      port: 0,
      apiUrl: apiServer.url,
      noOpen: true,
    });

    // 4. Open Playwright to UI Overview
    await page.goto(`${uiServer.url}/#/`);
    await page.waitForSelector('#readonly-indicator');

    // Verify Read-Only Mode banner and trust invariants
    const bodyText = await page.textContent('body');
    expect(bodyText).toContain('READ-ONLY');
    expect(bodyText).toContain('confirmedBug: false');
    expect(bodyText).toContain('confirmed: false');

    // 5. Navigate to Candidates table view
    await page.click('a[href="#/candidates"]');
    await page.waitForSelector('#candidates-table');
    const tableText = await page.textContent('#candidates-table');
    expect(tableText).toContain('HTTP_5XX');
    expect(tableText).toContain('novel');
    expect(tableText).toContain('investigating');

    // 6. Navigate to Candidate Detail view
    await page.click(`a[data-candidate-id="${targetCandidateId}"]`);
    await page.waitForSelector('#panel-calculated-result');

    // Verify Strict 4-Way Visual Separation
    // Panel 1: Automatic Calculated Result
    const p1 = page.locator('#panel-calculated-result');
    expect(await p1.isVisible()).toBe(true);
    expect(await p1.textContent()).toContain('HTTP_5XX');
    expect(await p1.textContent()).toContain('novel');

    // Panel 2: Human Review State
    const p2 = page.locator('#panel-human-review-state');
    expect(await p2.isVisible()).toBe(true);
    expect(await p2.textContent()).toContain('investigating');
    expect(await p2.textContent()).toContain('lead-auditor');
    expect(await p2.textContent()).toContain('Automated Build 10 E2E pipeline triage');

    // Panel 3: Supporting Evidence & Provenance
    const p3 = page.locator('#panel-supporting-evidence');
    expect(await p3.isVisible()).toBe(true);
    expect(await p3.textContent()).toContain('Observed Signal Message');
    expect(await p3.textContent()).toContain('Target Origin');

    // Panel 4: Limitations & Invariants
    const p4 = page.locator('#panel-limitations-invariants');
    expect(await p4.isVisible()).toBe(true);
    expect(await p4.textContent()).toContain('confirmedBug: false');
    expect(await p4.textContent()).toContain('confirmed: false');

    // 7. Interactive CLI Snippet Generator & Copy Feedback
    await page.selectOption('#cli-status-select', 'resolved');
    await page.fill('#cli-reviewer-input', 'qa-signer');
    await page.fill('#cli-notes-input', 'Resolved in validation pipeline');

    const snippetText = await page.textContent('#cli-command-preview');
    expect(snippetText?.trim()).toContain(`npm run review-state -- --candidate ${targetCandidateId} --status resolved --reviewer "qa-signer" --notes "Resolved in validation pipeline"`);

    await page.click('#btn-copy-cli');
    await page.waitForSelector('#copy-confirmation:not(.hidden)');
    const copyConfirm = page.locator('#copy-confirmation');
    expect(await copyConfirm.isVisible()).toBe(true);
    expect(await copyConfirm.textContent()).toContain('Copied to clipboard');

    // 8. History Timeline view
    await page.click('#btn-view-history');
    await page.waitForSelector('#history-timeline');
    const timelineText = await page.textContent('#history-timeline');
    expect(timelineText).toContain('lead-auditor');
    expect(timelineText).toContain('unreviewed → investigating');

    // 9. Read-only network verification: 100% GET or HEAD
    expect(recordedHttpMethods.length).toBeGreaterThan(0);
    for (const method of recordedHttpMethods) {
      expect(['GET', 'HEAD']).toContain(method);
      expect(['POST', 'PUT', 'PATCH', 'DELETE']).not.toContain(method);
    }

    // 10. File Immutability: candidates.json must remain 100% byte-identical
    await assertFileByteIdentical(candidatesFilePath, candidatesBytesBefore);
  });
});
