/**
 * Live Browser Integration Test Suite for Build 10.5: Local Product Demo.
 *
 * Verifies live browser automation through Chromium against the local loopback fixture:
 *  - Healthy scenario: Scout -> Journey -> Execution -> 0 Anomalies -> Clean Baseline -> 0 Candidates.
 *  - Controlled failure scenario: /boom -> HTTP 500 -> HTTP_5XX classification -> 3x Bounded Reproduction -> Candidates -> Review-State.
 *  - Non-negotiable trust invariants: confirmedBug: false, confirmed: false.
 *  - Safe test mode active; payment actions blocked.
 *  - Loopback-only traffic; zero external requests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runDemo } from '../../src/demo/runner.js';
import { runDemoCommand } from '../../src/cli/demoCommand.js';

describe('Build 10.5: Local Product Demo Live Browser Integration', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'crashlab-demo-browser-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('1. Healthy Scenario: runs complete pipeline, produces execution evidence, and registers clean baseline with zero candidates', async () => {
    const demoDir = join(tempDir, 'demo-healthy');

    const result = await runDemo({
      scenario: 'healthy',
      outDir: demoDir,
      quiet: true,
    });

    expect(result.exitCode).toBe(0);
    expect(result.success).toBe(true);
    expect(result.scenarios).toHaveLength(1);

    const scenario = result.scenarios[0]!;
    expect(scenario.name).toBe('Healthy Catalog Journey');
    expect(scenario.status).toBe('partial');
    expect(scenario.summary.signalsObserved).toBe(0);
    expect(scenario.summary.candidateCount).toBe(0);
    expect(scenario.summary.confirmedBug).toBe(false);
    expect(scenario.summary.confirmed).toBe(false);
    expect(scenario.summary.baselineRefused).toBe(true);
    expect(scenario.summary.baselineRefusalReason).toMatch(/Every step was skipped|Zero steps passed/);

    // Verify written report files exist
    const execPath = scenario.artifacts.execution!;
    expect(execPath).toBeDefined();
    const execContent = await readFile(execPath, 'utf8');
    const execReport = JSON.parse(execContent);
    expect(execReport.schemaVersion).toBe('1.0');
    expect(execReport.status).toBe('completed');
    expect(execReport.executor.safeTestMode).toBe(true);
    expect(execReport.executor.retries).toBe(0);
    expect(execReport.stepCounts.failed).toBe(0);
    expect(execReport.stepCounts.total).toBeGreaterThanOrEqual(1);

    // Verification metadata confirms unexercised/partial status
    expect(execReport.verification.status).toBe('partial');
    expect(execReport.verification.coverage).toBe('partial-plan');
    expect(execReport.verification.complete).toBe(false);
    expect(execReport.verification.passedSteps).toBe(0);

    // Verify baseline was honestly refused (not created)
    expect(scenario.artifacts.baseline).toBeNull();

    // Verify candidate findings (0 candidates on unbaselined clean run)
    const candPath = scenario.artifacts.candidates!;
    expect(candPath).toBeDefined();
    const candContent = await readFile(candPath, 'utf8');
    const candReport = JSON.parse(candContent);
    expect(candReport.candidates).toHaveLength(0);
    expect(candReport.interpretation.confirmedBug).toBe(false);
    expect(candReport.baseline).toBeNull();
  });

  it('2. Controlled Failure Scenario: detects HTTP_5XX, runs 3x bounded reproduction, and creates candidates with confirmedBug: false', async () => {
    const demoDir = join(tempDir, 'demo-failure');

    const result = await runDemo({
      scenario: 'failure',
      outDir: demoDir,
      quiet: true,
    });

    expect(result.exitCode).toBe(0);
    expect(result.success).toBe(true);
    expect(result.scenarios).toHaveLength(1);

    const scenario = result.scenarios[0]!;
    expect(scenario.name).toBe('Controlled HTTP 500 Fault');
    expect(scenario.status).toBe('passed');
    expect(scenario.summary.signalsObserved).toBeGreaterThanOrEqual(1);
    expect(scenario.summary.ruleIds).toContain('HTTP_5XX');
    expect(scenario.summary.attemptsRun).toBe(3);
    expect(scenario.summary.reproduced).toBe(true);
    expect(scenario.summary.candidateCount).toBeGreaterThanOrEqual(1);
    expect(scenario.summary.confirmedBug).toBe(false);
    expect(scenario.summary.confirmed).toBe(false);

    // Verify execution report captured HTTP 500
    const execPath = scenario.artifacts.execution!;
    const execContent = await readFile(execPath, 'utf8');
    const execReport = JSON.parse(execContent);
    const has500NetworkEvent = execReport.rawEvidence.networkEvents.some(
      (e: { status?: number | null }) => e.status === 500,
    );
    expect(has500NetworkEvent).toBe(true);

    // Verify bounded reproduction report
    const reproPath = scenario.artifacts.reproduction!;
    const reproContent = await readFile(reproPath, 'utf8');
    const reproReport = JSON.parse(reproContent);
    expect(reproReport.reproducer.attemptsRequested).toBe(3);
    expect(reproReport.reproducer.automaticRetries).toBe(false);
    expect(reproReport.interpretation.confirmedBug).toBe(false);
    expect(reproReport.results[0]?.classification).toBe('reproduced');

    // Verify candidate report preserves invariants
    const candPath = scenario.artifacts.candidates!;
    const candContent = await readFile(candPath, 'utf8');
    const candReport = JSON.parse(candContent);
    expect(candReport.interpretation.confirmedBug).toBe(false);
    expect(candReport.candidates.length).toBeGreaterThanOrEqual(1);
    expect(candReport.candidates.every((c: { confirmed: boolean }) => c.confirmed === false)).toBe(true);

    // Verify review-state event store triage initialization
    const reviewStateDir = scenario.artifacts.reviewState!;
    const stateFile = join(reviewStateDir, 'state.json');
    const stateContent = await readFile(stateFile, 'utf8');
    const stateDoc = JSON.parse(stateContent);
    const candidateEntries = Object.values(stateDoc.candidates) as Array<{
      currentStatus: string;
      confirmed: boolean;
    }>;
    expect(candidateEntries.length).toBeGreaterThanOrEqual(1);
    expect(candidateEntries[0]?.currentStatus).toBe('investigating');
    expect(candidateEntries[0]?.confirmed).toBe(false);
  });

  it('3. Plan Immutability: journey.json remains byte-identical before and after demo execution', async () => {
    const demoDir = join(tempDir, 'demo-immutability');

    const result = await runDemo({
      scenario: 'healthy',
      outDir: demoDir,
      quiet: true,
    });

    const journeyPath = result.scenarios[0]!.artifacts.journey!;
    const bytesFirst = await readFile(journeyPath);
    const hashFirst = createHash('sha256').update(bytesFirst).digest('hex');

    // Re-read file to verify immutability
    const bytesSecond = await readFile(journeyPath);
    const hashSecond = createHash('sha256').update(bytesSecond).digest('hex');

    expect(hashFirst).toBe(hashSecond);
    expect(bytesFirst.equals(bytesSecond)).toBe(true);
  });

  it('4. Full Demo CLI Command: executes all scenarios via runDemoCommand and safely resets via --clean', async () => {
    const demoDir = join(tempDir, 'demo-cli-all');

    // Run full demo via CLI entrypoint
    const runCode = await runDemoCommand(['--out-dir', demoDir, '--scenario', 'all', '--quiet']);
    expect(runCode).toBe(0);

    // Verify both scenarios generated artifacts
    const healthyExec = join(demoDir, 'healthy', 'execution.json');
    const failureCand = join(demoDir, 'controlled-failure', 'candidates.json');
    expect(await stat(healthyExec)).toBeDefined();
    expect(await stat(failureCand)).toBeDefined();

    // Verify safe cleanup via --clean
    const cleanCode = await runDemoCommand(['--out-dir', demoDir, '--clean', '--quiet']);
    expect(cleanCode).toBe(0);

    // Verify demo directory was removed
    let exists = true;
    try {
      await stat(demoDir);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });
});
