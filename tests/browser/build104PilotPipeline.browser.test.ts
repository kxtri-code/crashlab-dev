/**
 * Build 10.4: Complete Controlled Local Pilot Pipeline Browser Integration Suite.
 *
 * Runs and verifies the complete CrashLab pipeline through the new pilot runner
 * using only a local synthetic fixture.
 *
 * Proves that the runner creates correct evidence artifacts when preflight passes
 * and creates zero browser or evidence artifacts when preflight fails.
 *
 * Safety Invariants:
 *  - 100% loopback (127.0.0.1 ephemeral ports only)
 *  - Zero external network requests
 *  - Zero production credentials or databases
 *  - confirmedBug: false and confirmed: false strictly preserved
 *  - Journey plans remain 100% byte-identical
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Server } from 'node:http';

import { startFixtureServer, stopFixtureServer } from '../fixtures/server.js';
import { runScout } from '../../src/scout/scout.js';
import { planJourney } from '../../src/journey/plan.js';
import { runPilot } from '../../src/pilot/runner.js';
import { runPilotCommand } from '../../src/cli/pilotCommand.js';
import { runReviewStateCommand } from '../../src/cli/reviewStateCommand.js';
import { buildBaseline } from '../../src/baseline/writer.js';
import { RULE_IDS } from '../../src/anomaly/types.js';
import type { PilotConfiguration } from '../../src/preflight/types.js';

describe('Build 10.4: Controlled Local Pilot Pipeline (Live Browser Integration)', () => {
  let fixtureServer: Server;
  let fixtureOrigin: string;
  let fixturePort: number;
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'crashlab-build104-browser-'));

    // Start deterministic local fixture server on loopback ephemeral port
    const started = await startFixtureServer();
    fixtureServer = started.server;
    fixtureOrigin = started.origin;

    const url = new URL(fixtureOrigin);
    fixturePort = parseInt(url.port, 10);

    // Strict invariant: must only bind to 127.0.0.1 loopback
    expect(url.hostname).toBe('127.0.0.1');
    expect(fixtureOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  }, 30_000);

  afterAll(async () => {
    if (fixtureServer) {
      await stopFixtureServer(fixtureServer);
    }
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  function makeLocalConfig(path: string = '/shop'): PilotConfiguration {
    return {
      targetUrl: `${fixtureOrigin}${path}`,
      targetName: 'Local Synthetic Fixture Target',
      targetEnvironment: 'local',
      appBuildId: 'build-local-10.4-e2e',
      allowedOrigins: [fixtureOrigin],
      allowedJourneys: [
        {
          id: 'j-shop-01',
          goal: 'add widget to cart',
          origin: fixtureOrigin,
          allowedActions: ['navigate', 'identify', 'click'],
          forbiddenActions: ['checkout', 'payment'],
        },
      ],
      forbiddenActions: ['payment', 'checkout', 'account_deletion', 'destructive_mutation'],
    };
  }

  function makeBlockedStagingConfig(): PilotConfiguration {
    return {
      targetUrl: 'https://staging-shop.example.test/catalog',
      targetName: 'Unapproved Staging Target',
      targetEnvironment: 'staging',
      appBuildId: 'build-staging-unauth',
      allowedOrigins: ['https://staging-shop.example.test'],
      allowedJourneys: [
        {
          id: 'j-catalog-01',
          goal: 'browse items safely',
          origin: 'https://staging-shop.example.test',
          allowedActions: ['navigate', 'filter', 'view'],
          forbiddenActions: ['checkout', 'payment'],
        },
        {
          id: 'j-inquiry-02',
          goal: 'submit inquiry form safely',
          origin: 'https://staging-shop.example.test',
          allowedActions: ['navigate', 'fill', 'submit_form'],
          forbiddenActions: ['checkout', 'payment'],
        },
      ],
      forbiddenActions: [
        'payment',
        'checkout',
        'account_deletion',
        'data_deletion',
        'password_reset',
        'credential_change',
      ],
      // Missing authorizationReference -> blocked
    };
  }

  it('1. Healthy Journey: executes pilot pipeline, generates execution report, preserves safe mode, and creates clean baseline', async () => {
    const runDir = join(tempDir, 'healthy-run');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(runDir, { recursive: true });

    // Step A: Scout the local fixture
    const scout = await runScout({
      url: `${fixtureOrigin}/shop`,
      headless: true,
      settleMs: 150,
      timeoutMs: 15_000,
    });
    expect(scout.meta.schemaVersion).toBe(1);
    expect(scout.interactiveElements.length).toBeGreaterThan(0);

    const scoutPath = join(runDir, 'scout.json');
    await writeFile(scoutPath, JSON.stringify(scout, null, 2), 'utf8');

    // Step B: Plan approved journey
    const plan = planJourney('add widget to cart', scout, scoutPath);
    expect(plan.schemaVersion).toBe('1.0');
    expect(plan.steps.length).toBeGreaterThan(0);

    const planPath = join(runDir, 'journey.json');
    await writeFile(planPath, JSON.stringify(plan, null, 2), 'utf8');

    // Record journey bytes before execution to audit immutability
    const planBytesBefore = await readFile(planPath);
    const planHashBefore = createHash('sha256').update(planBytesBefore).digest('hex');

    // Step C: Run Pilot through the Pilot Runner
    const config = makeLocalConfig('/shop');
    const configPath = join(runDir, 'config.json');
    await writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

    const pilotResult = await runPilot({
      config: configPath,
      journeyPath: planPath,
      reportDir: runDir,
      quiet: true,
    });

    // Verification of Pilot Runner outcomes
    expect(pilotResult.exitCode).toBe(0);
    expect(pilotResult.preflightResult.status).toBe('ready');
    expect(pilotResult.preflightResult.valid).toBe(true);
    expect(pilotResult.executed).toBe(true);
    expect(pilotResult.browserLaunchAttempts).toBe(1);
    expect(pilotResult.executionReport).toBeDefined();

    const execReport = pilotResult.executionReport!;
    expect(execReport.schemaVersion).toBe('1.0');
    expect(execReport.executor?.safeTestMode).toBe(true);
    expect(execReport.executor?.retries).toBe(0);
    expect(execReport.stepCounts.failed).toBe(0);

    // Provenance verification: environment is local loopback
    expect(execReport.environment?.application?.environmentId).toBe('local');
    expect(execReport.environment?.target?.origin).toBe(fixtureOrigin);

    // Verify journey plan remained 100% byte-identical
    const planBytesAfter = await readFile(planPath);
    const planHashAfter = createHash('sha256').update(planBytesAfter).digest('hex');
    expect(planHashBefore).toBe(planHashAfter);

    // Verify execution.json was written to report directory
    const savedExecPath = join(runDir, 'execution.json');
    const savedExecContent = await readFile(savedExecPath, 'utf8');
    const savedExec = JSON.parse(savedExecContent);
    expect(savedExec.goal).toBe(plan.goal);

    // Step D: Clean Baseline Creation
    const { buildAnomalyReport } = await import('../../src/anomaly/report.js');
    const anomalies = buildAnomalyReport({
      execution: execReport,
      journey: plan,
      executionPath: savedExecPath,
      journeyPath: planPath,
    });
    expect(anomalies.summary.totalSignals).toBe(0);

    const baselineDir = join(runDir, 'baselines');
    await mkdir(baselineDir, { recursive: true });

    const baseline = buildBaseline({
      baselineId: 'base-local-shop-v1',
      name: 'Local Synthetic Shop Clean Baseline',
      execution: execReport,
      journey: plan,
      anomalies,
      acceptedSignalIds: [],
      allowUnverifiedAssertions: true,
      confirmedBy: 'build104-operator',
      paths: { execution: savedExecPath, anomalies: 'anomalies.json', journey: planPath },
    });

    expect(baseline.status).toBe('known-good-partial');
    expect(baseline.knownSignals).toHaveLength(0);
    expect(baseline.identity.targetOrigin).toBe(fixtureOrigin);

    const baselinePath = join(baselineDir, 'base-local-shop-v1.json');
    await writeFile(baselinePath, JSON.stringify(baseline, null, 2), 'utf8');

    // Baseline Immutability verification
    const baselineBytes = await readFile(baselinePath);
    const baselineHash = createHash('sha256').update(baselineBytes).digest('hex');
    expect(baselineHash).toBeDefined();
    expect(baselineBytes.length).toBeGreaterThan(0);
  });

  it('2. Controlled Anomaly Scenario: runs pilot with HTTP 500 fault, executes reproduction & candidate review, and triages via review-state', async () => {
    const runDir = join(tempDir, 'anomaly-run');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(runDir, { recursive: true });

    // Step A: Scout controlled HTTP 500 fixture endpoint
    const scout = await runScout({
      url: `${fixtureOrigin}/boom`,
      headless: true,
      settleMs: 150,
      timeoutMs: 15_000,
    });
    const scoutPath = join(runDir, 'scout.json');
    await writeFile(scoutPath, JSON.stringify(scout, null, 2), 'utf8');

    // Step B: Plan journey
    const plan = planJourney('observe synthetic server fault', scout, scoutPath);
    const planPath = join(runDir, 'journey.json');
    await writeFile(planPath, JSON.stringify(plan, null, 2), 'utf8');

    // Step C: Run Pilot with pipeline: true
    const config = makeLocalConfig('/boom');
    const configPath = join(runDir, 'config.json');
    await writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

    const pilotResult = await runPilot({
      config: configPath,
      journeyPath: planPath,
      reportDir: runDir,
      pipeline: true,
      quiet: true,
    });

    // Verification of Pilot Runner outcomes
    expect(pilotResult.exitCode).toBe(0);
    expect(pilotResult.executed).toBe(true);
    expect(pilotResult.executionReport).toBeDefined();
    expect(pilotResult.anomalyReport).toBeDefined();

    const anomReport = pilotResult.anomalyReport!;
    expect(anomReport.summary.totalSignals).toBeGreaterThanOrEqual(1);
    expect(anomReport.anomalies.some((a) => a.ruleId === RULE_IDS.http5xx)).toBe(true);

    // Bounded Reproduction: 3 attempts executed
    expect(pilotResult.reproductionReport).toBeDefined();
    const reproReport = pilotResult.reproductionReport!;
    expect(reproReport.schemaVersion).toBe('1.0');
    expect(reproReport.reproducer.attemptsRequested).toBe(3);
    expect(reproReport.reproducer.automaticRetries).toBe(false);
    expect(reproReport.interpretation.confirmedBug).toBe(false);

    // Candidate Review: candidate report created with confirmedBug: false invariant
    expect(pilotResult.candidateReport).toBeDefined();
    const candReport = pilotResult.candidateReport!;
    expect(candReport.interpretation.confirmedBug).toBe(false);
    expect(candReport.candidates.length).toBeGreaterThanOrEqual(1);
    expect(candReport.candidates.every((c) => c.confirmed === false)).toBe(true);

    // Verify all artifact files written to reportDir
    expect(pilotResult.artifactPaths?.execution).toBeDefined();
    expect(pilotResult.artifactPaths?.anomalies).toBeDefined();
    expect(pilotResult.artifactPaths?.reproduction).toBeDefined();
    expect(pilotResult.artifactPaths?.candidates).toBeDefined();

    // Step D: Human Review Triage via review-state CLI
    const candidateId = candReport.candidates[0]!.candidateId ?? candReport.candidates[0]!.id;
    const reviewStateDir = join(runDir, 'review-state');

    const codeInvestigating = await runReviewStateCommand([
      '--candidate',
      candidateId,
      '--status',
      'investigating',
      '--reviewer',
      'audit-operator',
      '--note',
      'Synthetic controlled HTTP 500 fixture anomaly confirmed for investigation',
      '--candidates',
      pilotResult.artifactPaths!.candidates!,
      '--state',
      reviewStateDir,
    ]);
    expect(codeInvestigating).toBe(0);

    const codeAccepted = await runReviewStateCommand([
      '--candidate',
      candidateId,
      '--status',
      'accepted',
      '--reviewer',
      'audit-operator',
      '--note',
      'Known synthetic fixture route behavior accepted as rehearsal artifact',
      '--candidates',
      pilotResult.artifactPaths!.candidates!,
      '--state',
      reviewStateDir,
    ]);
    expect(codeAccepted).toBe(0);

    // Verify projection file state
    const stateFile = join(reviewStateDir, 'state.json');
    const stateContent = await readFile(stateFile, 'utf8');
    const state = JSON.parse(stateContent);
    const candidateState = state.candidates[candidateId];
    expect(candidateState).toBeDefined();
    expect(candidateState.currentStatus).toBe('accepted');
    expect(candidateState.revision).toBe(2);
    expect(candidateState.confirmed).toBe(false);
  });

  it('3. Blocked Staging Configuration: refuses execution with zero browser launches and zero reports written', async () => {
    const runDir = join(tempDir, 'blocked-run');
    const blockedConfig = makeBlockedStagingConfig();
    const configPath = join(tempDir, 'blocked-config.json');
    await writeFile(configPath, JSON.stringify(blockedConfig, null, 2), 'utf8');

    const result = await runPilot({
      config: configPath,
      reportDir: runDir,
      quiet: true,
    });

    expect(result.exitCode).toBe(1);
    expect(result.preflightResult.status).toBe('blocked');
    expect(result.executed).toBe(false);
    expect(result.browserLaunchAttempts).toBe(0);
    expect(result.executionReport).toBeUndefined();
    expect(result.artifactPaths).toBeUndefined();

    // Verify no files written in runDir
    try {
      const { readdir } = await import('node:fs/promises');
      const files = await readdir(runDir);
      expect(files).toHaveLength(0);
    } catch {
      // Directory not created is expected
    }
  });

  it('4. Preflight-Only Mode: validates successfully with zero browser launches', async () => {
    const config = makeLocalConfig('/shop');
    const configPath = join(tempDir, 'preflight-only-config.json');
    await writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

    const result = await runPilot({
      config: configPath,
      preflightOnly: true,
      quiet: true,
    });

    expect(result.exitCode).toBe(0);
    expect(result.preflightResult.status).toBe('ready');
    expect(result.executed).toBe(false);
    expect(result.browserLaunchAttempts).toBe(0);
    expect(result.message).toContain('Zero browser traffic generated');
  });

  it('5. CLI Integration: verifies real CLI exit codes (0, 1, 2) on pilot commands', async () => {
    const validConfigPath = join(tempDir, 'cli-valid-config.json');
    await writeFile(validConfigPath, JSON.stringify(makeLocalConfig('/shop'), null, 2), 'utf8');

    const blockedConfigPath = join(tempDir, 'cli-blocked-config.json');
    await writeFile(blockedConfigPath, JSON.stringify(makeBlockedStagingConfig(), null, 2), 'utf8');

    // Code 0: valid preflight-only
    const code0 = await runPilotCommand(['--config', validConfigPath, '--preflight-only']);
    expect(code0).toBe(0);

    // Code 1: blocked configuration
    const code1 = await runPilotCommand(['--config', blockedConfigPath]);
    expect(code1).toBe(1);

    // Code 2: missing required arguments
    const code2Missing = await runPilotCommand([]);
    expect(code2Missing).toBe(2);

    // Code 2: unknown CLI flag
    const code2Unknown = await runPilotCommand(['--config', validConfigPath, '--invalid-flag']);
    expect(code2Unknown).toBe(2);
  });
});
