/**
 * Test data resolution.
 *
 * Build 3 never invents a value. A `fill`, `select` or `upload` step with no
 * matching entry in the test-data file is *blocked*, not guessed, not defaulted,
 * and not filled with an empty string.
 *
 * Resolution order, as specified:
 *   1. exact target element id   (`element-004`)
 *   2. explicit semantic key     (`email`, `password`)
 *   3. stable field name         (`name` attribute), when the plan exposes one
 *
 * Pure and Playwright-free.
 */

import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { ExecutionRefused } from './types.js';

/** Resolved outcome of looking up a value for a step. */
export interface ResolvedValue {
  found: boolean;
  value: string | null;
  /** The key that satisfied the lookup, for the report. Never the value. */
  key: string | null;
  /** Semantic keys that were tried, in order. */
  triedKeys: string[];
}

/** What a step knows that could identify a field. */
export interface StepDataHints {
  /** Element ids from the plan, tried first and in order. */
  elementIds: readonly string[];
  /** Step intent, which often names the field (`identify_password_field`). */
  intent: string;
  /** Element `name` attribute, when a caller supplies it. */
  fieldName?: string | null;
}

/**
 * Semantic keys implied by a step intent.
 *
 * Deriving these from the intent is what lets `--data '{"password": "..."}'`
 * work without the caller having to know the element id. Deliberately narrow:
 * an unrecognised intent contributes nothing rather than guessing.
 */
export function semanticKeysForIntent(intent: string): string[] {
  const normalized = intent.toLowerCase();
  const keys: string[] = [];

  if (/confirm[_-]?password|password[_-]?confirm/.test(normalized)) keys.push('confirmPassword', 'password');
  if (/password/.test(normalized)) keys.push('password', 'newPassword');
  if (/user|login|identifier/.test(normalized)) keys.push('username', 'email', 'user');
  if (/e-?mail/.test(normalized)) keys.push('email', 'username');
  if (/name/.test(normalized)) keys.push('fullName', 'name');
  if (/search|query|find/.test(normalized)) keys.push('search', 'query');
  if (/message|comment|enquiry|inquiry|description/.test(normalized)) keys.push('message', 'comment');
  if (/select|country/.test(normalized)) keys.push('country');
  if (/phone|tel/.test(normalized)) keys.push('phone');
  if (/address/.test(normalized)) keys.push('address', 'city', 'postalCode', 'country');
  if (/quantity|qty/.test(normalized)) keys.push('quantity');
  if (/coupon|promo|discount/.test(normalized)) keys.push('coupon');
  if (/card|payment/.test(normalized)) keys.push('cardNumber', 'expiry', 'cvv');
  if (/upload|file|attach|document/.test(normalized)) keys.push('file', 'upload');

  return [...new Set(keys)];
}

/** True for a plain object with only string values. */
function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value as Record<string, unknown>).every((entry) => typeof entry === 'string')
  );
}

/**
 * Load a test-data file.
 *
 * Only `{ string: string }` is accepted. A nested object or array would make the
 * resolution order ambiguous, so it is refused rather than coerced.
 */
export async function loadTestData(path: string): Promise<Record<string, string>> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new ExecutionRefused('test-data-missing', `Test data file not found: ${path}.`);
    }
    throw new ExecutionRefused('test-data-unreadable', `Test data file could not be read: ${(error as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ExecutionRefused('test-data-invalid', `Test data file is not valid JSON: ${(error as Error).message}`);
  }

  if (!isStringRecord(parsed)) {
    throw new ExecutionRefused(
      'test-data-invalid',
      'Test data must be a JSON object mapping string keys to string values, for example {"email": "qa@example.test"}.',
    );
  }

  return { ...parsed };
}

/**
 * Resolve the value for a step, or report that none is available.
 *
 * Never returns a guess. `found: false` means the step must be blocked.
 */
export function resolveValue(
  testData: Readonly<Record<string, string>> | undefined,
  hints: StepDataHints,
): ResolvedValue {
  const triedKeys: string[] = [];
  const data = testData ?? {};

  // 1. exact element id, in plan order
  for (const elementId of hints.elementIds) {
    triedKeys.push(elementId);
    const value = data[elementId];
    if (value !== undefined) return { found: true, value, key: elementId, triedKeys };
  }

  // 2. semantic key derived from the step intent
  for (const key of semanticKeysForIntent(hints.intent)) {
    triedKeys.push(key);
    const value = data[key];
    if (value !== undefined) return { found: true, value, key, triedKeys };
  }

  // 3. stable field name
  if (hints.fieldName) {
    triedKeys.push(hints.fieldName);
    const value = data[hints.fieldName];
    if (value !== undefined) return { found: true, value, key: hints.fieldName, triedKeys };
  }

  // No blanket fallback over a generic vocabulary. Offering `email` to a
  // country field would type the wrong data into the wrong control, which is
  // worse than refusing: an unrecognised intent blocks, and the caller adds a
  // key that means something for this field.
  return { found: false, value: null, key: null, triedKeys };
}

/**
 * Resolve a test fixture path for an upload.
 *
 * Restricted to a caller-declared root so the executor cannot be pointed at an
 * arbitrary file on the machine. Uses `relative` rather than string prefixing,
 * so a sibling directory sharing a name prefix (`/tmp/data-evil` against
 * `/tmp/data`) cannot slip through.
 */
export function resolveFixturePath(candidate: string, allowedRoot: string, cwd: string = process.cwd()): string {
  const root = resolve(cwd, allowedRoot);
  const resolved = resolve(cwd, candidate);
  const relativePath = relative(root, resolved);

  const escapes =
    relativePath === '' ||
    isAbsolute(relativePath) ||
    relativePath.startsWith('..') ||
    relativePath.startsWith(`..${sep}`);

  if (escapes) {
    throw new ExecutionRefused(
      'unsafe-test-file',
      `Refusing to upload "${candidate}": it is outside the allowed fixture directory "${allowedRoot}".`,
    );
  }
  return resolved;
}
