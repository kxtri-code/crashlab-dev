/**
 * Fixtures for the Controlled Reproducer tests.
 *
 * Anomaly and journey reports are shaped exactly as Builds 2 and 4 write them,
 * so the reproducer is tested against the structures it will meet. Every URL,
 * host and value here is fake and local.
 */

import type { Anomaly } from '../../src/anomaly/types.js';
import type { AnomalyReport } from '../../src/anomaly/report.js';
import type { JourneyPlan } from '../../src/journey/types.js';
import type { ExecutionReport, StepExecutionResult } from '../../src/executor/types.js';
import type { ReproductionRun } from '../../src/reproducer/types.js';
import { toEnvironmentReference } from '../../src/provenance/reportMetadata.js';
import { execStep, execution, journey, netEvent, stepError } from './executionReports.js';

/** A signal with sensible defaults, so a fixture states only what it tests. */
export function signal(overrides: Partial<Anomaly> & { id: string; ruleId: Anomaly['ruleId'] }): Anomaly {
  return {
    kind: 'network-failure',
    signalLevel: 'error',
    status: 'observed',
    message: 'Observed during execution.',
    stepId: null,
    stepOrder: null,
    source: { executionReport: 'reports/execution.json', evidenceType: 'network', eventIndex: 0 },
    details: {},
    possiblyExpected: false,
    confirmed: false,
    occurrences: 1,
    ...overrides,
  };
}

/** A valid anomaly report carrying the given signals. */
export function anomalyReport(signals: Anomaly[], overrides: Partial<AnomalyReport> = {}): AnomalyReport {
  return {
    schemaVersion: '1.0',
    executionReport: 'reports/execution.json',
    journeyReport: 'reports/journey.json',
    executionStatus: 'passed',
    goal: 'Try to complete checkout',
    journeyType: 'checkout',
    summary: {
      totalSignals: signals.length,
      httpErrors: 0,
      networkFailures: 0,
      consoleErrors: 0,
      pageErrors: 0,
      timeouts: 0,
      navigationSignals: 0,
      uiStateSignals: 0,
      duplicateRequestSignals: 0,
      stepFailureSignals: 0,
      ruleIds: [...new Set(signals.map((s) => s.ruleId))].sort(),
    },
    anomalies: signals,
    warnings: [],
    analyzer: { mode: 'deterministic', version: '0.1.0' },
    // A fixture carries no provenance unless it says so, which is also the
    // legacy-report case the compatibility tests exercise.
    environment: toEnvironmentReference(null),
    interpretation: {
      confirmedBug: false,
      requiresInvestigation: signals.length > 0,
      note: 'fixture',
    },
    ...overrides,
  };
}

/** Default matching details for an HTTP 5xx signal. */
export function http5xxDetails(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    method: 'POST',
    statusCode: 500,
    resourceType: 'fetch',
    url: 'https://fixture.test/api/checkout',
    ...overrides,
  };
}

/** A stable HTTP 500 signal. */
export function http5xxSignal(id = 'anomaly-001'): Anomaly {
  return signal({ id, ruleId: 'HTTP_5XX', kind: 'http-error', signalLevel: 'error', details: http5xxDetails() });
}

/** A stable network-failure signal. */
export function networkFailureSignal(id = 'anomaly-001'): Anomaly {
  return signal({
    id,
    ruleId: 'NETWORK_REQUEST_FAILED',
    kind: 'network-failure',
    details: {
      method: 'GET',
      url: 'https://fixture.test/api/thing',
      resourceType: 'fetch',
      failure: 'net::ERR_CONNECTION_REFUSED',
    },
  });
}

/** A stable console-error signal. */
export function consoleErrorSignal(id = 'anomaly-001'): Anomaly {
  return signal({
    id,
    ruleId: 'CONSOLE_ERROR',
    kind: 'console',
    signalLevel: 'warning',
    possiblyExpected: true,
    source: { executionReport: 'reports/execution.json', evidenceType: 'console', eventIndex: 0 },
    details: { consoleType: 'error', text: 'app error occurred', url: 'https://fixture.test/app.js', line: 12 },
  });
}

/** A stable page-error signal. */
export function pageErrorSignal(id = 'anomaly-001'): Anomaly {
  return signal({
    id,
    ruleId: 'PAGE_ERROR',
    kind: 'page-error',
    source: { executionReport: 'reports/execution.json', evidenceType: 'pageError', eventIndex: 0 },
    details: { errorMessage: 'TypeError: undefined is not a function', stackSummary: 'TypeError: undefined is not a function' },
  });
}

/** A stable step-timeout signal. */
export function timeoutSignal(id = 'anomaly-001'): Anomaly {
  return signal({
    id,
    ruleId: 'STEP_TIMEOUT',
    kind: 'timeout',
    stepId: 'step-002',
    stepOrder: 2,
    source: { executionReport: 'reports/execution.json', evidenceType: 'step', eventIndex: null },
    details: { action: 'click', intent: 'confirm', durationMs: 15000, url: 'https://fixture.test/checkout', reportedReason: 'timed-out' },
  });
}

/** A stable missing-target signal, attached to an attempted step. */
export function missingTargetSignal(id = 'anomaly-001'): Anomaly {
  return signal({
    id,
    ruleId: 'TARGET_MISSING_AFTER_ACTION',
    kind: 'ui-state',
    stepId: 'step-003',
    stepOrder: 3,
    source: { executionReport: 'reports/execution.json', evidenceType: 'step', eventIndex: null },
    details: {
      action: 'click',
      intent: 'confirm',
      selectedLocator: "page.getByTestId('confirm')",
      targetElementIds: ['element-004'],
      url: 'https://fixture.test/checkout',
      reportedReason: 'locator-not-found',
    },
  });
}

/** An ineligible HTTP 404 signal. */
export function http4xxSignal(id = 'anomaly-001'): Anomaly {
  return signal({
    id,
    ruleId: 'HTTP_4XX',
    kind: 'http-error',
    signalLevel: 'warning',
    possiblyExpected: true,
    details: http5xxDetails({ statusCode: 404, method: 'GET' }),
  });
}

/**
 * An ineligible duplicate-request signal.
 *
 * Level `warning`, not `info`: an `info` signal is never reproduced regardless of
 * the rule policy, so an `info` fixture could not exercise the rule gate.
 */
export function duplicateSignal(id = 'anomaly-001'): Anomaly {
  return signal({
    id,
    ruleId: 'DUPLICATE_REQUEST',
    kind: 'duplicate-request',
    signalLevel: 'warning',
    possiblyExpected: true,
    details: {
      duplicateKey: 'GET|https://fixture.test/analytics|xhr',
      method: 'GET',
      url: 'https://fixture.test/analytics',
      resourceType: 'xhr',
      count: 4,
      eventIndexes: [0, 1, 2, 3],
    },
  });
}

/**
 * A completed attempt carrying the given signals.
 *
 * Attempt reports are the output of the Build 4 classifier against a Build 3
 * execution, which is exactly this shape.
 */
export function attempt(attemptNumber: number, signals: Anomaly[] = []): ReproductionRun {
  return {
    attempt: attemptNumber,
    name: `attempt-${String(attemptNumber).padStart(3, '0')}`,
    executionReport: `reports/reproduction/attempt-${String(attemptNumber).padStart(3, '0')}/execution.json`,
    anomalyReport: `reports/reproduction/attempt-${String(attemptNumber).padStart(3, '0')}/anomalies.json`,
    status: 'completed',
    detail: null,
    environmentFingerprint: null,
    environmentId: null,
    applicationBuildId: null,
    execution: execution(),
    anomalies: anomalyReport(signals, { executionStatus: 'passed' }),
  };
}

/** An attempt that could not run. */
export function failedAttempt(attemptNumber: number): ReproductionRun {
  return { ...attempt(attemptNumber), status: 'failed', detail: 'browser launch failed' };
}

/** A stable step fixture for journey-shaped inputs. */
export function step(overrides: Partial<StepExecutionResult> & { id: string; order: number }): StepExecutionResult {
  return execStep(overrides);
}

/** A network event with a given status, for execution-shaped inputs. */
export { netEvent, execution, journey, stepError };

/** A minimal journey for reproducer inputs. */
export function reproJourney(overrides: Partial<JourneyPlan> = {}): JourneyPlan {
  return journey(overrides);
}

/** A minimal execution report, for reproducer inputs. */
export function reproExecution(overrides: Partial<ExecutionReport> = {}): ExecutionReport {
  return execution(overrides);
}
