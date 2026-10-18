/**
 * Pilot Configuration Preflight Validator — Build 10.2.
 *
 * Deterministic, local-only safety gate that verifies pilot configurations
 * before any future browser execution is permitted.
 *
 * Contains ZERO Playwright, browser, or network imports.
 */

import { statSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import type {
  ApprovedJourney,
  PilotConfiguration,
  PilotEnvironment,
  PreflightReport,
  PreflightResult,
  SafetyCheck,
  SafetyGateStatus,
  ValidationError,
} from './types.js';
import { VALID_PILOT_ENVIRONMENTS } from './types.js';

export interface PreflightValidationOptions {
  /** If true (default), checks filesystem for testDataFile existence. */
  readonly checkFilesystem?: boolean;
  /** If true, allows single journey validation for individual run execution. */
  readonly allowSingleJourney?: boolean;
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

const DANGEROUS_ACTION_PATTERNS = [
  /\bcheckout\b/i,
  /\bpay(?:ment)?\b/i,
  /\bbuy\b/i,
  /\bpurchase\b/i,
  /\border\b/i,
  /\bcharge\b/i,
  /\bdelet(?:e|ion)\b/i,
  /\bdestroy\b/i,
  /\bremove(?:[_\s]account)?\b/i,
  /\bdrop\b/i,
  /\btruncate\b/i,
  /\b(?:reset|change)[_\s]password\b/i,
  /\bpassword[_\s]reset\b/i,
  /\bmodify[_\s]credentials\b/i,
  /\b(?:grant[_\s])?admin\b/i,
  /\bescalat(?:e|ion)\b/i,
  /\bsend[_\s](?:email|sms)\b/i,
  /\birreversible\b/i,
];

const VAGUE_ACTION_PATTERNS = [
  /^\*$/,
  /^all$/i,
  /^any(?:thing)?$/i,
  /^action$/i,
  /^do[_\s]something$/i,
  /^unknown$/i,
  /^custom$/i,
];

const SECRET_PATTERNS_IN_AUTH = [
  /\bbearer\s+/i,
  /\beyJ[A-Za-z0-9_-]{10,}\b/, // JWT
  /\b(?:sk|ak|ghp|gho|pat|api[_-]?key)[_-][A-Za-z0-9_-]{10,}\b/i,
  /-----BEGIN [A-Z\s]+PRIVATE KEY-----/,
  /[\r\n\t\0]/,
  /\.\.[/\\]/,
];

const STAGING_HOSTNAME_INDICATORS = [
  /\bstaging\b/i,
  /\bstage\b/i,
  /\bqa\b/i,
  /\btest\b/i,
  /\bdemo\b/i,
  /\bdev\b/i,
  /\bpreview\b/i,
  /\bsandbox\b/i,
  /\bpreprod\b/i,
  /\bnonprod\b/i,
  /\.test$/i,
  /\.example$/i,
  /\.invalid$/i,
  /\.internal$/i,
  /\.local$/i,
  /\bonrender\.com$/i,
];

const PRODUCTION_HOSTNAME_KEYWORDS = [
  /\bproduction\b/i,
  /\bprod\b/i,
  /\blive\b/i,
];

/** Check whether a hostname is local loopback. */
function isLocalHost(hostname: string): boolean {
  if (LOCAL_HOSTS.has(hostname.toLowerCase())) return true;
  if (hostname.toLowerCase().endsWith('.local')) return true;
  return false;
}

/** Check whether a non-local hostname appears to be a legitimate staging/qa/demo domain. */
function isStagingHost(hostname: string): boolean {
  for (const prodPattern of PRODUCTION_HOSTNAME_KEYWORDS) {
    if (prodPattern.test(hostname)) return false;
  }
  for (const indicator of STAGING_HOSTNAME_INDICATORS) {
    if (indicator.test(hostname)) return true;
  }
  return false;
}

/** Normalize an origin string to `http(s)://host(:port)`. */
function normalizeOrigin(originStr: string): string | null {
  try {
    const parsed = new URL(originStr);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password) return null;
    if (parsed.search || parsed.hash) return null;
    if (parsed.pathname && parsed.pathname !== '/') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/** Pure function to validate a pilot configuration. */
export function validatePilotConfiguration(
  config: PilotConfiguration,
  options: PreflightValidationOptions = {},
): PreflightResult {
  const checkFilesystem = options.checkFilesystem ?? true;
  const checks: SafetyCheck[] = [];
  const errors: ValidationError[] = [];
  const failureReasons: string[] = [];

  const addCheck = (
    id: string,
    name: string,
    category: SafetyCheck['category'],
    passed: boolean,
    reason?: string,
  ): void => {
    checks.push({ id, name, category, passed, reason });
    if (!passed && reason) {
      failureReasons.push(reason);
    }
  };

  const addError = (code: string, message: string, field?: string): void => {
    errors.push({ code, message, field });
  };

  // --- 1. Environment Validation ---
  const rawEnv = config.targetEnvironment;
  const isKnownEnv = (VALID_PILOT_ENVIRONMENTS as readonly string[]).includes(rawEnv);
  const isLocalEnv = rawEnv === 'local';

  if (!rawEnv) {
    addCheck('environment_present', 'Target environment is specified', 'environment', false, 'Target environment is missing.');
    addError('MISSING_ENVIRONMENT', 'Target environment is required.', 'targetEnvironment');
  } else if (!isKnownEnv) {
    addCheck(
      'environment_valid',
      'Target environment is allowed',
      'environment',
      false,
      `Environment '${rawEnv}' is prohibited. Must be one of: local, demo, qa, staging. Production is strictly forbidden.`,
    );
    addError('INVALID_ENVIRONMENT', `Prohibited environment '${rawEnv}'. Production and unknown environments are rejected.`, 'targetEnvironment');
  } else {
    addCheck('environment_valid', 'Target environment is allowed', 'environment', true);
  }

  // --- 2. Target URL Validation ---
  let targetOrigin: string | null = null;
  let parsedUrl: URL | null = null;

  if (!config.targetUrl || !config.targetUrl.trim()) {
    addCheck('target_url_present', 'Target URL is specified', 'target', false, 'Target URL is missing.');
    addError('MISSING_TARGET_URL', 'Target URL is required.', 'targetUrl');
  } else {
    try {
      parsedUrl = new URL(config.targetUrl.trim());
    } catch {
      addCheck('target_url_syntax', 'Target URL has valid absolute syntax', 'target', false, `Invalid URL syntax: '${config.targetUrl}'.`);
      addError('MALFORMED_TARGET_URL', 'Target URL must be a valid absolute URL.', 'targetUrl');
    }
  }

  if (parsedUrl) {
    // Embedded credentials check
    if (parsedUrl.username || parsedUrl.password) {
      addCheck('target_no_credentials', 'Target URL has no embedded credentials', 'target', false, 'Target URL must not contain embedded username or password.');
      addError('URL_CREDENTIALS_EXPOSED', 'Embedded credentials in target URL are prohibited.', 'targetUrl');
    } else {
      addCheck('target_no_credentials', 'Target URL has no embedded credentials', 'target', true);
    }

    // Fragment check
    if (parsedUrl.hash) {
      addCheck('target_no_fragment', 'Target URL has no fragment', 'target', false, 'Target URL must not contain a URL hash/fragment.');
      addError('URL_FRAGMENT_PROHIBITED', 'URL fragments are prohibited in target URL.', 'targetUrl');
    } else {
      addCheck('target_no_fragment', 'Target URL has no fragment', 'target', true);
    }

    // Scheme & Protocol check
    const protocol = parsedUrl.protocol;
    const hostname = parsedUrl.hostname;

    if (protocol !== 'http:' && protocol !== 'https:') {
      addCheck('target_protocol_scheme', 'Target URL uses HTTP/HTTPS', 'target', false, `Unsupported URL scheme '${protocol}'. Only HTTP and HTTPS are permitted.`);
      addError('INVALID_URL_SCHEME', `Scheme '${protocol}' is prohibited.`, 'targetUrl');
    } else if (isLocalEnv) {
      if (!isLocalHost(hostname)) {
        addCheck(
          'target_local_loopback',
          'Local environment targets local loopback',
          'target',
          false,
          `Local environment requires loopback host (127.0.0.1, localhost, [::1]). Found '${hostname}'.`,
        );
        addError('NON_LOCAL_HOST_IN_LOCAL_ENV', `Host '${hostname}' is not a local loopback address.`, 'targetUrl');
      } else {
        addCheck('target_local_loopback', 'Local environment targets local loopback', 'target', true);
        targetOrigin = parsedUrl.origin;
      }
    } else {
      // Non-local environment: must be HTTPS
      if (protocol !== 'https:') {
        addCheck(
          'target_https_enforced',
          'Non-local environment requires HTTPS',
          'target',
          false,
          `Non-local environment '${rawEnv}' requires HTTPS protocol. Found '${protocol}'.`,
        );
        addError('HTTPS_REQUIRED', `Non-local environment requires HTTPS. Found '${protocol}'.`, 'targetUrl');
      } else {
        addCheck('target_https_enforced', 'Non-local environment requires HTTPS', 'target', true);
      }

      // Non-local environment: must not be local
      if (isLocalHost(hostname)) {
        addCheck(
          'target_non_local_host',
          'Staging environment targets external non-local host',
          'target',
          false,
          `Staging/QA environment cannot target local host '${hostname}'. Use 'local' environment for local fixtures.`,
        );
        addError('LOCAL_HOST_IN_STAGING_ENV', `Local host '${hostname}' prohibited in '${rawEnv}' environment.`, 'targetUrl');
      } else {
        addCheck('target_non_local_host', 'Staging environment targets external non-local host', 'target', true);
      }

      // Production safety check
      if (!isStagingHost(hostname)) {
        addCheck(
          'production_safety',
          'Target hostname is verified non-production',
          'target',
          false,
          `Production-like hostname '${hostname}' rejected for '${rawEnv}'. Target must be an explicit staging/qa/demo domain.`,
        );
        addError('PRODUCTION_HOSTNAME_REJECTED', `Target host '${hostname}' looks like production or lacks staging subdomain.`, 'targetUrl');
      } else {
        addCheck('production_safety', 'Target hostname is verified non-production', 'target', true);
      }

      if (protocol === 'https:' && !isLocalHost(hostname) && isStagingHost(hostname)) {
        targetOrigin = parsedUrl.origin;
      }
    }
  }

  // --- 3. Allowed-Origin Validation ---
  const rawOrigins = config.allowedOrigins ?? [];
  const normalizedOrigins: string[] = [];
  let originsValid = true;

  if (rawOrigins.length === 0) {
    addCheck('allowed_origins_present', 'Allowed origins list is non-empty', 'origin', false, 'ALLOWED_ORIGINS is empty.');
    addError('EMPTY_ALLOWED_ORIGINS', 'At least one allowed origin is required.', 'allowedOrigins');
    originsValid = false;
  } else {
    for (const rawOrigin of rawOrigins) {
      if (!rawOrigin || rawOrigin.includes('*')) {
        addCheck(
          'allowed_origin_no_wildcard',
          'Allowed origins prohibit wildcards',
          'origin',
          false,
          `Wildcard origin '${rawOrigin}' is prohibited.`,
        );
        addError('WILDCARD_ORIGIN_PROHIBITED', `Wildcard '${rawOrigin}' is prohibited.`, 'allowedOrigins');
        originsValid = false;
        continue;
      }

      const normalized = normalizeOrigin(rawOrigin);
      if (!normalized) {
        addCheck(
          'allowed_origin_syntax',
          'Allowed origin has valid origin syntax',
          'origin',
          false,
          `Origin '${rawOrigin}' must not contain paths, queries, fragments, or credentials.`,
        );
        addError('MALFORMED_ORIGIN', `Origin '${rawOrigin}' must be a pure origin (protocol + host + port).`, 'allowedOrigins');
        originsValid = false;
        continue;
      }

      if (!normalizedOrigins.includes(normalized)) {
        normalizedOrigins.push(normalized);
      }
    }
    normalizedOrigins.sort();

    if (originsValid) {
      addCheck('allowed_origins_valid', 'All allowed origins are normalized and non-wildcard', 'origin', true);
    }
  }

  // Target origin membership check
  if (targetOrigin && originsValid) {
    if (!normalizedOrigins.includes(targetOrigin)) {
      addCheck(
        'target_origin_in_allowed',
        'Target origin is included in allowed origins',
        'origin',
        false,
        `Target origin '${targetOrigin}' is not listed in ALLOWED_ORIGINS (${normalizedOrigins.join(', ')}).`,
      );
      addError('TARGET_ORIGIN_NOT_ALLOWED', `Target origin '${targetOrigin}' is not in allowed origins list.`, 'allowedOrigins');
    } else {
      addCheck('target_origin_in_allowed', 'Target origin is included in allowed origins', 'origin', true);
    }
  }

  // --- 4. Journeys Validation ---
  const journeys = config.allowedJourneys ?? [];
  const journeyIds = new Set<string>();
  let journeysValid = true;

  const minJourneys = options.allowSingleJourney ? 1 : (isLocalEnv ? 1 : 2);
  const maxJourneys = 4;

  if (journeys.length < minJourneys || journeys.length > maxJourneys) {
    const rangeMsg = (isLocalEnv || options.allowSingleJourney)
      ? `Environment requires 1 to ${maxJourneys} journeys (found ${journeys.length}).`
      : `Staging environment requires 2 to ${maxJourneys} approved journeys (found ${journeys.length}).`;
    addCheck('journey_count_bounds', `Journey count within bounds (${minJourneys}–${maxJourneys})`, 'journeys', false, rangeMsg);
    addError('INVALID_JOURNEY_COUNT', rangeMsg, 'allowedJourneys');
    journeysValid = false;
  } else {
    addCheck('journey_count_bounds', `Journey count within bounds (${minJourneys}–${maxJourneys})`, 'journeys', true);
  }

  const globalForbidden = (config.forbiddenActions ?? []).map((act) => act.toLowerCase().trim());

  for (let i = 0; i < journeys.length; i++) {
    const j = journeys[i] as ApprovedJourney;
    const prefix = `Journey #${i + 1} ('${j.id || 'unnamed'}')`;

    if (!j.id || !j.id.trim()) {
      addCheck('journey_id_present', `${prefix}: ID is specified`, 'journeys', false, `${prefix}: Journey ID is missing.`);
      addError('MISSING_JOURNEY_ID', `${prefix}: Journey ID is required.`, `allowedJourneys[${i}].id`);
      journeysValid = false;
    } else if (journeyIds.has(j.id)) {
      addCheck('journey_id_unique', `${prefix}: ID is unique`, 'journeys', false, `Duplicate journey ID '${j.id}'.`);
      addError('DUPLICATE_JOURNEY_ID', `Duplicate journey ID '${j.id}'.`, `allowedJourneys[${i}].id`);
      journeysValid = false;
    } else {
      journeyIds.add(j.id);
    }

    if (!j.goal || j.goal.trim().length < 3) {
      addCheck('journey_goal_non_empty', `${prefix}: Goal is non-empty`, 'journeys', false, `${prefix}: Journey goal is missing or too short.`);
      addError('EMPTY_JOURNEY_GOAL', `${prefix}: Human goal is required.`, `allowedJourneys[${i}].goal`);
      journeysValid = false;
    }

    // Origin check
    const normalizedJourneyOrigin = normalizeOrigin(j.origin);
    if (!normalizedJourneyOrigin) {
      addCheck('journey_origin_valid', `${prefix}: Origin is valid`, 'journeys', false, `${prefix}: Origin '${j.origin}' is malformed.`);
      addError('INVALID_JOURNEY_ORIGIN', `${prefix}: Origin '${j.origin}' is invalid.`, `allowedJourneys[${i}].origin`);
      journeysValid = false;
    } else if (normalizedOrigins.length > 0 && !normalizedOrigins.includes(normalizedJourneyOrigin)) {
      addCheck(
        'journey_origin_in_allowed',
        `${prefix}: Origin is in allowed origins`,
        'journeys',
        false,
        `${prefix}: Origin '${normalizedJourneyOrigin}' is not in allowed origins.`,
      );
      addError('JOURNEY_ORIGIN_NOT_ALLOWED', `${prefix}: Origin '${normalizedJourneyOrigin}' is not allowed.`, `allowedJourneys[${i}].origin`);
      journeysValid = false;
    }

    // Allowed actions check
    if (!j.allowedActions || j.allowedActions.length === 0) {
      addCheck('journey_actions_present', `${prefix}: Allowed actions are specified`, 'journeys', false, `${prefix}: Allowed actions list is empty.`);
      addError('EMPTY_ALLOWED_ACTIONS', `${prefix}: At least one allowed action is required.`, `allowedJourneys[${i}].allowedActions`);
      journeysValid = false;
    } else {
      for (const action of j.allowedActions) {
        const actionTrimmed = action.trim();
        const actionDelimited = actionTrimmed.replace(/[-_]/g, ' ');
        // Vague or wildcard check
        for (const vaguePat of VAGUE_ACTION_PATTERNS) {
          if (vaguePat.test(actionTrimmed) || vaguePat.test(actionDelimited)) {
            addCheck('journey_actions_specific', `${prefix}: Action is specific`, 'journeys', false, `${prefix}: Wildcard/vague action '${action}' is prohibited.`);
            addError('VAGUE_ACTION_PROHIBITED', `${prefix}: Vague action '${action}' is prohibited.`, `allowedJourneys[${i}].allowedActions`);
            journeysValid = false;
            break;
          }
        }
        // Dangerous action check
        for (const dangerPat of DANGEROUS_ACTION_PATTERNS) {
          if (dangerPat.test(actionTrimmed) || dangerPat.test(actionDelimited)) {
            addCheck('journey_actions_safe', `${prefix}: Action is safe`, 'journeys', false, `${prefix}: Dangerous action '${action}' is prohibited.`);
            addError('DANGEROUS_ACTION_PROHIBITED', `${prefix}: Action '${action}' violates non-destructive safety policy.`, `allowedJourneys[${i}].allowedActions`);
            journeysValid = false;
            break;
          }
        }
        // Conflict with global forbidden actions
        if (globalForbidden.includes(actionTrimmed.toLowerCase())) {
          addCheck(
            'journey_actions_no_conflict',
            `${prefix}: Action does not conflict with global forbidden actions`,
            'journeys',
            false,
            `${prefix}: Action '${action}' is listed in global forbidden actions.`,
          );
          addError('ACTION_CONFLICTS_WITH_FORBIDDEN', `${prefix}: Action '${action}' conflicts with forbidden actions.`, `allowedJourneys[${i}].allowedActions`);
          journeysValid = false;
        }
      }
    }
  }

  if (journeysValid && journeys.length > 0) {
    addCheck('journeys_all_valid', 'All journey definitions are valid and non-destructive', 'journeys', true);
  }

  // --- 5. Forbidden Actions Validation ---
  const forbidden = config.forbiddenActions ?? [];
  let forbiddenValid = true;

  if (!isLocalEnv && forbidden.length === 0) {
    addCheck('forbidden_actions_present', 'Global forbidden actions are specified', 'forbidden-actions', false, 'Non-local environment requires an explicit forbidden actions list.');
    addError('EMPTY_FORBIDDEN_ACTIONS', 'Forbidden actions list cannot be empty for staging.', 'forbiddenActions');
    forbiddenValid = false;
  } else if (forbidden.length > 0) {
    const forbiddenLower = forbidden.map((f) => f.toLowerCase().trim());
    const hasPayment = forbiddenLower.some((f) => /payment|checkout|buy|purchase/i.test(f));
    const hasDeletion = forbiddenLower.some((f) => /delet|destroy|remove/i.test(f));
    const hasCredentials = forbiddenLower.some((f) => /password|credential|admin/i.test(f));

    if (!isLocalEnv) {
      if (!hasPayment) {
        addCheck('forbidden_payment_covered', 'Forbidden actions include payment/checkout protection', 'forbidden-actions', false, 'Forbidden actions must explicitly prohibit payments/checkout.');
        addError('MISSING_FORBIDDEN_PAYMENT', 'Payment/checkout protection missing from forbidden actions.', 'forbiddenActions');
        forbiddenValid = false;
      }
      if (!hasDeletion) {
        addCheck('forbidden_deletion_covered', 'Forbidden actions include deletion protection', 'forbidden-actions', false, 'Forbidden actions must explicitly prohibit account/data deletion.');
        addError('MISSING_FORBIDDEN_DELETION', 'Deletion protection missing from forbidden actions.', 'forbiddenActions');
        forbiddenValid = false;
      }
      if (!hasCredentials) {
        addCheck('forbidden_credentials_covered', 'Forbidden actions include credential protection', 'forbidden-actions', false, 'Forbidden actions must explicitly prohibit credential/password changes.');
        addError('MISSING_FORBIDDEN_CREDENTIALS', 'Credential modification protection missing from forbidden actions.', 'forbiddenActions');
        forbiddenValid = false;
      }
    }

    if (forbiddenValid) {
      addCheck('forbidden_actions_valid', 'Forbidden actions cover critical safety categories', 'forbidden-actions', true);
    }
  }

  // --- 6. Credential & Test Data Checks ---
  const anyJourneyNeedsCredentials = journeys.some((j) => j.requiresCredentials || j.requiresTestData);

  if (anyJourneyNeedsCredentials && !config.testDataFile) {
    addCheck(
      'credentials_test_data_configured',
      'Test data file configured when credentials required',
      'credentials',
      false,
      'One or more journeys require test credentials/data, but TEST_DATA_FILE is not configured.',
    );
    addError('TEST_DATA_REQUIRED', 'Test data file required when journeys require credentials or test data.', 'testDataFile');
  }

  if (config.testDataFile) {
    const rawPath = config.testDataFile;
    // Check directory traversal
    if (rawPath.includes('..') || rawPath.includes('/etc/') || /^[a-zA-Z]:\\Windows\\/i.test(rawPath)) {
      addCheck('test_data_path_safe', 'Test data path is safe from directory traversal', 'credentials', false, 'Test data path contains unsafe directory traversal.');
      addError('UNSAFE_TEST_DATA_PATH', 'Test data path contains unsafe directory traversal.', 'testDataFile');
    } else {
      addCheck('test_data_path_safe', 'Test data path is safe from directory traversal', 'credentials', true);

      if (checkFilesystem) {
        try {
          const stat = statSync(rawPath);
          if (!stat.isFile()) {
            addCheck('test_data_file_exists', 'Test data file exists and is a regular file', 'credentials', false, 'Test data path is not a regular file.');
            addError('TEST_DATA_NOT_A_FILE', 'Test data path is not a regular file.', 'testDataFile');
          } else {
            addCheck('test_data_file_exists', 'Test data file exists and is a regular file', 'credentials', true);
          }
        } catch {
          addCheck('test_data_file_exists', 'Test data file exists and is a regular file', 'credentials', false, 'Test data file does not exist at specified path.');
          addError('TEST_DATA_FILE_NOT_FOUND', 'Test data file not found.', 'testDataFile');
        }
      }
    }
  }

  // --- 7. Authorization Reference Validation ---
  if (!isLocalEnv) {
    const authRef = config.authorizationReference?.trim();
    if (!authRef) {
      addCheck(
        'authorization_reference_present',
        'Authorization reference is specified for non-local environment',
        'authorization',
        false,
        `Non-local environment '${rawEnv}' requires AUTHORIZATION_REFERENCE to verify written owner approval.`,
      );
      addError('MISSING_AUTHORIZATION_REFERENCE', 'Authorization reference is required for non-local environments.', 'authorizationReference');
    } else {
      let authClean = true;
      for (const secretPat of SECRET_PATTERNS_IN_AUTH) {
        if (secretPat.test(authRef)) {
          addCheck(
            'authorization_reference_non_secret',
            'Authorization reference contains no tokens or secrets',
            'authorization',
            false,
            'Authorization reference contains suspicious tokens, credentials, or control characters. Use a ticket ID or document link.',
          );
          addError('SECRET_IN_AUTHORIZATION_REF', 'Authorization reference must be an identifier (ticket ID, doc link), not a secret token or key.', 'authorizationReference');
          authClean = false;
          break;
        }
      }
      if (authClean) {
        addCheck('authorization_reference_valid', 'Authorization reference is specified and non-secret', 'authorization', true);
      }
    }
  } else {
    addCheck('authorization_reference_local', 'Local synthetic fixture does not require external authorization', 'authorization', true);
  }

  // --- Determine Overall Status ---
  // Status is:
  // 'ready' if all checks pass
  // 'blocked' if the configuration is well-formed but missing staging prerequisites (auth ref, staging target, test data)
  // 'invalid' if configuration syntax or parameters are illegal (bad URL, prohibited environment, dangerous actions, duplicate IDs)
  let status: SafetyGateStatus = 'ready';

  if (errors.length > 0) {
    const isInvalid = errors.some((e) =>
      [
        'MALFORMED_TARGET_URL',
        'INVALID_URL_SCHEME',
        'URL_CREDENTIALS_EXPOSED',
        'URL_FRAGMENT_PROHIBITED',
        'PRODUCTION_HOSTNAME_REJECTED',
        'LOCAL_HOST_IN_STAGING_ENV',
        'NON_LOCAL_HOST_IN_LOCAL_ENV',
        'HTTPS_REQUIRED',
        'INVALID_ENVIRONMENT',
        'EMPTY_ALLOWED_ORIGINS',
        'WILDCARD_ORIGIN_PROHIBITED',
        'MALFORMED_ORIGIN',
        'TARGET_ORIGIN_NOT_ALLOWED',
        'INVALID_JOURNEY_COUNT',
        'MISSING_JOURNEY_ID',
        'DUPLICATE_JOURNEY_ID',
        'EMPTY_JOURNEY_GOAL',
        'INVALID_JOURNEY_ORIGIN',
        'JOURNEY_ORIGIN_NOT_ALLOWED',
        'EMPTY_ALLOWED_ACTIONS',
        'VAGUE_ACTION_PROHIBITED',
        'DANGEROUS_ACTION_PROHIBITED',
        'ACTION_CONFLICTS_WITH_FORBIDDEN',
        'EMPTY_FORBIDDEN_ACTIONS',
        'MISSING_FORBIDDEN_PAYMENT',
        'MISSING_FORBIDDEN_DELETION',
        'MISSING_FORBIDDEN_CREDENTIALS',
        'SECRET_IN_AUTHORIZATION_REF',
        'UNSAFE_TEST_DATA_PATH',
      ].includes(e.code),
    );

    status = isInvalid ? 'invalid' : 'blocked';
  }

  return {
    status,
    valid: status === 'ready',
    targetOrigin,
    targetEnvironment: isKnownEnv ? rawEnv : 'unknown',
    checks,
    errors,
    failureReasons,
    metadata: {
      targetName: config.targetName || '(unnamed)',
      appBuildId: config.appBuildId ?? null,
      allowedOrigins: normalizedOrigins,
      journeyCount: journeys.length,
      journeyIds: [...journeyIds].sort(),
      forbiddenActionCategories: [...new Set(forbidden.map((f) => f.toLowerCase()))].sort(),
      testDataConfigured: Boolean(config.testDataFile),
      authorizationConfigured: Boolean(config.authorizationReference),
    },
  };
}

/** Build a deterministic PreflightReport from a PreflightResult and input configuration. */
export function buildPreflightReport(
  config: PilotConfiguration,
  result: PreflightResult,
): PreflightReport {
  return {
    schemaVersion: '1.0',
    status: result.status,
    statement: 'Zero browser traffic generated. Preflight validation only.',
    target: {
      url: config.targetUrl || '',
      origin: result.targetOrigin || '',
      name: config.targetName || '',
      environment: result.targetEnvironment,
      appBuildId: config.appBuildId ?? null,
    },
    allowedOrigins: result.metadata.allowedOrigins,
    journeys: (config.allowedJourneys ?? []).map((j) => ({
      id: j.id,
      goal: j.goal,
      origin: j.origin,
      allowedActions: j.allowedActions,
      requiresCredentials: Boolean(j.requiresCredentials),
      requiresTestData: Boolean(j.requiresTestData),
    })),
    forbiddenActionCategories: result.metadata.forbiddenActionCategories,
    testDataConfigured: result.metadata.testDataConfigured,
    authorizationConfigured: result.metadata.authorizationConfigured,
    safetyChecks: result.checks,
    failureReasons: result.failureReasons,
  };
}
