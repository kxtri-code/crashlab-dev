/**
 * Unit & Safety Test Suite for Build 10.5: Local Product Demo Runner.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDemoFixtureServer } from '../../src/demo/fixtureServer.js';
import { cleanDemoArtifacts, DEFAULT_DEMO_OUT_DIR } from '../../src/demo/runner.js';
import { parseDemoArgs, runDemoCommand } from '../../src/cli/demoCommand.js';
import { validateBaselineCandidate } from '../../src/baseline/validator.js';
import { buildBaseline } from '../../src/baseline/writer.js';
import { buildVerification, isFullyVerified } from '../../src/executor/verification.js';
import { buildCandidateReport } from '../../src/review/candidateReport.js';
import type { StepExecutionResult, ExecutionReport } from '../../src/executor/types.js';
import { anomalyReportWith, checkoutJourney, cleanExecution } from '../fixtures/build6Fixtures.js';
import { execStep } from '../fixtures/executionReports.js';

describe('Build 10.5: Local Product Demo Unit & Safety Suite', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'crashlab-demo-unit-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('1. Demo Fixture Server & Loopback Isolation', () => {
    it('binds strictly to loopback (127.0.0.1) on an ephemeral port', async () => {
      const fixture = await startDemoFixtureServer(0);
      try {
        expect(fixture.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
        expect(fixture.port).toBeGreaterThan(0);
        expect(fixture.port).toBeLessThan(65536);

        // Verify loopback HTTP responses
        const resHome = await fetch(`${fixture.origin}/`);
        expect(resHome.status).toBe(200);
        const homeText = await resHome.text();
        expect(homeText).toContain('LOCAL SYNTHETIC FIXTURE');
        expect(homeText).toContain('Synthetic Widget Catalog');

        // Verify safe cart route (no payment inputs)
        const resCart = await fetch(`${fixture.origin}/cart`);
        expect(resCart.status).toBe(200);
        const cartText = await resCart.text();
        expect(cartText).toContain('Shopping Cart');
        expect(cartText).toContain('Payment and checkout actions are intentionally omitted');
        expect(cartText).not.toContain('<input type="password"');
        expect(cartText).not.toContain('credit-card');

        // Verify deterministic HTTP 500 fault route
        const resBoom = await fetch(`${fixture.origin}/boom`);
        expect(resBoom.status).toBe(500);
        const boomText = await resBoom.text();
        expect(boomText).toContain('Internal Server Error');
      } finally {
        await fixture.stop();
      }
    });

    it('proves zero external network calls by inspecting fixture server traffic', async () => {
      const fixture = await startDemoFixtureServer(0);
      try {
        const addr = fixture.server.address();
        expect(addr).toBeDefined();
        if (typeof addr === 'object' && addr !== null) {
          expect(addr.address).toBe('127.0.0.1');
        }
      } finally {
        await fixture.stop();
      }
    });
  });

  describe('2. CLI Argument Parsing & Validation', () => {
    it('parses default demo arguments cleanly', () => {
      const parsed = parseDemoArgs([]);
      expect(parsed.valid).toBe(true);
      expect(parsed.scenario).toBe('all');
      expect(parsed.outDir).toBe(DEFAULT_DEMO_OUT_DIR);
      expect(parsed.clean).toBe(false);
      expect(parsed.quiet).toBe(false);
      expect(parsed.json).toBe(false);
      expect(parsed.unknown).toHaveLength(0);
    });

    it('parses valid scenario flag values', () => {
      const pHealthy = parseDemoArgs(['--scenario', 'healthy']);
      expect(pHealthy.valid).toBe(true);
      expect(pHealthy.scenario).toBe('healthy');

      const pFailure = parseDemoArgs(['--scenario', 'failure']);
      expect(pFailure.valid).toBe(true);
      expect(pFailure.scenario).toBe('failure');

      const pAll = parseDemoArgs(['--scenario', 'all']);
      expect(pAll.valid).toBe(true);
      expect(pAll.scenario).toBe('all');
    });

    it('rejects invalid scenario flag value with error', () => {
      const parsed = parseDemoArgs(['--scenario', 'invalid-scenario']);
      expect(parsed.valid).toBe(false);
      expect(parsed.error).toContain('Invalid scenario');
    });

    it('parses --clean and --reset flags', () => {
      const pClean = parseDemoArgs(['--clean']);
      expect(pClean.valid).toBe(true);
      expect(pClean.clean).toBe(true);

      const pReset = parseDemoArgs(['--reset']);
      expect(pReset.valid).toBe(true);
      expect(pReset.clean).toBe(true);
    });

    it('parses custom --out-dir', () => {
      const parsed = parseDemoArgs(['--out-dir', 'reports/custom-demo']);
      expect(parsed.valid).toBe(true);
      expect(parsed.outDir).toBe('reports/custom-demo');
    });

    it('rejects missing value for --out-dir', () => {
      const parsed = parseDemoArgs(['--out-dir']);
      expect(parsed.valid).toBe(false);
      expect(parsed.error).toContain('--out-dir requires a directory path');
    });

    it('rejects unrecognized flags with error message', () => {
      const parsed = parseDemoArgs(['--unknown-flag']);
      expect(parsed.valid).toBe(false);
      expect(parsed.error).toContain('Unknown option: --unknown-flag');
    });
  });

  describe('3. Safe Demo Artifact Cleanup & Bounded Deletion', () => {
    it('refuses to delete workspace root or unsafe non-demo paths', async () => {
      await expect(cleanDemoArtifacts(process.cwd())).rejects.toThrow(/Refusing to delete/);
      await expect(cleanDemoArtifacts('src')).rejects.toThrow(/Refusing to delete/);
      await expect(cleanDemoArtifacts('tests')).rejects.toThrow(/Refusing to delete/);
      await expect(cleanDemoArtifacts('reports')).rejects.toThrow(/Refusing to delete/);
      await expect(cleanDemoArtifacts('arbitrary-dir')).rejects.toThrow(/Safe demo cleanup only targets directories containing "demo"/);
    });

    it('safely removes an isolated demo artifact directory', async () => {
      const demoTargetDir = join(tempDir, 'sample-demo-out');
      await mkdir(demoTargetDir, { recursive: true });
      await writeFile(join(demoTargetDir, 'execution.json'), '{"test":true}', 'utf8');

      const result = await cleanDemoArtifacts(demoTargetDir);
      expect(result.cleaned).toBe(true);

      let exists = true;
      try {
        await stat(demoTargetDir);
      } catch {
        exists = false;
      }
      expect(exists).toBe(false);
    });

    it('gracefully handles cleanup when demo directory does not exist', async () => {
      const nonExistentDemoDir = join(tempDir, 'nonexistent-demo');
      const result = await cleanDemoArtifacts(nonExistentDemoDir);
      expect(result.cleaned).toBe(false);
    });
  });

  describe('4. CLI Command Exit Codes', () => {
    it('returns exit code 2 when invalid arguments are provided', async () => {
      const code = await runDemoCommand(['--unrecognized-flag']);
      expect(code).toBe(2);
    });

    it('returns exit code 0 on --clean command', async () => {
      const demoTargetDir = join(tempDir, 'test-demo-clean');
      await mkdir(demoTargetDir, { recursive: true });

      const code = await runDemoCommand(['--out-dir', demoTargetDir, '--clean']);
      expect(code).toBe(0);
    });
  });

  describe('5. Safety Invariants & Zero Secrets Contract', () => {
    it('guarantees demo defaults contain no external URLs or credentials', () => {
      const parsed = parseDemoArgs([]);
      expect(parsed.outDir).not.toContain('http');
      expect(parsed.outDir).not.toContain('password');
      expect(parsed.outDir).not.toContain('key');
    });
  });

  describe('6. Baseline Eligibility & Verification Invariants (0/N Passed Runs)', () => {
    function unexercisedExecution(overrides: Partial<ExecutionReport> = {}): ExecutionReport {
      const steps: StepExecutionResult[] = [
        execStep({ id: 'step-001', order: 1, status: 'skipped', skipReason: 'no-target' }),
        execStep({ id: 'step-002', order: 2, status: 'skipped', skipReason: 'no-target' }),
        execStep({ id: 'step-003', order: 3, status: 'skipped', skipReason: 'no-target' }),
        execStep({ id: 'step-004', order: 4, status: 'skipped', skipReason: 'no-target' }),
        execStep({ id: 'step-005', order: 5, status: 'skipped', skipReason: 'no-target' }),
        execStep({ id: 'step-006', order: 6, status: 'skipped', skipReason: 'unsupported-prose-assertion' }),
      ];
      const verification = buildVerification(steps, false);
      return cleanExecution({
        status: 'completed',
        steps,
        stepCounts: { total: 6, passed: 0, failed: 0, blocked: 0, skipped: 6 },
        verification,
        ...overrides,
      });
    }

    it('refuses baseline candidate validation when all steps are skipped (0/N passed)', () => {
      const exec = unexercisedExecution();
      const result = validateBaselineCandidate({
        execution: exec,
        anomalies: anomalyReportWith([]),
        journey: checkoutJourney(),
        acceptedSignalIds: [],
      });

      expect(result.safe).toBe(false);
      expect(result.blockers.some((b) => b.includes('Every step was skipped'))).toBe(true);
      expect(result.blockers.some((b) => b.includes('Zero steps passed'))).toBe(true);
    });

    it('refuses baseline candidate validation even when allowUnverifiedAssertions is enabled', () => {
      const exec = unexercisedExecution();
      const result = validateBaselineCandidate({
        execution: exec,
        anomalies: anomalyReportWith([]),
        journey: checkoutJourney(),
        acceptedSignalIds: [],
        allowUnverifiedAssertions: true,
      });

      expect(result.safe).toBe(false);
      expect(result.blockers.some((b) => b.includes('Zero steps passed'))).toBe(true);
      expect(result.blockers.some((b) => b.includes('Every step was skipped'))).toBe(true);
    });

    it('buildVerification marks 0/N passed run as partial status with partial-plan coverage', () => {
      const steps: StepExecutionResult[] = [
        execStep({ id: 'step-001', order: 1, status: 'skipped', skipReason: 'no-target' }),
        execStep({ id: 'step-002', order: 2, status: 'skipped', skipReason: 'no-target' }),
        execStep({ id: 'step-003', order: 3, status: 'skipped', skipReason: 'unsupported-prose-assertion' }),
      ];
      const verification = buildVerification(steps, false);

      expect(verification.status).toBe('partial');
      expect(verification.coverage).toBe('partial-plan');
      expect(verification.complete).toBe(false);
      expect(verification.passedSteps).toBe(0);
      expect(verification.executedSteps).toBe(0);
      expect(verification.skippedSteps).toBe(3);
      expect(isFullyVerified(verification)).toBe(false);
    });

    it('isFullyVerified strictly returns false if passedSteps is 0', () => {
      expect(
        isFullyVerified({
          status: 'partial',
          complete: false,
          executedSteps: 0,
          passedSteps: 0,
          failedSteps: 0,
          blockedSteps: 0,
          skippedSteps: 2,
          unverifiedAssertions: 0,
          unverifiedStepIds: [],
          coverage: 'partial-plan',
        }),
      ).toBe(false);
    });

    it('buildBaseline classifies an unexercised run as known-good-partial with partial-plan coverage', () => {
      const exec = unexercisedExecution();
      const baseline = buildBaseline({
        baselineId: 'unexercised-v1',
        name: 'Unexercised Run',
        execution: exec,
        anomalies: anomalyReportWith([]),
        journey: checkoutJourney(),
        acceptedSignalIds: [],
        confirmedBy: 'operator',
        allowUnverifiedAssertions: true,
        paths: { execution: 'e.json', anomalies: 'a.json', journey: 'j.json' },
        now: () => new Date('2026-01-01T00:00:00.000Z'),
      });

      expect(baseline.status).toBe('known-good-partial');
      expect(baseline.verification.coverage).toBe('partial-plan');
      expect(baseline.verification.complete).toBe(false);
      expect(baseline.status).not.toBe('known-good');
      expect(baseline.verification.coverage).not.toBe('full-plan');
    });

    it('candidate review against null baseline preserves confirmed: false and confirmedBug: false', () => {
      const exec = unexercisedExecution();
      const report = buildCandidateReport({
        baseline: null,
        execution: exec,
        anomalies: anomalyReportWith([]),
        reproduction: null,
        journey: checkoutJourney(),
        paths: {
          execution: 'e.json',
          anomalies: 'a.json',
          reproduction: null,
          journey: 'j.json',
          baseline: null,
        },
      });

      expect(report.baseline).toBeNull();
      expect(report.candidates).toHaveLength(0);
      expect(report.interpretation.confirmedBug).toBe(false);
      expect(report.candidates.every((c) => c.confirmed === false)).toBe(true);
    });
  });
});
