/**
 * Build 10.4: Controlled Local Pilot Pipeline Unit & Safety Suite.
 *
 * Verifies the pilot runner safety invariants, instrumentation, preflight gating,
 * zero-browser guarantees on blocked configurations, baseline validation behaviors,
 * CLI exit codes, and evidence immutability.
 *
 * All tests use isolated temporary directories and zero external network access.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

import type { PilotConfiguration, PreflightResult } from '../../src/preflight/types.js';
import { validatePilotConfiguration } from '../../src/preflight/validator.js';
import { assertPilotReady, createPilotExecutionPlan, PilotExecutionGateError } from '../../src/pilot/gate.js';
import { runPilot } from '../../src/pilot/runner.js';
import { runPilotCommand, parsePilotArgs } from '../../src/cli/pilotCommand.js';
import { runPreflightCommand } from '../../src/cli/preflightCommand.js';
import { validateBaselineCandidate } from '../../src/baseline/validator.js';
import type { ExecutionReport } from '../../src/executor/types.js';
import type { JourneyPlan } from '../../src/journey/types.js';
import type { AnomalyReport } from '../../src/anomaly/report.js';
import { checkoutJourney, cleanExecution, anomalyReportWith } from '../fixtures/build6Fixtures.js';

describe('Build 10.4: Pilot Runner Pipeline Unit & Safety Suite', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'crashlab-build104-unit-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function makeValidLocalConfig(port: number = 4040): PilotConfiguration {
    return {
      targetUrl: `http://127.0.0.1:${port}/shop`,
      targetName: 'Local Synthetic Fixture',
      targetEnvironment: 'local',
      appBuildId: 'build-local-10.4',
      allowedOrigins: [`http://127.0.0.1:${port}`],
      allowedJourneys: [
        {
          id: 'j-shop-01',
          goal: 'add widget to cart',
          origin: `http://127.0.0.1:${port}`,
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
      appBuildId: 'build-staging-2026',
      allowedOrigins: ['https://staging-shop.example.test'],
      allowedJourneys: [
        {
          id: 'j-catalog-01',
          goal: 'browse product catalog and filter categories',
          origin: 'https://staging-shop.example.test',
          allowedActions: ['navigate', 'filter', 'view'],
          forbiddenActions: ['checkout', 'payment'],
          requiresCredentials: false,
          requiresTestData: false,
        },
        {
          id: 'j-inquiry-02',
          goal: 'submit safe feedback inquiry form',
          origin: 'https://staging-shop.example.test',
          allowedActions: ['navigate', 'fill', 'submit_form'],
          forbiddenActions: ['checkout', 'payment'],
          requiresCredentials: false,
          requiresTestData: false,
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

  describe('1. Instrumentation & Execution Ordering', () => {
    it('proves strict execution ordering: preflight validation MUST complete before browser launcher is called', async () => {
      const callLog: string[] = [];
      const config = makeValidLocalConfig();

      const result = await runPilot(
        {
          config,
          quiet: true,
        },
        {
          validateConfig: (cfg) => {
            callLog.push('validateConfig');
            return validatePilotConfiguration(cfg);
          },
          browserLauncher: async () => {
            callLog.push('browserLauncher');
            return { ok: true };
          },
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.executed).toBe(true);
      expect(result.browserLaunchAttempts).toBe(1);
      expect(callLog).toEqual(['validateConfig', 'browserLauncher']);
    });

    it('proves zero browser launch attempts when preflight validation fails', async () => {
      const callLog: string[] = [];
      const blockedConfig = makeBlockedStagingConfig();

      const result = await runPilot(
        {
          config: blockedConfig,
          quiet: true,
        },
        {
          validateConfig: (cfg) => {
            callLog.push('validateConfig');
            return validatePilotConfiguration(cfg);
          },
          browserLauncher: async () => {
            callLog.push('browserLauncher');
            return { ok: true };
          },
          journeyExecutor: async () => {
            callLog.push('journeyExecutor');
            return cleanExecution();
          },
        },
      );

      expect(result.exitCode).toBe(1);
      expect(result.executed).toBe(false);
      expect(result.browserLaunchAttempts).toBe(0);
      expect(callLog).toEqual(['validateConfig']);
      expect(callLog).not.toContain('browserLauncher');
      expect(callLog).not.toContain('journeyExecutor');
    });

    it('proves zero browser launch attempts and zero execution when --preflight-only is active', async () => {
      const callLog: string[] = [];
      const config = makeValidLocalConfig();

      const result = await runPilot(
        {
          config,
          preflightOnly: true,
          quiet: true,
        },
        {
          browserLauncher: async () => {
            callLog.push('browserLauncher');
          },
          journeyExecutor: async () => {
            callLog.push('journeyExecutor');
            return cleanExecution();
          },
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.executed).toBe(false);
      expect(result.browserLaunchAttempts).toBe(0);
      expect(callLog).toHaveLength(0);
      expect(result.message).toContain('Zero browser traffic generated');
    });
  });

  describe('2. External-Target Safety & Production Rejection', () => {
    it('strictly refuses production-like hostname during preflight with zero browser launches', async () => {
      let browserLaunched = false;
      const prodConfig: PilotConfiguration = {
        targetUrl: 'https://production.crashlab-store.test/catalog',
        targetName: 'Accidental Production Attempt',
        targetEnvironment: 'staging',
        allowedOrigins: ['https://production.crashlab-store.test'],
        allowedJourneys: [
          {
            id: 'j-prod',
            goal: 'test catalog',
            origin: 'https://production.crashlab-store.test',
            allowedActions: ['navigate'],
            forbiddenActions: ['payment'],
          },
        ],
        forbiddenActions: ['payment', 'checkout'],
        authorizationReference: 'AUTH-TEST-2026-VAL',
      };

      const result = await runPilot(
        {
          config: prodConfig,
          quiet: true,
        },
        {
          browserLauncher: async () => {
            browserLaunched = true;
          },
        },
      );

      expect(result.exitCode).toBe(1);
      expect(result.preflightResult.status).toBe('invalid');
      expect(result.executed).toBe(false);
      expect(result.browserLaunchAttempts).toBe(0);
      expect(browserLaunched).toBe(false);
      expect(result.message).toContain('Production');
    });

    it('strictly refuses external target with missing authorization reference with zero browser launches', async () => {
      let browserLaunched = false;
      const unauthConfig = makeBlockedStagingConfig();

      const result = await runPilot(
        {
          config: unauthConfig,
          quiet: true,
        },
        {
          browserLauncher: async () => {
            browserLaunched = true;
          },
        },
      );

      expect(result.exitCode).toBe(1);
      expect(result.preflightResult.status).toBe('blocked');
      expect(result.executed).toBe(false);
      expect(result.browserLaunchAttempts).toBe(0);
      expect(browserLaunched).toBe(false);
      expect(result.message).toContain('authorization');
    });

    it('strictly refuses configuration with prohibited targetEnvironment: production', async () => {
      let browserLaunched = false;
      const config = {
        ...makeValidLocalConfig(),
        targetEnvironment: 'production' as any,
      };

      const result = await runPilot(
        {
          config,
          quiet: true,
        },
        {
          browserLauncher: async () => {
            browserLaunched = true;
          },
        },
      );

      expect(result.exitCode).toBe(1);
      expect(result.preflightResult.status).toBe('invalid');
      expect(result.executed).toBe(false);
      expect(result.browserLaunchAttempts).toBe(0);
      expect(browserLaunched).toBe(false);
    });

    it('strictly refuses dangerous journey actions (e.g. checkout, pay)', async () => {
      let browserLaunched = false;
      const dangerousConfig: PilotConfiguration = {
        ...makeValidLocalConfig(),
        allowedJourneys: [
          {
            id: 'j-unsafe',
            goal: 'submit payment and buy item',
            origin: 'http://127.0.0.1:4040',
            allowedActions: ['navigate', 'checkout', 'pay'],
            forbiddenActions: [],
          },
        ],
      };

      const result = await runPilot(
        {
          config: dangerousConfig,
          quiet: true,
        },
        {
          browserLauncher: async () => {
            browserLaunched = true;
          },
        },
      );

      expect(result.exitCode).toBe(1);
      expect(result.preflightResult.status).toBe('invalid');
      expect(result.executed).toBe(false);
      expect(result.browserLaunchAttempts).toBe(0);
      expect(browserLaunched).toBe(false);
    });
  });

  describe('3. Injected Journey Executor & Report Directory Integration', () => {
    it('writes execution.json to reportDir when injected journey executor runs', async () => {
      const config = makeValidLocalConfig();
      const reportDir = join(tempDir, 'pilot-reports');

      const dummyReport = cleanExecution();

      const result = await runPilot(
        {
          config,
          reportDir,
          quiet: true,
        },
        {
          journeyExecutor: async () => dummyReport,
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.executed).toBe(true);
      expect(result.browserLaunchAttempts).toBe(1);
      expect(result.artifactPaths?.execution).toBeDefined();

      const savedReportJson = await readFile(result.artifactPaths!.execution!, 'utf8');
      const savedReport = JSON.parse(savedReportJson);
      expect(savedReport.schemaVersion).toBe('1.0');
      expect(savedReport.goal).toBe('Try to complete checkout');
    });

    it('creates no execution or evidence reports when preflight gate blocks execution', async () => {
      const reportDir = join(tempDir, 'refused-reports');
      const blockedConfig = makeBlockedStagingConfig();

      const result = await runPilot({
        config: blockedConfig,
        reportDir,
        quiet: true,
      });

      expect(result.exitCode).toBe(1);
      expect(result.executed).toBe(false);
      expect(result.artifactPaths).toBeUndefined();

      // Ensure directory was either not created or contains zero reports
      try {
        const { readdir } = await import('node:fs/promises');
        const files = await readdir(reportDir);
        expect(files).toHaveLength(0);
      } catch {
        // Directory not created is expected and correct
      }
    });
  });

  describe('4. Baseline Validation Refusal & Honesty', () => {
    it('refuses baseline candidate when unverified assertions are present and --allow-unverified-assertions is not passed', () => {
      const plan = checkoutJourney();
      const exec = cleanExecution({
        verification: {
          status: 'partial',
          complete: false,
          executedSteps: 1,
          passedSteps: 1,
          failedSteps: 0,
          blockedSteps: 0,
          skippedSteps: 1,
          unverifiedAssertions: 1,
          unverifiedStepIds: ['step-002'],
          coverage: 'executed-steps-only',
        },
      });
      const anomalies = anomalyReportWith([]);

      const resultWithoutFlag = validateBaselineCandidate({
        execution: exec,
        journey: plan,
        anomalies,
        acceptedSignalIds: [],
        allowUnverifiedAssertions: false,
      });

      expect(resultWithoutFlag.safe).toBe(false);
      expect(resultWithoutFlag.blockers.some((b) => b.includes('unverified'))).toBe(true);

      const resultWithFlag = validateBaselineCandidate({
        execution: exec,
        journey: plan,
        anomalies,
        acceptedSignalIds: [],
        allowUnverifiedAssertions: true,
      });

      expect(resultWithFlag.safe).toBe(true);
      expect(resultWithFlag.partial).toBe(true);
    });
  });

  describe('5. CLI Command Integration & Argument Handling', () => {
    it('CLI exit 0: preflight-only on valid local config', async () => {
      const configPath = join(tempDir, 'valid-local.json');
      await writeFile(configPath, JSON.stringify(makeValidLocalConfig()), 'utf8');

      const code = await runPilotCommand(['--config', configPath, '--preflight-only']);
      expect(code).toBe(0);
    });

    it('CLI exit 1: safety gate blocks unapproved staging target', async () => {
      const configPath = join(tempDir, 'blocked-staging.json');
      await writeFile(configPath, JSON.stringify(makeBlockedStagingConfig()), 'utf8');

      const code = await runPilotCommand(['--config', configPath]);
      expect(code).toBe(1);
    });

    it('CLI exit 2: missing required arguments', async () => {
      const code = await runPilotCommand([]);
      expect(code).toBe(2);
    });

    it('CLI exit 2: unknown flag', async () => {
      const configPath = join(tempDir, 'valid-local.json');
      await writeFile(configPath, JSON.stringify(makeValidLocalConfig()), 'utf8');

      const code = await runPilotCommand(['--config', configPath, '--unrecognized-flag']);
      expect(code).toBe(2);
    });

    it('CLI exit 2: unreadable or nonexistent config file', async () => {
      const code = await runPilotCommand(['--config', join(tempDir, 'nonexistent-config.json')]);
      expect(code).toBe(2);
    });

    it('pilot-preflight CLI: exits 0 for valid local configuration', async () => {
      const configPath = join(tempDir, 'valid-local.json');
      await writeFile(configPath, JSON.stringify(makeValidLocalConfig()), 'utf8');

      const code = await runPreflightCommand(['--config', configPath]);
      expect(code).toBe(0);
    });

    it('pilot CLI: parses --pipeline and --baseline arguments cleanly', () => {
      const parsed = parsePilotArgs([
        '--config',
        'test-config.json',
        '--pipeline',
        '--baseline',
        'baseline.json',
      ]);

      expect(parsed.valid).toBe(true);
      expect(parsed.pipeline).toBe(true);
      expect(parsed.baselinePath).toBe('baseline.json');
    });
  });

  describe('6. Evidence Immutability & Trust Invariants', () => {
    it('guarantees input journey files are byte-identical before and after pilot run', async () => {
      const plan = checkoutJourney();
      const planPath = join(tempDir, 'test-journey.json');
      await writeFile(planPath, JSON.stringify(plan, null, 2), 'utf8');

      const bytesBefore = await readFile(planPath);
      const hashBefore = createHash('sha256').update(bytesBefore).digest('hex');

      const config = makeValidLocalConfig();
      const configPath = join(tempDir, 'test-config.json');
      await writeFile(configPath, JSON.stringify(config), 'utf8');

      await runPilot(
        {
          config: configPath,
          journeyPath: planPath,
          quiet: true,
        },
        {
          journeyExecutor: async () => cleanExecution(),
        },
      );

      const bytesAfter = await readFile(planPath);
      const hashAfter = createHash('sha256').update(bytesAfter).digest('hex');
      expect(hashBefore).toBe(hashAfter);
      expect(bytesBefore.equals(bytesAfter)).toBe(true);
    });

    it('redacts sensitive credentials from preflight and refusal messages', async () => {
      const configWithSecret: PilotConfiguration = {
        targetUrl: 'http://user:supersecretpass@127.0.0.1:4040/shop',
        targetName: 'Config with Exposed Credentials',
        targetEnvironment: 'local',
        allowedOrigins: ['http://127.0.0.1:4040'],
        allowedJourneys: [
          {
            id: 'j-01',
            goal: 'test',
            origin: 'http://127.0.0.1:4040',
            allowedActions: ['navigate'],
            forbiddenActions: ['checkout', 'payment'],
          },
        ],
        forbiddenActions: ['payment', 'checkout', 'account_deletion'],
      };

      const result = await runPilot({
        config: configWithSecret,
        quiet: true,
      });

      expect(result.exitCode).toBe(1);
      expect(result.preflightResult.status).toBe('invalid');
      expect(result.message).not.toContain('supersecretpass');
    });

    it('proves pure runner and gate modules have zero Playwright, network, or external imports', () => {
      const files = [
        'src/pilot/types.ts',
        'src/pilot/gate.ts',
        'src/pilot/runner.ts',
        'src/cli/pilotCommand.ts',
      ];

      for (const file of files) {
        const source = readFileSync(join(process.cwd(), file), 'utf8');
        expect(source).not.toContain("from 'playwright'");
        expect(source).not.toContain('from "playwright"');
        expect(source).not.toContain('node:http');
        expect(source).not.toContain('node:https');
        expect(source).not.toContain('fetch(');
      }
    });
  });
});
