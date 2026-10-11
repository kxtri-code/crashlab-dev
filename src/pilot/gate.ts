/**
 * Pilot Execution Safety Gate — Build 10.3.
 *
 * Enforces the central safety invariant:
 * No browser, Playwright context, page, navigation, or external network request
 * may be created unless preflight validation returns `status: "ready"`.
 *
 * Contains ZERO Playwright, browser, or network imports.
 */

import type {
  PilotConfiguration,
  PreflightResult,
  SafetyGateStatus,
} from '../preflight/types.js';
import type { PilotExecutionPlan } from './types.js';

/** Error thrown when execution is attempted on a non-ready pilot configuration. */
export class PilotExecutionGateError extends Error {
  readonly status: SafetyGateStatus;
  readonly reasons: readonly string[];

  constructor(message: string, status: SafetyGateStatus, reasons: readonly string[]) {
    super(message);
    this.name = 'PilotExecutionGateError';
    this.status = status;
    this.reasons = Object.freeze([...reasons]);
  }
}

/**
 * Asserts that a preflight validation result has achieved 'ready' status.
 *
 * Strictly rejects 'blocked' and 'invalid' statuses, as well as undefined,
 * null, or partial results. Never includes raw secrets or credentials in errors.
 *
 * @throws {PilotExecutionGateError} if the configuration is not ready for execution.
 */
export function assertPilotReady(
  preflightResult: PreflightResult | undefined | null,
): asserts preflightResult is PreflightResult & { status: 'ready'; valid: true } {
  if (!preflightResult) {
    throw new PilotExecutionGateError(
      'Pilot execution refused: Preflight validation has not been performed.',
      'invalid',
      ['Preflight validation result is missing or undefined.'],
    );
  }

  if (preflightResult.status !== 'ready' || !preflightResult.valid) {
    const status: SafetyGateStatus = preflightResult.status ?? 'invalid';
    const rawReasons = preflightResult.failureReasons && preflightResult.failureReasons.length > 0
      ? preflightResult.failureReasons
      : preflightResult.errors.map((e) => e.message);

    const reasons = rawReasons.length > 0
      ? rawReasons
      : ['Configuration failed preflight safety criteria.'];

    const summary = status === 'blocked'
      ? 'Pilot execution blocked: Protected staging prerequisites incomplete (authorization or safe test data missing).'
      : 'Pilot execution refused: Configuration is invalid or violates critical safety invariants (bad URL, forbidden actions, or prohibited environment).';

    const message = `${summary}\n${reasons.map((r) => `  - ${r}`).join('\n')}`;

    throw new PilotExecutionGateError(message, status, reasons);
  }
}

/**
 * Creates an immutable PilotExecutionPlan from a validated configuration.
 *
 * Enforces that `preflightResult` is 'ready' before constructing the plan.
 *
 * @throws {PilotExecutionGateError} if preflightResult is not 'ready'.
 */
export function createPilotExecutionPlan(
  config: PilotConfiguration,
  preflightResult: PreflightResult,
): PilotExecutionPlan {
  assertPilotReady(preflightResult);

  if (!preflightResult.targetOrigin) {
    throw new PilotExecutionGateError(
      'Pilot execution refused: Preflight result lacks a valid target origin.',
      'invalid',
      ['Target origin is undefined in preflight result.'],
    );
  }

  const journeys = config.allowedJourneys ?? [];
  const forbidden = config.forbiddenActions ?? [];

  return Object.freeze({
    status: 'ready' as const,
    targetUrl: config.targetUrl,
    targetOrigin: preflightResult.targetOrigin,
    targetEnvironment: preflightResult.targetEnvironment === 'unknown'
      ? config.targetEnvironment
      : preflightResult.targetEnvironment,
    targetName: config.targetName || '(unnamed)',
    appBuildId: config.appBuildId ?? null,
    allowedOrigins: Object.freeze([...preflightResult.metadata.allowedOrigins]),
    approvedJourneys: Object.freeze(journeys.map((j) => Object.freeze({ ...j }))),
    forbiddenActions: Object.freeze([...forbidden]),
    testDataFile: config.testDataFile,
    authorizationReference: config.authorizationReference,
    resetProcedure: config.resetProcedure,
    testingWindow: config.testingWindow,
  });
}
