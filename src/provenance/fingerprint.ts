/**
 * Environment fingerprinting.
 *
 * The fingerprint is `sha256` over a canonical serialization of the safe
 * environment fields. It exists so two runs can be compared without either one
 * claiming more than it knows.
 *
 * **What a fingerprint does not prove.** A matching fingerprint means the
 * recorded safe fields agree. It does not prove two systems are the same system:
 * the same Chromium build against two different application versions, or two
 * applications behind one origin, produce identical fingerprints unless the
 * caller supplies a build ID. That is why `applicationBuildId` and
 * `environmentId` are inputs when supplied, and why the fingerprint is
 * documented as an identity aid rather than proof.
 *
 * **What is deliberately excluded**, because each would make the fingerprint
 * differ between two otherwise identical runs: timestamps, attempt number,
 * duration, report paths, temporary directories, and random ids.
 *
 * Pure: canonical serialization plus a hash, no I/O and no browser.
 */

import { createHash } from 'node:crypto';
import type { FingerprintInput } from './types.js';

/**
 * Fields that identify a run's environment, in a fixed order.
 *
 * Explicit rather than derived from object keys, so adding a field is a
 * deliberate change to what "same environment" means rather than an accident.
 */
export const FINGERPRINT_FIELDS = [
  'targetOrigin',
  'browserName',
  'browserVersion',
  'nodeMajorMinor',
  'platform',
  'architecture',
  'headless',
  'safeTestMode',
  'timeoutMs',
  'journeySchemaVersion',
  'executorVersion',
  'plannerVersion',
  'applicationBuildId',
  'environmentId',
  'testDataFixtureId',
] as const;

/** The value type a fingerprint input can take. */
export type FingerprintValue = string | number | boolean | null;

/** The exact set of values hashed, with `null` for anything not supplied. */
export type FingerprintInputs = Record<(typeof FINGERPRINT_FIELDS)[number], FingerprintValue>;

/**
 * Canonical serialization.
 *
 * Keys are emitted in the fixed `FINGERPRINT_FIELDS` order and `null` is always
 * written explicitly, so "not supplied" hashes the same way every time rather
 * than shifting the JSON. Absent metadata is therefore represented
 * consistently, which is what makes two runs comparable.
 */
export function canonicalizeFingerprintInputs(inputs: Partial<FingerprintInputs>): FingerprintInputs {
  const canonical = {} as FingerprintInputs;
  for (const field of FINGERPRINT_FIELDS) {
    const value = inputs[field];
    canonical[field] = value === undefined ? null : value;
  }
  return canonical;
}

/** The exact string that gets hashed. Exposed so a mismatch can be explained. */
export function fingerprintPayload(inputs: Partial<FingerprintInputs>): string {
  const canonical = canonicalizeFingerprintInputs(inputs);
  // A compact, explicit encoding. JSON would work but this makes the ordering
  // and the null handling visible in one place.
  return FINGERPRINT_FIELDS.map((field) => `${field}=${JSON.stringify(canonical[field])}`).join('\n');
}

/**
 * Compute the environment fingerprint.
 *
 * @returns `sha256:<hex>`, or `null` when there is not enough information to
 * fingerprint at all - a fingerprint derived from nothing would be a
 * meaningless string presented as an identity.
 */
export function computeFingerprint(inputs: Partial<FingerprintInputs>): string | null {
  const canonical = canonicalizeFingerprintInputs(inputs);

  // A fingerprint with no environment-defining input describes nothing. Refusing
  // to produce one is better than emitting a stable hash of "null" six times.
  const hasEnvironment = Object.values(canonical).some((value) => value !== null);
  if (!hasEnvironment) return null;

  const digest = createHash('sha256').update(fingerprintPayload(canonical), 'utf8').digest('hex');
  return `sha256:${digest}`;
}

/** Reduce a full version to major.minor, so a patch bump is not a new environment. */
export function nodeMajorMinor(version: string): string {
  const match = /^v?(\d+)\.(\d+)/.exec(version.trim());
  return match ? `${match[1]}.${match[2]}` : safeShort(version);
}

/** Coerce anything to a short, safe string for fingerprinting. */
function safeShort(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 32 ? trimmed.slice(0, 32) : trimmed;
}

/** Hash fixture bytes, for an opt-in test-data identity marker. */
export function hashFixture(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
