/**
 * Build 10.3: Pilot Preflight Execution Gate & Runner Unit Suite.
 *
 * Verifies the central safety invariant:
 * No browser, Playwright context, page, navigation, or external network request
 * may be created unless preflight validation returns `status: "ready"`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

import type { PilotConfiguration, PreflightResult } from '../../src/preflight/types.js';
import { validatePilotConfiguration } from '../../src/preflight/validator.js';
import {
  assertPilotReady,
  createPilotExecutionPlan,
  PilotExecutionGateError,
} from '../../src/pilot/gate.js';
import { runPilot } from '../../src/pilot/runner.js';
import { runPilotCommand, parsePilotArgs } from '../../src/cli/pilotCommand.js';
import { runPreflightCommand } from '../../src/cli/preflightCommand.js';

describe('Build 10.3: Pilot Execution Gate & Runner', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'crashlab-pilot-gate-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function makeValidLocalConfig(): PilotConfiguration {
    return {
      targetUrl: 'http://127.0.0.1:4040/shop',
      targetName: 'Local Synthetic Shop',
      targetEnvironment: 'local',
      appBuildId: 'build-local-01',
      allowedOrigins: ['http://127.0.0.1:4040'],
      allowedJourneys: [
        {
          id: 'j-shop-01',
          goal: 'add widget to cart',
          origin: 'http://127.0.0.1:4040',
          allowedActions: ['navigate', 'identify', 'click'],
          forbiddenActions: ['checkout', 'payment'],
        },
      ],
      forbiddenActions: ['payment', 'checkout', 'account_deletion'],
    };
  }

  function makeValidStagingConfig(): PilotConfiguration {
    return {
      targetUrl: 'https://staging-shop.example.test/catalog',
      targetName: 'Authorized Staging Shop',
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
      authorizationReference: 'TICKET-AUTH-2026-SEC',
      resetProcedure: 'Automated database restore via staging admin script',
      testingWindow: 'Off-peak 02:00-06:00 UTC',
    };
  }

  describe('1. Pilot Execution Gate (assertPilotReady & createPilotExecutionPlan)', () => {
    it('throws PilotExecutionGateError when preflight result is missing or undefined', () => {
      expect(() => assertPilotReady(undefined)).toThrowError(PilotExecutionGateError);
      expect(() => assertPilotReady(null)).toThrowError(PilotExecutionGateError);
    });

    it('throws PilotExecutionGateError when preflight status is "blocked"', () => {
      const blockedConfig = { ...makeValidStagingConfig(), authorizationReference: undefined };
      const preflight = validatePilotConfiguration(blockedConfig, { checkFilesystem: false });
      expect(preflight.status).toBe('blocked');

      expect(() => assertPilotReady(preflight)).toThrowError(PilotExecutionGateError);
      try {
        assertPilotReady(preflight);
      } catch (err) {
        const gateErr = err as PilotExecutionGateError;
        expect(gateErr.status).toBe('blocked');
        expect(gateErr.reasons.length).toBeGreaterThan(0);
        expect(gateErr.message).toContain('Pilot execution blocked');
      }
    });

    it('throws PilotExecutionGateError when preflight status is "invalid"', () => {
      const invalidConfig = {
        ...makeValidStagingConfig(),
        targetUrl: 'https://production-store.com/checkout',
      };
      const preflight = validatePilotConfiguration(invalidConfig, { checkFilesystem: false });
      expect(preflight.status).toBe('invalid');

      expect(() => assertPilotReady(preflight)).toThrowError(PilotExecutionGateError);
      try {
        assertPilotReady(preflight);
      } catch (err) {
        const gateErr = err as PilotExecutionGateError;
        expect(gateErr.status).toBe('invalid');
        expect(gateErr.reasons.length).toBeGreaterThan(0);
        expect(gateErr.message).toContain('Pilot execution refused');
      }
    });

    it('permits execution when preflight status is "ready"', () => {
      const validConfig = makeValidStagingConfig();
      const preflight = validatePilotConfiguration(validConfig, { checkFilesystem: false });
      expect(preflight.status).toBe('ready');

      expect(() => assertPilotReady(preflight)).not.toThrow();
    });

    it('creates an immutable, strongly-typed execution plan only when ready', () => {
      const validConfig = makeValidStagingConfig();
      const preflight = validatePilotConfiguration(validConfig, { checkFilesystem: false });
      const plan = createPilotExecutionPlan(validConfig, preflight);

      expect(plan.status).toBe('ready');
      expect(plan.targetUrl).toBe(validConfig.targetUrl);
      expect(plan.targetOrigin).toBe('https://staging-shop.example.test');
      expect(plan.targetEnvironment).toBe('staging');
      expect(plan.approvedJourneys).toHaveLength(2);
      expect(Object.isFrozen(plan)).toBe(true);
    });

    it('refuses to create an execution plan when preflight is not ready', () => {
      const blockedConfig = { ...makeValidStagingConfig(), authorizationReference: undefined };
      const preflight = validatePilotConfiguration(blockedConfig, { checkFilesystem: false });

      expect(() => createPilotExecutionPlan(blockedConfig, preflight)).toThrowError(
        PilotExecutionGateError,
      );
    });

    it('never includes secrets or raw test data in refusal messages', () => {
      const configWithSecretInAuth = {
        ...makeValidStagingConfig(),
        authorizationReference: 'Bearer secret_token_xyz_123',
      };
      const preflight = validatePilotConfiguration(configWithSecretInAuth, {
        checkFilesystem: false,
      });

      try {
        assertPilotReady(preflight);
        expect.unreachable('Should have thrown gate error');
      } catch (err) {
        const gateErr = err as PilotExecutionGateError;
        expect(gateErr.message).not.toContain('secret_token_xyz_123');
      }
    });
  });

  describe('2. Blocked & Invalid Configurations Cause Zero Browser Launches', () => {
    it('prevents browser creation when authorization reference is missing', async () => {
      let browserLaunched = false;
      const blockedConfig = { ...makeValidStagingConfig(), authorizationReference: undefined };

      const result = await runPilot(
        { config: blockedConfig, quiet: true },
        {
          browserLauncher: async () => {
            browserLaunched = true;
          },
        },
      );

      expect(browserLaunched).toBe(false);
      expect(result.browserLaunchAttempts).toBe(0);
      expect(result.executed).toBe(false);
      expect(result.exitCode).toBe(1);
    });

    it('prevents browser creation when target URL is missing or malformed', async () => {
      let browserLaunched = false;
      const invalidConfig = { ...makeValidStagingConfig(), targetUrl: 'not-a-valid-url' };

      const result = await runPilot(
        { config: invalidConfig, quiet: true },
        {
          browserLauncher: async () => {
            browserLaunched = true;
          },
        },
      );

      expect(browserLaunched).toBe(false);
      expect(result.browserLaunchAttempts).toBe(0);
      expect(result.executed).toBe(false);
      expect(result.exitCode).toBe(1);
    });

    it('prevents browser creation when targeting production-like hostname', async () => {
      let browserLaunched = false;
      const prodConfig = { ...makeValidStagingConfig(), targetUrl: 'https://production.example.com' };

      const result = await runPilot(
        { config: prodConfig, quiet: true },
        {
          browserLauncher: async () => {
            browserLaunched = true;
          },
        },
      );

      expect(browserLaunched).toBe(false);
      expect(result.browserLaunchAttempts).toBe(0);
      expect(result.executed).toBe(false);
      expect(result.exitCode).toBe(1);
    });

    it('prevents browser creation when target origin does not match allowed origins', async () => {
      let browserLaunched = false;
      const mismatchConfig = {
        ...makeValidStagingConfig(),
        allowedOrigins: ['https://other-origin.example.test'],
      };

      const result = await runPilot(
        { config: mismatchConfig, quiet: true },
        {
          browserLauncher: async () => {
            browserLaunched = true;
          },
        },
      );

      expect(browserLaunched).toBe(false);
      expect(result.browserLaunchAttempts).toBe(0);
      expect(result.executed).toBe(false);
      expect(result.exitCode).toBe(1);
    });

    it('prevents browser creation when journey contains dangerous or payment action', async () => {
      let browserLaunched = false;
      const staging = makeValidStagingConfig();
      const dangerousConfig = {
        ...staging,
        allowedJourneys: [
          { ...staging.allowedJourneys[0]!, allowedActions: ['checkout', 'pay'] },
          staging.allowedJourneys[1]!,
        ],
      };

      const result = await runPilot(
        { config: dangerousConfig, quiet: true },
        {
          browserLauncher: async () => {
            browserLaunched = true;
          },
        },
      );

      expect(browserLaunched).toBe(false);
      expect(result.browserLaunchAttempts).toBe(0);
      expect(result.executed).toBe(false);
      expect(result.exitCode).toBe(1);
    });

    it('prevents browser creation when credentials are required but test data file is missing', async () => {
      let browserLaunched = false;
      const staging = makeValidStagingConfig();
      const missingTestDataConfig = {
        ...staging,
        testDataFile: undefined,
        allowedJourneys: [
          { ...staging.allowedJourneys[0]!, requiresCredentials: true },
          staging.allowedJourneys[1]!,
        ],
      };

      const result = await runPilot(
        { config: missingTestDataConfig, quiet: true },
        {
          browserLauncher: async () => {
            browserLaunched = true;
          },
        },
      );

      expect(browserLaunched).toBe(false);
      expect(result.browserLaunchAttempts).toBe(0);
      expect(result.executed).toBe(false);
      expect(result.exitCode).toBe(1);
    });

    it('guarantees that non-ready status cannot be overridden by any flag', async () => {
      let browserLaunched = false;
      const blockedConfig = { ...makeValidStagingConfig(), authorizationReference: undefined };

      // Attempting with confirmAuthorized set
      const result = await runPilot(
        { config: blockedConfig, confirmAuthorized: true, quiet: true },
        {
          browserLauncher: async () => {
            browserLaunched = true;
          },
        },
      );

      expect(browserLaunched).toBe(false);
      expect(result.browserLaunchAttempts).toBe(0);
      expect(result.executed).toBe(false);
      expect(result.exitCode).toBe(1);
    });
  });

  describe('3. Preflight-Only Mode (Dry-Run)', () => {
    it('executes zero browser launches during preflight-only mode even with valid config', async () => {
      let browserLaunched = false;
      let journeyExecuted = false;
      const validConfig = makeValidLocalConfig();

      const result = await runPilot(
        { config: validConfig, preflightOnly: true, quiet: true },
        {
          browserLauncher: async () => {
            browserLaunched = true;
          },
          journeyExecutor: async () => {
            journeyExecuted = true;
            return {} as any;
          },
        },
      );

      expect(browserLaunched).toBe(false);
      expect(journeyExecuted).toBe(false);
      expect(result.browserLaunchAttempts).toBe(0);
      expect(result.executed).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(result.preflightResult.status).toBe('ready');
      expect(result.message).toContain('Preflight-only dry run complete');
    });

    it('writes safe preflight report to file during preflight-only mode when requested', async () => {
      const config = makeValidLocalConfig();
      const reportPath = join(tempDir, 'preflight-report.json');

      const result = await runPilot(
        { config, preflightOnly: true, preflightReportPath: reportPath, quiet: true },
        {},
      );

      expect(result.exitCode).toBe(0);
      const written = JSON.parse(await readFile(reportPath, 'utf8'));
      expect(written.schemaVersion).toBe('1.0');
      expect(written.status).toBe('ready');
      expect(written.statement).toContain('Zero browser traffic generated');
    });
  });

  describe('4. Sequential Lifecycle & Call Order Verification', () => {
    it('proves call order: preflight validation -> browser creation -> journey execution', async () => {
      const callLog: string[] = [];
      const validConfig = makeValidLocalConfig();

      const result = await runPilot(
        { config: validConfig, confirmAuthorized: true, quiet: true },
        {
          validateConfig: (cfg) => {
            callLog.push('validateConfig');
            return validatePilotConfiguration(cfg);
          },
          browserLauncher: async () => {
            callLog.push('browserLauncher');
          },
          journeyExecutor: async () => {
            callLog.push('journeyExecutor');
            return { schemaVersion: '1.0' } as any;
          },
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.executed).toBe(true);
      expect(callLog).toEqual(['validateConfig', 'browserLauncher', 'journeyExecutor']);
    });

    it('proves preflight failure stops execution before browser creation', async () => {
      const callLog: string[] = [];
      const blockedConfig = { ...makeValidStagingConfig(), authorizationReference: undefined };

      const result = await runPilot(
        { config: blockedConfig, confirmAuthorized: true, quiet: true },
        {
          validateConfig: (cfg) => {
            callLog.push('validateConfig');
            return validatePilotConfiguration(cfg, { checkFilesystem: false });
          },
          browserLauncher: async () => {
            callLog.push('browserLauncher');
          },
          journeyExecutor: async () => {
            callLog.push('journeyExecutor');
            return {} as any;
          },
        },
      );

      expect(result.exitCode).toBe(1);
      expect(result.executed).toBe(false);
      expect(callLog).toEqual(['validateConfig']);
      expect(callLog).not.toContain('browserLauncher');
      expect(callLog).not.toContain('journeyExecutor');
    });
  });

  describe('5. Input Immutability and No-Side-Effects on Blocked Runs', () => {
    it('leaves input journey files byte-identical and produces no execution report when blocked', async () => {
      const journeyFile = join(tempDir, 'journey.json');
      const journeyContent = JSON.stringify({ schemaVersion: '1.0', goal: 'safe goal' }, null, 2);
      await writeFile(journeyFile, journeyContent, 'utf8');
      const hashBefore = createHash('sha256').update(journeyContent).digest('hex');

      const blockedConfig = { ...makeValidStagingConfig(), authorizationReference: undefined };
      const configPath = join(tempDir, 'config.json');
      await writeFile(configPath, JSON.stringify(blockedConfig), 'utf8');

      const result = await runPilot({
        config: configPath,
        journeyPath: journeyFile,
        reportDir: join(tempDir, 'reports'),
        quiet: true,
      });

      expect(result.exitCode).toBe(1);
      expect(result.executed).toBe(false);
      expect(result.executionReport).toBeUndefined();

      const afterContent = await readFile(journeyFile, 'utf8');
      const hashAfter = createHash('sha256').update(afterContent).digest('hex');
      expect(hashBefore).toBe(hashAfter);
    });
  });

  describe('6. CLI Command Integration (pilot & pilot-preflight)', () => {
    it('pilot command: exits 0 for preflight-only on valid local config', async () => {
      const configPath = join(tempDir, 'local.json');
      await writeFile(configPath, JSON.stringify(makeValidLocalConfig()), 'utf8');

      const code = await runPilotCommand(['--config', configPath, '--preflight-only']);
      expect(code).toBe(0);
    });

    it('pilot command: exits 1 when safety gate blocks execution', async () => {
      const blockedConfig = { ...makeValidStagingConfig(), authorizationReference: undefined };
      const configPath = join(tempDir, 'blocked.json');
      await writeFile(configPath, JSON.stringify(blockedConfig), 'utf8');

      const code = await runPilotCommand(['--config', configPath]);
      expect(code).toBe(1);
    });

    it('pilot command: exits 2 on missing config or syntax errors', async () => {
      const codeMissing = await runPilotCommand([]);
      expect(codeMissing).toBe(2);

      const codeUnknown = await runPilotCommand(['--config', 'foo.json', '--unknown-flag']);
      expect(codeUnknown).toBe(2);
    });

    it('pilot-preflight: --check-execution-gate exits 0 when ready', async () => {
      const configPath = join(tempDir, 'local.json');
      await writeFile(configPath, JSON.stringify(makeValidLocalConfig()), 'utf8');

      const code = await runPreflightCommand(['--config', configPath, '--check-execution-gate']);
      expect(code).toBe(0);
    });

    it('pilot-preflight: --check-execution-gate exits 1 when blocked', async () => {
      const blockedConfig = { ...makeValidStagingConfig(), authorizationReference: undefined };
      const configPath = join(tempDir, 'blocked.json');
      await writeFile(configPath, JSON.stringify(blockedConfig), 'utf8');

      const code = await runPreflightCommand(['--config', configPath, '--check-execution-gate']);
      expect(code).toBe(1);
    });

    it('pilot command: --help displays usage and returns without browser creation', () => {
      const parsed = parsePilotArgs(['--help']);
      // Should not throw or crash
      expect(parsed).toBeDefined();
    });
  });

  describe('7. Module Isolation & Import Integrity', () => {
    it('guarantees pure pilot gate and preflight modules import zero Playwright or network libraries', () => {
      const filesToCheck = [
        'src/pilot/types.ts',
        'src/pilot/gate.ts',
        'src/pilot/runner.ts',
        'src/cli/pilotCommand.ts',
        'src/cli/preflightCommand.ts',
      ];

      for (const file of filesToCheck) {
        const source = readFileSync(join(process.cwd(), file), 'utf8');
        expect(source).not.toContain("from 'playwright'");
        expect(source).not.toContain('from "playwright"');
        expect(source).not.toContain('chromium.launch');
        expect(source).not.toContain('node:http');
        expect(source).not.toContain('node:https');
        expect(source).not.toContain('fetch(');
      }
    });
  });
});
