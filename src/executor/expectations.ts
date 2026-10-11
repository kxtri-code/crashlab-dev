/**
 * Operator-declared expectations for JavaScript/SPA flows.
 *
 * Modern JS/SPA forms don't expose destinations to Scout (no action attribute,
 * JS intercepts submission, fetch/XHR, history.pushState, state changes without
 * navigation). CrashLab cannot honestly derive such expectations from Scout.
 *
 * The safe solution is an external, typed expectation configuration
 * (`reports/expectations.json`) where operators explicitly declare postconditions.
 *
 * Key principles:
 *  - An operator-declared expectation tells CrashLab what to check. It does not
 *    prove that the application itself declared or guarantees that outcome.
 *  - Only `source: "operator-declared"` is accepted. The system never pretends
 *    operator expectations were Scout-observed.
 *  - Expectations are bound to a journey plan via hash, preventing stale
 *    expectations from being applied to a changed plan.
 *  - All expectations are canonicalized (sorted) for deterministic output.
 *  - Payment-related, cross-origin, and secret-bearing expectations are rejected.
 *
 * Pure and Playwright-free: validation, canonicalization, and hashing are pure.
 * Only the evaluation function touches a browser page.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Page } from 'playwright';
import type { JourneyPlan } from '../journey/types.js';
import { journeyHash } from '../baseline/identity.js';
import { normalizePath, normalizeOrigin, isStablePath } from '../journey/structuredAssertion.js';
import { toOrigin } from '../util/url.js';

/** Expectations file schema version. */
export const EXPECTATIONS_SCHEMA_VERSION = '1.0';

/** The only accepted source for operator expectations. */
export const OPERATOR_DECLARED_SOURCE = 'operator-declared';

/** Sources that are NOT accepted (for validation error messages). */
export const REJECTED_SOURCES = [
  'scout-observed',
  'evidence-backed',
  'automatically-derived',
  'confirmed',
] as const;

/** Actions that can have expectations (only these change the page). */
export const EXPECTATION_BEARING_ACTIONS = new Set(['click', 'submit', 'navigate']);

/** Match modes for url-path expectations. */
export const URL_PATH_MATCH_MODES = ['exact', 'starts-with'] as const;

/** Match modes for url-origin expectations. */
export const URL_ORIGIN_MATCH_MODES = ['exact'] as const;

/** A single operator-declared expectation. */
export interface OperatorExpectation {
  /** Deterministic id: `exp-001`, `exp-002`, ... */
  id: string;
  /** The step id this expectation is evaluated after. */
  afterStepId: string;
  /** The type of expectation. */
  type: 'url-path' | 'url-origin';
  /** The expected path (for url-path). */
  expectedPath?: string;
  /** The expected origin (for url-origin). */
  expectedOrigin?: string;
  /** How to match. */
  match: 'exact' | 'starts-with';
  /** Always "operator-declared". */
  source: typeof OPERATOR_DECLARED_SOURCE;
  /** Why this expectation exists. */
  reason: string;
}

/** The full expectations file. */
export interface ExpectationsFile {
  schemaVersion: string;
  /** SHA-256 over the canonical journey content. Must match journeyHash(journey). */
  journeyPlanHash: string;
  expectations: OperatorExpectation[];
}

/** How an expectation turned out. */
export type ExpectationResult = 'matched' | 'not-matched' | 'unevaluable';

/** A safe, structured record of one expectation check. */
export interface ExpectationOutcome {
  expectationId: string;
  afterStepId: string;
  type: OperatorExpectation['type'];
  result: ExpectationResult;
  /** Only for URL expectations: the safe value actually observed. */
  actualOrigin?: string | null;
  actualPath?: string;
  /** Present only when unevaluable. */
  reason?: string;
}

/** A validation failure. */
export interface ExpectationValidationResult {
  valid: boolean;
  errors: string[];
}

/** True for a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True for a non-empty string. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * A route segment that looks generated rather than declared.
 * Reuses the same pattern from structuredAssertion.ts for consistency.
 */
const DYNAMIC_PATH_SEGMENT =
  /^(?:[0-9A-HJKMNP-TV-Z]{26}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|\d{4}-\d{2}-\d{2}|[a-zA-Z0-9]{16,}|\d+|[0-9a-fA-F]{8,})$/i;

/** A path holding a value that is a secret rather than a route. */
const SECRET_PATH_PATTERN =
  /\b(token|secret|password|passwd|api[_-]?key|apikey|session|sessionid|sid|jwt|cvv|cvc|otp|nonce|signature|auth)\b/i;

/** An unresolved template placeholder such as `/orders/{id}` or `/x/:id`. */
const TEMPLATE_PLACEHOLDER_PATTERN = /(\{[^}]+\}|:[A-Za-z_]\w*|\$\{[^}]+\}|<[^>]+>)/;

/** Words that mark a path as payment-adjacent. */
const PAYMENT_PATH_PATTERN =
  /\b(pay|payment|checkout|billing|invoice|card|credit|debit|wallet|transfer|remit|donat|subscription|renew)\b/i;

/** Longest path value inspected before it is treated as a template, not a URL. */
const MAX_PATH_LENGTH = 2000;

/**
 * Validate a single expectation value.
 * Returns an array of error messages (empty when valid).
 */
function validateExpectationValue(
  value: unknown,
  index: number,
  journey: JourneyPlan,
): { expectation?: OperatorExpectation; errors: string[] } {
  const errors: string[] = [];
  const label = `expectation at position ${index}`;

  if (!isRecord(value)) {
    return { errors: [`${label} is not an object.`] };
  }

  // --- id ---
  const id = value['id'];
  if (!isNonEmptyString(id)) {
    errors.push(`${label} has no id.`);
  }

  // --- afterStepId ---
  const afterStepId = value['afterStepId'];
  if (!isNonEmptyString(afterStepId)) {
    errors.push(`${label} has no afterStepId.`);
  } else {
    // The step must exist in the journey plan.
    const step = journey.steps.find((s) => s.id === afterStepId);
    if (!step) {
      errors.push(`${label} references step "${afterStepId}" which does not exist in the journey plan.`);
    } else if (!EXPECTATION_BEARING_ACTIONS.has(step.action)) {
      errors.push(
        `${label} references step "${afterStepId}" with action "${step.action}". ` +
          `Only click, submit, and navigate actions can have expectations.`,
      );
    }
  }

  // --- type ---
  const type = value['type'];
  if (type !== 'url-path' && type !== 'url-origin') {
    errors.push(`${label} has unsupported type "${String(type)}". Expected "url-path" or "url-origin".`);
  }

  // --- source ---
  const source = value['source'];
  if (source !== OPERATOR_DECLARED_SOURCE) {
    if (typeof source === 'string' && (REJECTED_SOURCES as readonly string[]).includes(source)) {
      errors.push(
        `${label} has source "${source}". Only "${OPERATOR_DECLARED_SOURCE}" is accepted. ` +
          'Operator expectations must be explicitly declared, never inferred from Scout.',
      );
    } else {
      errors.push(`${label} has invalid source "${String(source)}". Expected "${OPERATOR_DECLARED_SOURCE}".`);
    }
  }

  // --- match ---
  const match = value['match'];
  if (type === 'url-path') {
    if (match !== 'exact' && match !== 'starts-with') {
      errors.push(`${label} has invalid match "${String(match)}" for url-path. Expected "exact" or "starts-with".`);
    }
  } else if (type === 'url-origin') {
    if (match !== 'exact') {
      errors.push(`${label} has invalid match "${String(match)}" for url-origin. Only "exact" is supported.`);
    }
  }

  // --- expectedPath / expectedOrigin ---
  if (type === 'url-path') {
    const expectedPath = value['expectedPath'];
    if (!isNonEmptyString(expectedPath)) {
      errors.push(`${label} (url-path) has no expectedPath.`);
    } else {
      const path = normalizePath(expectedPath);
      if (path.length > MAX_PATH_LENGTH) {
        errors.push(`${label} (url-path) expectedPath is implausibly long.`);
      }
      if (TEMPLATE_PLACEHOLDER_PATTERN.test(path)) {
        errors.push(`${label} (url-path) expectedPath "${path}" contains an unresolved placeholder.`);
      }
      if (SECRET_PATH_PATTERN.test(path)) {
        errors.push(`${label} (url-path) expectedPath "${path}" looks secret-bearing.`);
      }
      if (PAYMENT_PATH_PATTERN.test(path)) {
        errors.push(`${label} (url-path) expectedPath "${path}" is payment-adjacent.`);
      }
      if (!isStablePath(path)) {
        errors.push(`${label} (url-path) expectedPath "${path}" contains a value that looks generated.`);
      }
    }
  }

  if (type === 'url-origin') {
    const expectedOrigin = value['expectedOrigin'];
    if (!isNonEmptyString(expectedOrigin)) {
      errors.push(`${label} (url-origin) has no expectedOrigin.`);
    } else {
      const origin = normalizeOrigin(expectedOrigin);
      if (origin === null) {
        errors.push(`${label} (url-origin) expectedOrigin "${expectedOrigin}" is not a valid origin.`);
      } else {
        // Cross-origin check: the expectation must be on the journey's target origin.
        const journeyOrigin = toOrigin(journey.target.url);
        if (journeyOrigin !== null && origin !== journeyOrigin) {
          errors.push(
            `${label} (url-origin) expectedOrigin "${origin}" is outside the authorized origin ${journeyOrigin}.`,
          );
        }
      }
    }
  }

  // --- reason ---
  const reason = value['reason'];
  if (!isNonEmptyString(reason)) {
    errors.push(`${label} has no reason. Every expectation must state why it exists.`);
  }

  if (errors.length > 0) {
    return { errors };
  }

  return {
    expectation: {
      id: id as string,
      afterStepId: afterStepId as string,
      type: type as 'url-path' | 'url-origin',
      expectedPath: type === 'url-path' ? normalizePath(value['expectedPath'] as string) : undefined,
      expectedOrigin: type === 'url-origin' ? normalizeOrigin(value['expectedOrigin'] as string) ?? undefined : undefined,
      match: match as 'exact' | 'starts-with',
      source: OPERATOR_DECLARED_SOURCE,
      reason: reason as string,
    },
    errors: [],
  };
}

/**
 * Validate a parsed JSON value as an expectations file.
 *
 * @param value the parsed JSON value
 * @param journey the journey plan to bind against
 * @returns validation result with errors (empty when valid)
 */
export function validateExpectationsFile(value: unknown, journey: JourneyPlan): ExpectationValidationResult {
  const errors: string[] = [];

  if (!isRecord(value)) {
    return { valid: false, errors: ['Expectations file root must be a JSON object.'] };
  }

  // --- schema version ---
  const schemaVersion = value['schemaVersion'];
  if (schemaVersion !== EXPECTATIONS_SCHEMA_VERSION) {
    return {
      valid: false,
      errors: [
        `Unsupported expectations schemaVersion "${String(schemaVersion)}". Expected "${EXPECTATIONS_SCHEMA_VERSION}".`,
      ],
    };
  }

  // --- journey plan hash ---
  const journeyPlanHash = value['journeyPlanHash'];
  if (!isNonEmptyString(journeyPlanHash)) {
    errors.push('Expectations file has no journeyPlanHash.');
  } else {
    const expected = journeyHash(journey);
    if (journeyPlanHash !== expected) {
      errors.push(
        `Journey plan hash mismatch. The expectations file declares "${journeyPlanHash}" ` +
          `but the journey plan hashes to "${expected}". The expectations file must be regenerated.`,
      );
    }
  }

  // --- expectations array ---
  const rawExpectations = value['expectations'];
  if (!Array.isArray(rawExpectations)) {
    errors.push('Expectations file is missing an expectations array.');
    return { valid: false, errors };
  }

  if (rawExpectations.length === 0) {
    errors.push('Expectations file has an empty expectations array.');
  }

  // Check for duplicate ids.
  const seenIds = new Set<string>();
  for (let i = 0; i < rawExpectations.length; i++) {
    const entry = rawExpectations[i];
    if (!isRecord(entry)) continue;
    const id = entry['id'];
    if (typeof id === 'string' && id.trim() !== '') {
      if (seenIds.has(id)) {
        errors.push(`Duplicate expectation id "${id}".`);
      }
      seenIds.add(id);
    }
  }

  // Validate each expectation.
  for (let i = 0; i < rawExpectations.length; i++) {
    const result = validateExpectationValue(rawExpectations[i], i, journey);
    errors.push(...result.errors);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Parse and validate an expectations file from a JSON string.
 *
 * @returns the validated expectations file
 * @throws {Error} with a descriptive message when validation fails
 */
export function parseExpectationsFile(text: string, journey: JourneyPlan): ExpectationsFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Expectations file is not valid JSON: ${(error as Error).message}`);
  }

  const result = validateExpectationsFile(parsed, journey);
  if (!result.valid) {
    throw new Error(`Expectations file is invalid:\n${result.errors.map((e) => `  - ${e}`).join('\n')}`);
  }

  return parsed as ExpectationsFile;
}

/**
 * Load and validate an expectations file from disk.
 *
 * @param path the file path
 * @param journey the journey plan to bind against
 * @returns the validated expectations file
 */
export async function loadExpectationsFile(path: string, journey: JourneyPlan): Promise<ExpectationsFile> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error(`Expectations file not found: ${path}.`);
    }
    throw new Error(`Expectations file could not be read: ${(error as Error).message}`);
  }

  return parseExpectationsFile(text, journey);
}

/**
 * Canonicalize expectations for deterministic output.
 *
 * Sorts by afterStepId → type → normalized value → id.
 */
export function canonicalizeExpectations(expectations: readonly OperatorExpectation[]): OperatorExpectation[] {
  return [...expectations].sort((a, b) => {
    // Primary sort: afterStepId
    if (a.afterStepId !== b.afterStepId) return a.afterStepId.localeCompare(b.afterStepId);
    // Secondary sort: type
    if (a.type !== b.type) return a.type.localeCompare(b.type);
    // Tertiary sort: normalized value
    const aValue = a.type === 'url-path' ? a.expectedPath : a.expectedOrigin;
    const bValue = b.type === 'url-path' ? b.expectedPath : b.expectedOrigin;
    if (aValue !== undefined && bValue !== undefined && aValue !== bValue) {
      return aValue.localeCompare(bValue);
    }
    // Final sort: id
    return a.id.localeCompare(b.id);
  });
}

/**
 * Compute a deterministic hash of the expectations file content.
 *
 * Used for provenance and for detecting changed files between reproduction attempts.
 */
export function hashExpectationsFile(content: ExpectationsFile): string {
  const canonical = {
    schemaVersion: content.schemaVersion,
    journeyPlanHash: content.journeyPlanHash,
    expectations: canonicalizeExpectations(content.expectations),
  };
  const serialized = JSON.stringify(canonical);
  return `sha256:${createHash('sha256').update(serialized, 'utf8').digest('hex')}`;
}

/**
 * Read the current URL, tolerating a torn-down or error page.
 */
async function currentUrl(page: Page): Promise<URL | null> {
  try {
    const raw = page.url();
    if (raw === '' || raw.startsWith('chrome-error:')) return null;
    return new URL(raw);
  } catch {
    return null;
  }
}

/**
 * Evaluate expectations after a specific step.
 *
 * @param page the browser page
 * @param expectations the full expectations file
 * @param stepId the step that just completed
 * @returns outcomes for each expectation bound to this step
 */
export async function evaluateExpectations(
  page: Page,
  expectations: ExpectationsFile,
  stepId: string,
): Promise<ExpectationOutcome[]> {
  const bound = expectations.expectations.filter((exp) => exp.afterStepId === stepId);
  if (bound.length === 0) return [];

  const current = await currentUrl(page);

  return bound.map((expectation) => {
    if (current === null) {
      return {
        expectationId: expectation.id,
        afterStepId: expectation.afterStepId,
        type: expectation.type,
        result: 'unevaluable' as const,
        reason: 'The page URL could not be read, so the expectation was not checked.',
      };
    }

    if (expectation.type === 'url-origin') {
      const matched = current.origin === expectation.expectedOrigin;
      return {
        expectationId: expectation.id,
        afterStepId: expectation.afterStepId,
        type: expectation.type,
        result: matched ? ('matched' as const) : ('not-matched' as const),
        actualOrigin: current.origin,
      };
    }

    const actualPath = normalizePath(current.pathname);
    const matched =
      expectation.match === 'starts-with'
        ? actualPath.startsWith(expectation.expectedPath ?? '')
        : actualPath === expectation.expectedPath;

    return {
      expectationId: expectation.id,
      afterStepId: expectation.afterStepId,
      type: expectation.type,
      result: matched ? ('matched' as const) : ('not-matched' as const),
      actualPath,
    };
  });
}

/**
 * The worst outcome across a set of expectation outcomes.
 */
export function worstExpectationOutcome(outcomes: readonly ExpectationOutcome[]): ExpectationResult | null {
  if (outcomes.length === 0) return null;
  if (outcomes.some((outcome) => outcome.result === 'not-matched')) return 'not-matched';
  if (outcomes.some((outcome) => outcome.result === 'unevaluable')) return 'unevaluable';
  return 'matched';
}
