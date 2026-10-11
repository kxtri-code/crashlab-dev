/**
 * Build 10.2: Staging Pilot Configuration Validator Unit Suite.
 *
 * Validates deterministic local preflight safety checks across:
 *  - Configuration loading (JSON and key-value formats)
 *  - Target URL validation (schemes, credentials, fragments, production safety)
 *  - Origin validation (wildcards, paths, target membership, deduplication)
 *  - Environment validation (local vs staging/qa/demo, prohibited production)
 *  - Journey validation (bounds, uniqueness, dangerous actions, conflicts)
 *  - Forbidden action coverage (payment, deletion, credentials)
 *  - Secret redaction and test-data safety
 *  - Deterministic report generation
 *  - CLI commands and exit codes (0, 1, 2)
 *  - Zero browser and network activity invariants
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

import type { PilotConfiguration } from '../../src/preflight/types.js';
import { loadPilotConfiguration, ConfigurationLoadError } from '../../src/preflight/loader.js';
import {
  validatePilotConfiguration,
  buildPreflightReport,
} from '../../src/preflight/validator.js';
import { formatPreflightSummary, writePreflightReport } from '../../src/preflight/report.js';
import { runPreflightCommand, parsePreflightArgs } from '../../src/cli/preflightCommand.js';

describe('Build 10.2: Staging Pilot Preflight Validator', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'crashlab-preflight-test-'));
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

  function makeValidStagingConfig(testDataPath?: string): PilotConfiguration {
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
      testDataFile: testDataPath,
    };
  }

  describe('1. Configuration Loading', () => {
    it('loads a valid JSON configuration file', async () => {
      const config = makeValidLocalConfig();
      const configPath = join(tempDir, 'pilot.config.json');
      await writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

      const loaded = await loadPilotConfiguration(configPath);
      expect(loaded.targetUrl).toBe('http://127.0.0.1:4040/shop');
      expect(loaded.targetEnvironment).toBe('local');
      expect(loaded.allowedJourneys).toHaveLength(1);
    });

    it('loads a valid key-value (.env style) configuration file', async () => {
      const configPath = join(tempDir, 'pilot.conf');
      const content = `
# Pilot Configuration
TARGET_URL=http://127.0.0.1:4040/shop
TARGET_NAME=Local Shop
TARGET_ENVIRONMENT=local
ALLOWED_ORIGINS=http://127.0.0.1:4040
FORBIDDEN_ACTIONS=payment,checkout,account_deletion
ALLOWED_JOURNEYS=[{"id":"j1","goal":"add to cart","origin":"http://127.0.0.1:4040","allowedActions":["click"],"forbiddenActions":["checkout"]}]
`;
      await writeFile(configPath, content, 'utf8');

      const loaded = await loadPilotConfiguration(configPath);
      expect(loaded.targetUrl).toBe('http://127.0.0.1:4040/shop');
      expect(loaded.allowedOrigins).toEqual(['http://127.0.0.1:4040']);
      expect(loaded.forbiddenActions).toEqual(['payment', 'checkout', 'account_deletion']);
      expect(loaded.allowedJourneys).toHaveLength(1);
      expect(loaded.allowedJourneys[0]?.id).toBe('j1');
    });

    it('throws CONFIG_NOT_FOUND when configuration file does not exist', async () => {
      const missingPath = join(tempDir, 'nonexistent-config.json');
      await expect(loadPilotConfiguration(missingPath)).rejects.toThrowError(
        /not found at/i,
      );
    });

    it('throws MALFORMED_JSON when JSON syntax is corrupted', async () => {
      const configPath = join(tempDir, 'corrupt.json');
      await writeFile(configPath, '{ targetUrl: incomplete... ', 'utf8');
      await expect(loadPilotConfiguration(configPath)).rejects.toThrowError(
        /Malformed JSON/i,
      );
    });

    it('throws UNKNOWN_KEY when an unknown configuration key is present', async () => {
      const configPath = join(tempDir, 'unknown-key.json');
      await writeFile(
        configPath,
        JSON.stringify({
          targetUrl: 'http://127.0.0.1:4040',
          targetName: 'Test',
          targetEnvironment: 'local',
          UNKNOWN_EXTRA_FLAG: 'not-allowed',
        }),
        'utf8',
      );
      await expect(loadPilotConfiguration(configPath)).rejects.toThrowError(
        /Unknown configuration key 'UNKNOWN_EXTRA_FLAG'/i,
      );
    });

    it('throws DUPLICATE_KEY when key is repeated in key-value format', async () => {
      const configPath = join(tempDir, 'dup.conf');
      const content = `
TARGET_URL=http://127.0.0.1:4040
TARGET_URL=http://127.0.0.1:4040
TARGET_NAME=Test
TARGET_ENVIRONMENT=local
`;
      await writeFile(configPath, content, 'utf8');
      await expect(loadPilotConfiguration(configPath)).rejects.toThrowError(
        /Duplicate configuration key 'TARGET_URL'/i,
      );
    });
  });

  describe('2. Target URL Validation', () => {
    it('validates a correct loopback URL for local environment', () => {
      const config = makeValidLocalConfig();
      const result = validatePilotConfiguration(config, { checkFilesystem: false });
      expect(result.valid).toBe(true);
      expect(result.status).toBe('ready');
      expect(result.targetOrigin).toBe('http://127.0.0.1:4040');
    });

    it('validates a correct HTTPS staging URL with staging indicator', () => {
      const config = makeValidStagingConfig();
      const result = validatePilotConfiguration(config, { checkFilesystem: false });
      expect(result.valid).toBe(true);
      expect(result.status).toBe('ready');
      expect(result.targetOrigin).toBe('https://staging-shop.example.test');
    });

    it('rejects missing target URL', () => {
      const config = { ...makeValidLocalConfig(), targetUrl: '' };
      const result = validatePilotConfiguration(config, { checkFilesystem: false });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.code === 'MISSING_TARGET_URL')).toBe(true);
    });

    it('rejects malformed target URL syntax', () => {
      const config = { ...makeValidLocalConfig(), targetUrl: 'not a valid url' };
      const result = validatePilotConfiguration(config, { checkFilesystem: false });
      expect(result.valid).toBe(false);
      expect(result.status).toBe('invalid');
      expect(result.errors.some((e) => e.code === 'MALFORMED_TARGET_URL')).toBe(true);
    });

    it('rejects prohibited URL schemes (file, javascript, data, ftp)', () => {
      for (const scheme of ['file:///tmp/app', 'javascript:alert(1)', 'data:text/html,test', 'ftp://host/app']) {
        const config = { ...makeValidLocalConfig(), targetUrl: scheme };
        const result = validatePilotConfiguration(config, { checkFilesystem: false });
        expect(result.valid).toBe(false);
        expect(result.status).toBe('invalid');
      }
    });

    it('rejects URLs with embedded credentials', () => {
      const config = {
        ...makeValidLocalConfig(),
        targetUrl: 'http://admin:secret123@127.0.0.1:4040/shop',
      };
      const result = validatePilotConfiguration(config, { checkFilesystem: false });
      expect(result.valid).toBe(false);
      expect(result.status).toBe('invalid');
      expect(result.errors.some((e) => e.code === 'URL_CREDENTIALS_EXPOSED')).toBe(true);
    });

    it('rejects URLs with URL fragments', () => {
      const config = {
        ...makeValidLocalConfig(),
        targetUrl: 'http://127.0.0.1:4040/shop#section-1',
      };
      const result = validatePilotConfiguration(config, { checkFilesystem: false });
      expect(result.valid).toBe(false);
      expect(result.status).toBe('invalid');
      expect(result.errors.some((e) => e.code === 'URL_FRAGMENT_PROHIBITED')).toBe(true);
    });

    it('rejects HTTP (non-HTTPS) for staging environment', () => {
      const config = {
        ...makeValidStagingConfig(),
        targetUrl: 'http://staging-shop.example.test/catalog',
        allowedOrigins: ['http://staging-shop.example.test'],
      };
      const result = validatePilotConfiguration(config, { checkFilesystem: false });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.code === 'HTTPS_REQUIRED')).toBe(true);
    });

    it('rejects local loopback hosts for staging environment', () => {
      const config = {
        ...makeValidStagingConfig(),
        targetUrl: 'https://127.0.0.1:4040/catalog',
        allowedOrigins: ['https://127.0.0.1:4040'],
      };
      const result = validatePilotConfiguration(config, { checkFilesystem: false });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.code === 'LOCAL_HOST_IN_STAGING_ENV')).toBe(true);
    });

    it('rejects production-looking hostnames in staging environment', () => {
      const prodTargets = [
        'https://ahibi.com',
        'https://app.example.com',
        'https://prod.mybank.org',
        'https://live.shop.co',
      ];
      for (const target of prodTargets) {
        const origin = new URL(target).origin;
        const config = {
          ...makeValidStagingConfig(),
          targetUrl: target,
          allowedOrigins: [origin],
          allowedJourneys: [
            {
              id: 'j1',
              goal: 'browse catalog',
              origin,
              allowedActions: ['navigate'],
              forbiddenActions: ['checkout'],
            },
            {
              id: 'j2',
              goal: 'search items',
              origin,
              allowedActions: ['navigate'],
              forbiddenActions: ['checkout'],
            },
          ],
        };
        const result = validatePilotConfiguration(config, { checkFilesystem: false });
        expect(result.valid).toBe(false);
        expect(result.status).toBe('invalid');
        expect(result.errors.some((e) => e.code === 'PRODUCTION_HOSTNAME_REJECTED')).toBe(true);
      }
    });
  });

  describe('3. Origin Validation', () => {
    it('rejects empty allowed origins list', () => {
      const config = { ...makeValidLocalConfig(), allowedOrigins: [] };
      const result = validatePilotConfiguration(config, { checkFilesystem: false });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.code === 'EMPTY_ALLOWED_ORIGINS')).toBe(true);
    });

    it('rejects wildcard allowed origins', () => {
      const config = { ...makeValidLocalConfig(), allowedOrigins: ['*'] };
      const result = validatePilotConfiguration(config, { checkFilesystem: false });
      expect(result.valid).toBe(false);
      expect(result.status).toBe('invalid');
      expect(result.errors.some((e) => e.code === 'WILDCARD_ORIGIN_PROHIBITED')).toBe(true);
    });

    it('rejects allowed origins containing URL paths or queries', () => {
      const config = {
        ...makeValidLocalConfig(),
        allowedOrigins: ['http://127.0.0.1:4040/some/path'],
      };
      const result = validatePilotConfiguration(config, { checkFilesystem: false });
      expect(result.valid).toBe(false);
      expect(result.status).toBe('invalid');
      expect(result.errors.some((e) => e.code === 'MALFORMED_ORIGIN')).toBe(true);
    });

    it('rejects configuration when target origin is not in allowed origins', () => {
      const config = {
        ...makeValidLocalConfig(),
        targetUrl: 'http://127.0.0.1:4040/shop',
        allowedOrigins: ['http://127.0.0.1:5000'],
        allowedJourneys: [
          {
            id: 'j1',
            goal: 'test',
            origin: 'http://127.0.0.1:5000',
            allowedActions: ['navigate'],
            forbiddenActions: ['checkout'],
          },
        ],
      };
      const result = validatePilotConfiguration(config, { checkFilesystem: false });
      expect(result.valid).toBe(false);
      expect(result.status).toBe('invalid');
      expect(result.errors.some((e) => e.code === 'TARGET_ORIGIN_NOT_ALLOWED')).toBe(true);
    });

    it('normalizes and deduplicates allowed origins deterministically', () => {
      const config = {
        ...makeValidLocalConfig(),
        allowedOrigins: [
          'http://127.0.0.1:4040',
          'http://127.0.0.1:4040/',
          'http://127.0.0.1:4040',
        ],
      };
      const result = validatePilotConfiguration(config, { checkFilesystem: false });
      expect(result.valid).toBe(true);
      expect(result.metadata.allowedOrigins).toEqual(['http://127.0.0.1:4040']);
    });
  });

  describe('4. Environment Validation', () => {
    it('accepts valid environments: local, demo, qa, staging', () => {
      for (const env of ['local', 'demo', 'qa', 'staging'] as const) {
        const config =
          env === 'local'
            ? makeValidLocalConfig()
            : {
                ...makeValidStagingConfig(),
                targetEnvironment: env,
              };
        const result = validatePilotConfiguration(config, { checkFilesystem: false });
        expect(result.valid).toBe(true);
        expect(result.targetEnvironment).toBe(env);
      }
    });

    it('rejects prohibited production environments (production, prod, live)', () => {
      for (const env of ['production', 'prod', 'live', 'unknown_env'] as any[]) {
        const config = { ...makeValidLocalConfig(), targetEnvironment: env };
        const result = validatePilotConfiguration(config, { checkFilesystem: false });
        expect(result.valid).toBe(false);
        expect(result.status).toBe('invalid');
        expect(result.errors.some((e) => e.code === 'INVALID_ENVIRONMENT')).toBe(true);
      }
    });
  });

  describe('5. Journey Validation', () => {
    it('requires 2 to 4 journeys for staging pilots', () => {
      // 1 journey in staging -> rejected
      const oneJourney = {
        ...makeValidStagingConfig(),
        allowedJourneys: [makeValidStagingConfig().allowedJourneys[0]!],
      };
      const res1 = validatePilotConfiguration(oneJourney, { checkFilesystem: false });
      expect(res1.valid).toBe(false);
      expect(res1.errors.some((e) => e.code === 'INVALID_JOURNEY_COUNT')).toBe(true);

      // 5 journeys in staging -> rejected
      const baseJ = makeValidStagingConfig().allowedJourneys[0]!;
      const fiveJourneys = {
        ...makeValidStagingConfig(),
        allowedJourneys: [1, 2, 3, 4, 5].map((i) => ({ ...baseJ, id: `j-0${i}` })),
      };
      const res5 = validatePilotConfiguration(fiveJourneys, { checkFilesystem: false });
      expect(res5.valid).toBe(false);
      expect(res5.errors.some((e) => e.code === 'INVALID_JOURNEY_COUNT')).toBe(true);
    });

    it('allows 1 journey for local synthetic fixture testing', () => {
      const config = makeValidLocalConfig();
      expect(config.allowedJourneys).toHaveLength(1);
      const result = validatePilotConfiguration(config, { checkFilesystem: false });
      expect(result.valid).toBe(true);
      expect(result.status).toBe('ready');
    });

    it('rejects duplicate journey IDs', () => {
      const staging = makeValidStagingConfig();
      const config = {
        ...staging,
        allowedJourneys: [
          staging.allowedJourneys[0]!,
          { ...staging.allowedJourneys[1]!, id: staging.allowedJourneys[0]!.id },
        ],
      };
      const result = validatePilotConfiguration(config, { checkFilesystem: false });
      expect(result.valid).toBe(false);
      expect(result.status).toBe('invalid');
      expect(result.errors.some((e) => e.code === 'DUPLICATE_JOURNEY_ID')).toBe(true);
    });

    it('rejects empty or whitespace journey goals', () => {
      const staging = makeValidStagingConfig();
      const config = {
        ...staging,
        allowedJourneys: [
          { ...staging.allowedJourneys[0]!, goal: '   ' },
          staging.allowedJourneys[1]!,
        ],
      };
      const result = validatePilotConfiguration(config, { checkFilesystem: false });
      expect(result.valid).toBe(false);
      expect(result.status).toBe('invalid');
      expect(result.errors.some((e) => e.code === 'EMPTY_JOURNEY_GOAL')).toBe(true);
    });

    it('rejects dangerous, destructive, or payment actions in journeys', () => {
      const dangerousActions = [
        'checkout',
        'pay',
        'submit_payment',
        'delete_account',
        'destroy_data',
        'reset_password',
        'grant_admin',
        'send_email',
      ];

      for (const action of dangerousActions) {
        const staging = makeValidStagingConfig();
        const config = {
          ...staging,
          allowedJourneys: [
            { ...staging.allowedJourneys[0]!, allowedActions: [action] },
            staging.allowedJourneys[1]!,
          ],
        };
        const result = validatePilotConfiguration(config, { checkFilesystem: false });
        expect(result.valid).toBe(false);
        expect(result.status).toBe('invalid');
        expect(result.errors.some((e) => e.code === 'DANGEROUS_ACTION_PROHIBITED')).toBe(true);
      }
    });

    it('rejects vague or wildcard journey actions', () => {
      for (const vague of ['*', 'all', 'any', 'action', 'do_something']) {
        const staging = makeValidStagingConfig();
        const config = {
          ...staging,
          allowedJourneys: [
            { ...staging.allowedJourneys[0]!, allowedActions: [vague] },
            staging.allowedJourneys[1]!,
          ],
        };
        const result = validatePilotConfiguration(config, { checkFilesystem: false });
        expect(result.valid).toBe(false);
        expect(result.status).toBe('invalid');
        expect(result.errors.some((e) => e.code === 'VAGUE_ACTION_PROHIBITED')).toBe(true);
      }
    });

    it('rejects journey actions that conflict with global forbidden actions', () => {
      const staging = makeValidStagingConfig();
      const config = {
        ...staging,
        forbiddenActions: ['custom_forbidden_flow'],
        allowedJourneys: [
          { ...staging.allowedJourneys[0]!, allowedActions: ['custom_forbidden_flow'] },
          staging.allowedJourneys[1]!,
        ],
      };
      const result = validatePilotConfiguration(config, { checkFilesystem: false });
      expect(result.valid).toBe(false);
      expect(result.status).toBe('invalid');
      expect(result.errors.some((e) => e.code === 'ACTION_CONFLICTS_WITH_FORBIDDEN')).toBe(true);
    });

    it('rejects journey origins not present in allowed origins', () => {
      const staging = makeValidStagingConfig();
      const config = {
        ...staging,
        allowedJourneys: [
          { ...staging.allowedJourneys[0]!, origin: 'https://other-unlisted-origin.test' },
          staging.allowedJourneys[1]!,
        ],
      };
      const result = validatePilotConfiguration(config, { checkFilesystem: false });
      expect(result.valid).toBe(false);
      expect(result.status).toBe('invalid');
      expect(result.errors.some((e) => e.code === 'JOURNEY_ORIGIN_NOT_ALLOWED')).toBe(true);
    });
  });

  describe('6. Forbidden Actions Validation', () => {
    it('rejects empty forbidden actions list for staging', () => {
      const config = { ...makeValidStagingConfig(), forbiddenActions: [] };
      const result = validatePilotConfiguration(config, { checkFilesystem: false });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.code === 'EMPTY_FORBIDDEN_ACTIONS')).toBe(true);
    });

    it('rejects staging configuration missing critical safety categories', () => {
      // Missing payment
      const noPayment = {
        ...makeValidStagingConfig(),
        forbiddenActions: ['account_deletion', 'password_reset'],
      };
      const resPay = validatePilotConfiguration(noPayment, { checkFilesystem: false });
      expect(resPay.valid).toBe(false);
      expect(resPay.errors.some((e) => e.code === 'MISSING_FORBIDDEN_PAYMENT')).toBe(true);

      // Missing deletion
      const noDel = {
        ...makeValidStagingConfig(),
        forbiddenActions: ['payment', 'password_reset'],
      };
      const resDel = validatePilotConfiguration(noDel, { checkFilesystem: false });
      expect(resDel.valid).toBe(false);
      expect(resDel.errors.some((e) => e.code === 'MISSING_FORBIDDEN_DELETION')).toBe(true);

      // Missing credential
      const noCred = {
        ...makeValidStagingConfig(),
        forbiddenActions: ['payment', 'account_deletion'],
      };
      const resCred = validatePilotConfiguration(noCred, { checkFilesystem: false });
      expect(resCred.valid).toBe(false);
      expect(resCred.errors.some((e) => e.code === 'MISSING_FORBIDDEN_CREDENTIALS')).toBe(true);
    });
  });

  describe('7. Credential & Test Data Checks', () => {
    it('requires testDataFile when a journey requires test data or credentials', () => {
      const staging = makeValidStagingConfig();
      const config = {
        ...staging,
        testDataFile: undefined,
        allowedJourneys: [
          { ...staging.allowedJourneys[0]!, requiresTestData: true },
          staging.allowedJourneys[1]!,
        ],
      };
      const result = validatePilotConfiguration(config, { checkFilesystem: false });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.code === 'TEST_DATA_REQUIRED')).toBe(true);
    });

    it('verifies that testDataFile exists when filesystem check is enabled', async () => {
      const fixtureFile = join(tempDir, 'test-data.json');
      await writeFile(fixtureFile, '{"testUser":"pilot"}', 'utf8');

      const configWithRealFile = makeValidStagingConfig(fixtureFile);
      const resReal = validatePilotConfiguration(configWithRealFile, { checkFilesystem: true });
      expect(resReal.checks.find((c) => c.id === 'test_data_file_exists')?.passed).toBe(true);

      const configWithFakeFile = makeValidStagingConfig(join(tempDir, 'missing.json'));
      const resFake = validatePilotConfiguration(configWithFakeFile, { checkFilesystem: true });
      expect(resFake.valid).toBe(false);
      expect(resFake.errors.some((e) => e.code === 'TEST_DATA_FILE_NOT_FOUND')).toBe(true);
    });

    it('rejects directory traversal in testDataFile', () => {
      const config = makeValidStagingConfig('../../../etc/passwd');
      const result = validatePilotConfiguration(config, { checkFilesystem: false });
      expect(result.valid).toBe(false);
      expect(result.status).toBe('invalid');
      expect(result.errors.some((e) => e.code === 'UNSAFE_TEST_DATA_PATH')).toBe(true);
    });

    it('never prints test data file content in report or summary', async () => {
      const fixtureFile = join(tempDir, 'secret-data.json');
      await writeFile(fixtureFile, '{"SUPER_SECRET_TOKEN":"xyz123"}', 'utf8');

      const config = makeValidStagingConfig(fixtureFile);
      const result = validatePilotConfiguration(config, { checkFilesystem: true });
      const report = buildPreflightReport(config, result);
      const summary = formatPreflightSummary(report);

      expect(JSON.stringify(report)).not.toContain('SUPER_SECRET_TOKEN');
      expect(JSON.stringify(report)).not.toContain('xyz123');
      expect(summary).not.toContain('SUPER_SECRET_TOKEN');
      expect(summary).not.toContain('xyz123');
    });
  });

  describe('8. Authorization Reference Validation', () => {
    it('requires authorization reference for non-local environments', () => {
      const config = { ...makeValidStagingConfig(), authorizationReference: undefined };
      const result = validatePilotConfiguration(config, { checkFilesystem: false });
      expect(result.valid).toBe(false);
      expect(result.status).toBe('blocked');
      expect(result.errors.some((e) => e.code === 'MISSING_AUTHORIZATION_REFERENCE')).toBe(true);
    });

    it('allows local environment without authorization reference', () => {
      const config = makeValidLocalConfig();
      expect(config.authorizationReference).toBeUndefined();
      const result = validatePilotConfiguration(config, { checkFilesystem: false });
      expect(result.valid).toBe(true);
      expect(result.status).toBe('ready');
    });

    it('rejects authorization references containing suspicious secret patterns', () => {
      const badRefs = [
        'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-ID',
        'sk-live-1234567890abcdef',
        'ghp_1234567890abcdefghij',
        '-----BEGIN RSA PRIVATE KEY-----',
        'TICKET-123\nInjected Header',
        '../../secret/doc.pdf',
      ];

      for (const bad of badRefs) {
        const config = { ...makeValidStagingConfig(), authorizationReference: bad };
        const result = validatePilotConfiguration(config, { checkFilesystem: false });
        expect(result.valid).toBe(false);
        expect(result.status).toBe('invalid');
        expect(result.errors.some((e) => e.code === 'SECRET_IN_AUTHORIZATION_REF')).toBe(true);
      }
    });

    it('accepts clean non-secret ticket IDs and approval document references', () => {
      const goodRefs = [
        'TICKET-AUTH-2026',
        'SEC-APPROVAL-4821',
        'DOC-REF-STAGING-PILOT-SIGN-OFF',
        'https://wiki.internal.test/approvals/pilot-01',
      ];

      for (const good of goodRefs) {
        const config = { ...makeValidStagingConfig(), authorizationReference: good };
        const result = validatePilotConfiguration(config, { checkFilesystem: false });
        expect(result.valid).toBe(true);
        expect(result.status).toBe('ready');
      }
    });
  });

  describe('9. Deterministic Preflight Report', () => {
    it('produces byte-identical JSON reports across repeated runs', () => {
      const config = makeValidStagingConfig();
      const res1 = validatePilotConfiguration(config, { checkFilesystem: false });
      const report1 = buildPreflightReport(config, res1);

      const res2 = validatePilotConfiguration(config, { checkFilesystem: false });
      const report2 = buildPreflightReport(config, res2);

      const json1 = JSON.stringify(report1, null, 2);
      const json2 = JSON.stringify(report2, null, 2);

      expect(json1).toBe(json2);
      expect(report1.statement).toBe('Zero browser traffic generated. Preflight validation only.');
    });

    it('writes report to disk when requested', async () => {
      const config = makeValidLocalConfig();
      const result = validatePilotConfiguration(config, { checkFilesystem: false });
      const report = buildPreflightReport(config, result);

      const outPath = join(tempDir, 'reports', 'preflight.json');
      await writePreflightReport(report, outPath);

      const written = JSON.parse(await readFile(outPath, 'utf8'));
      expect(written.schemaVersion).toBe('1.0');
      expect(written.status).toBe('ready');
      expect(written.target.origin).toBe('http://127.0.0.1:4040');
    });
  });

  describe('10. CLI Command & Exit Codes', () => {
    it('returns code 0 when configuration is ready and safe', async () => {
      const configPath = join(tempDir, 'valid-local.json');
      await writeFile(configPath, JSON.stringify(makeValidLocalConfig()), 'utf8');

      const code = await runPreflightCommand(['--config', configPath]);
      expect(code).toBe(0);
    });

    it('returns code 1 when configuration is blocked or invalid', async () => {
      // Staging missing authorization reference
      const blockedConfig = { ...makeValidStagingConfig(), authorizationReference: undefined };
      const configPath = join(tempDir, 'blocked.json');
      await writeFile(configPath, JSON.stringify(blockedConfig), 'utf8');

      const code = await runPreflightCommand(['--config', configPath]);
      expect(code).toBe(1);
    });

    it('returns code 2 for CLI syntax errors or missing arguments', async () => {
      const codeMissingConfig = await runPreflightCommand([]);
      expect(codeMissingConfig).toBe(2);

      const codeUnknownFlag = await runPreflightCommand(['--config', 'foo', '--unknown-flag']);
      expect(codeUnknownFlag).toBe(2);

      const codeNonexistent = await runPreflightCommand(['--config', join(tempDir, 'does-not-exist.json')]);
      expect(codeNonexistent).toBe(2);
    });

    it('outputs JSON to stdout when --json flag is supplied', async () => {
      const configPath = join(tempDir, 'valid.json');
      await writeFile(configPath, JSON.stringify(makeValidLocalConfig()), 'utf8');

      let stdout = '';
      const originalLog = console.log;
      console.log = (msg) => {
        stdout += msg;
      };

      try {
        const code = await runPreflightCommand(['--config', configPath, '--json']);
        expect(code).toBe(0);
        const parsed = JSON.parse(stdout);
        expect(parsed.schemaVersion).toBe('1.0');
        expect(parsed.status).toBe('ready');
      } finally {
        console.log = originalLog;
      }
    });
  });

  describe('11. Execution Gate & Zero-Browser Proof', () => {
    it('proves a blocked or invalid configuration causes zero browser execution attempts', () => {
      let browserLaunched = false;
      const fakeBrowserLauncher = () => {
        browserLaunched = true;
      };

      const invalidConfig = {
        ...makeValidStagingConfig(),
        authorizationReference: undefined, // Missing auth
      };

      const preflightResult = validatePilotConfiguration(invalidConfig, { checkFilesystem: false });
      expect(preflightResult.status).not.toBe('ready');

      // The execution gate pattern:
      if (preflightResult.status === 'ready') {
        fakeBrowserLauncher();
      }

      expect(browserLaunched).toBe(false);
    });
  });

  describe('12. Module Isolation & Import Integrity', () => {
    it('confirms preflight validator modules import zero Playwright or network libraries', () => {
      const filesToCheck = [
        'src/preflight/types.ts',
        'src/preflight/loader.ts',
        'src/preflight/validator.ts',
        'src/preflight/report.ts',
        'src/cli/preflightCommand.ts',
      ];

      for (const file of filesToCheck) {
        const source = readFileSync(join(process.cwd(), file), 'utf8');
        expect(source).not.toContain("from 'playwright'");
        expect(source).not.toContain('from "playwright"');
        expect(source).not.toContain('chromium.launch');
        expect(source).not.toContain('fetch(');
        expect(source).not.toContain('node:http');
        expect(source).not.toContain('node:https');
      }
    });
  });
});
