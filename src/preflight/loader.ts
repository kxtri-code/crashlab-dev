/**
 * Safe Pilot Configuration Loader — Build 10.2.
 *
 * Reads non-secret pilot configuration files in either JSON or key-value format.
 * Never logs credentials, secrets, or file contents.
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { ApprovedJourney, PilotConfiguration, PilotEnvironment } from './types.js';

export class ConfigurationLoadError extends Error {
  readonly code: string;
  constructor(message: string, code = 'MALFORMED_CONFIGURATION') {
    super(message);
    this.name = 'ConfigurationLoadError';
    this.code = code;
  }
}

/** Recognized configuration keys in camelCase and UPPER_SNAKE_CASE. */
const ALLOWED_KEYS = new Set([
  'targetUrl',
  'TARGET_URL',
  'targetName',
  'TARGET_NAME',
  'targetEnvironment',
  'TARGET_ENVIRONMENT',
  'appBuildId',
  'APP_BUILD_ID',
  'allowedOrigins',
  'ALLOWED_ORIGINS',
  'allowedJourneys',
  'ALLOWED_JOURNEYS',
  'forbiddenActions',
  'FORBIDDEN_ACTIONS',
  'testDataFile',
  'TEST_DATA_FILE',
  'authorizationReference',
  'AUTHORIZATION_REFERENCE',
  'resetProcedure',
  'RESET_PROCEDURE',
  'testingWindow',
  'TESTING_WINDOW',
]);

/** Parse comma-separated strings or JSON string arrays into trimmed string array. */
function parseStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter((item) => item.length > 0);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return parsed.map((item) => String(item).trim()).filter((item) => item.length > 0);
        }
      } catch {
        // Fall back to comma split if JSON array parsing fails
      }
    }
    return trimmed
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  return [];
}

/** Parse journeys from a raw array or JSON string. */
function parseJourneys(value: unknown): ApprovedJourney[] {
  let rawList: unknown = value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      rawList = JSON.parse(trimmed);
    } catch {
      throw new ConfigurationLoadError(
        'Invalid JSON format in ALLOWED_JOURNEYS configuration.',
        'MALFORMED_JOURNEYS',
      );
    }
  }

  if (!Array.isArray(rawList)) {
    throw new ConfigurationLoadError(
      'ALLOWED_JOURNEYS must be an array of journey definitions.',
      'INVALID_JOURNEYS_SHAPE',
    );
  }

  return rawList.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new ConfigurationLoadError(
        `Journey at index ${index} must be an object.`,
        'INVALID_JOURNEY_SHAPE',
      );
    }
    const record = entry as Record<string, unknown>;
    const id = String(record.id ?? record.journeyId ?? '').trim();
    const goal = String(record.goal ?? record.humanGoal ?? '').trim();
    const origin = String(record.origin ?? record.allowedOrigin ?? '').trim();
    const allowedActions = parseStringList(record.allowedActions ?? record.actions ?? []);
    const forbiddenActions = parseStringList(record.forbiddenActions ?? []);
    const requiresCredentials = Boolean(record.requiresCredentials ?? false);
    const requiresTestData = Boolean(record.requiresTestData ?? false);

    return {
      id,
      goal,
      origin,
      allowedActions,
      forbiddenActions,
      requiresCredentials,
      requiresTestData,
    };
  });
}

/** Parse key-value lines (e.g. `.env` style configuration). */
function parseKeyValueConfig(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const seenKeys = new Set<string>();
  const lines = content.split(/\r?\n/);

  for (let lineNumber = 1; lineNumber <= lines.length; lineNumber++) {
    const line = lines[lineNumber - 1]?.trim() ?? '';
    if (!line || line.startsWith('#')) continue;

    const eqIndex = line.indexOf('=');
    if (eqIndex < 0) {
      throw new ConfigurationLoadError(
        `Malformed syntax at line ${lineNumber}: expected KEY=VALUE pair.`,
        'MALFORMED_KEY_VALUE_LINE',
      );
    }

    const key = line.slice(0, eqIndex).trim();
    let val = line.slice(eqIndex + 1).trim();

    if (!key) {
      throw new ConfigurationLoadError(
        `Empty key at line ${lineNumber}.`,
        'EMPTY_KEY',
      );
    }

    if (seenKeys.has(key)) {
      throw new ConfigurationLoadError(
        `Duplicate configuration key '${key}' at line ${lineNumber}.`,
        'DUPLICATE_KEY',
      );
    }
    seenKeys.add(key);

    if (!ALLOWED_KEYS.has(key)) {
      throw new ConfigurationLoadError(
        `Unknown configuration key '${key}' at line ${lineNumber}.`,
        'UNKNOWN_KEY',
      );
    }

    // Strip wrapping single or double quotes
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1);
    }

    result[key] = val;
  }

  return result;
}

/** Normalize raw dictionary into strongly typed PilotConfiguration. */
function buildPilotConfig(
  raw: Record<string, unknown>,
  baseDir: string,
): PilotConfiguration {
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new ConfigurationLoadError(
        `Unknown configuration key '${key}'.`,
        'UNKNOWN_KEY',
      );
    }
  }

  const targetUrl = String(raw.targetUrl ?? raw.TARGET_URL ?? '').trim();
  const targetName = String(raw.targetName ?? raw.TARGET_NAME ?? '').trim();
  const targetEnvironment = String(
    raw.targetEnvironment ?? raw.TARGET_ENVIRONMENT ?? '',
  ).trim() as PilotEnvironment;

  const appBuildIdRaw = raw.appBuildId ?? raw.APP_BUILD_ID;
  const appBuildId =
    appBuildIdRaw !== undefined && appBuildIdRaw !== null && String(appBuildIdRaw).trim() !== ''
      ? String(appBuildIdRaw).trim()
      : undefined;

  const allowedOrigins = parseStringList(raw.allowedOrigins ?? raw.ALLOWED_ORIGINS);
  const forbiddenActions = parseStringList(raw.forbiddenActions ?? raw.FORBIDDEN_ACTIONS);

  const rawJourneys = raw.allowedJourneys ?? raw.ALLOWED_JOURNEYS;
  const allowedJourneys = rawJourneys !== undefined ? parseJourneys(rawJourneys) : [];

  const rawTestDataFile = raw.testDataFile ?? raw.TEST_DATA_FILE;
  let testDataFile: string | undefined;
  if (rawTestDataFile !== undefined && rawTestDataFile !== null && String(rawTestDataFile).trim() !== '') {
    const rawPath = String(rawTestDataFile).trim();
    testDataFile = resolve(baseDir, rawPath);
  }

  const rawAuthRef = raw.authorizationReference ?? raw.AUTHORIZATION_REFERENCE;
  const authorizationReference =
    rawAuthRef !== undefined && rawAuthRef !== null && String(rawAuthRef).trim() !== ''
      ? String(rawAuthRef).trim()
      : undefined;

  const rawReset = raw.resetProcedure ?? raw.RESET_PROCEDURE;
  const resetProcedure =
    rawReset !== undefined && rawReset !== null && String(rawReset).trim() !== ''
      ? String(rawReset).trim()
      : undefined;

  const rawTestingWindow = raw.testingWindow ?? raw.TESTING_WINDOW;
  const testingWindow =
    rawTestingWindow !== undefined && rawTestingWindow !== null && String(rawTestingWindow).trim() !== ''
      ? String(rawTestingWindow).trim()
      : undefined;

  return {
    targetUrl,
    targetName,
    targetEnvironment,
    appBuildId,
    allowedOrigins,
    allowedJourneys,
    forbiddenActions,
    testDataFile,
    authorizationReference,
    resetProcedure,
    testingWindow,
  };
}

/**
 * Load and parse a pilot configuration from disk.
 *
 * Automatically detects JSON vs key-value based on file extension and content.
 * Never logs sensitive contents.
 */
export async function loadPilotConfiguration(
  filePath: string,
): Promise<PilotConfiguration> {
  const absolutePath = resolve(process.cwd(), filePath);
  let content: string;
  try {
    content = await readFile(absolutePath, 'utf8');
  } catch (error) {
    const nodeErr = error as NodeJS.ErrnoException;
    if (nodeErr.code === 'ENOENT') {
      throw new ConfigurationLoadError(
        `Pilot configuration file not found at '${filePath}'.`,
        'CONFIG_NOT_FOUND',
      );
    }
    throw new ConfigurationLoadError(
      `Unable to read configuration file: ${nodeErr.message}`,
      'CONFIG_READ_ERROR',
    );
  }

  const baseDir = dirname(absolutePath);
  const trimmed = content.trim();

  if (filePath.endsWith('.json') || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(content);
    } catch (error) {
      throw new ConfigurationLoadError(
        `Malformed JSON in configuration file: ${(error as Error).message}`,
        'MALFORMED_JSON',
      );
    }
    if (typeof parsedJson !== 'object' || parsedJson === null || Array.isArray(parsedJson)) {
      throw new ConfigurationLoadError(
        'JSON configuration must be an object.',
        'INVALID_JSON_ROOT',
      );
    }
    return buildPilotConfig(parsedJson as Record<string, unknown>, baseDir);
  }

  const parsedKv = parseKeyValueConfig(content);
  return buildPilotConfig(parsedKv, baseDir);
}
