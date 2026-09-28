/**
 * Execution and journey report fixtures for Anomaly Engine tests.
 *
 * Hand-authored but shaped exactly like Build 3's real output, so the analyzer
 * is tested against the structure it will actually meet. Every URL, host and
 * secret here is fake and local.
 */

import type { ExecutionReport, StepError, StepExecutionResult } from '../../src/executor/types.js';
import type { JourneyPlan } from '../../src/journey/types.js';

/** A step result with planner defaults, so a fixture states only what it tests. */
export function execStep(overrides: Partial<StepExecutionResult> & { id: string; order: number }): StepExecutionResult {
  return {
    intent: overrides.id,
    action: 'observe',
    status: 'passed',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:00.100Z',
    durationMs: 100,
    selectedLocator: null,
    targetElementIds: [],
    urlBefore: 'https://fixture.test/',
    urlAfter: 'https://fixture.test/',
    observations: null,
    evidence: {
      screenshot: null,
      screenshotOmitted: true,
      screenshotOmittedReason: 'screenshots-disabled',
      consoleEvents: [],
      pageErrors: [],
      networkEvents: [],
      dialogObserved: false,
      pageChanged: false,
    },
    error: null,
    description: '',
    planConfidence: 0.7,
    ...overrides,
  };
}

/** A valid execution report with the given steps and evidence. */
export function execution(overrides: Partial<ExecutionReport> = {}): ExecutionReport {
  return {
    schemaVersion: '1.0',
    journeyPlanSchemaVersion: '1.0',
    journeyReport: 'reports/journey.json',
    goal: 'Try to complete checkout',
    journeyType: 'checkout',
    target: { url: 'https://fixture.test/checkout', finalUrl: 'https://fixture.test/checkout', title: 'Fixture' },
    status: 'passed',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    durationMs: 1000,
    stepCounts: { total: 0, passed: 0, failed: 0, blocked: 0, skipped: 0 },
    steps: [],
    rawEvidence: { consoleEvents: [], pageErrors: [], networkEvents: [], screenshots: [] },
    warnings: [],
    blockedSteps: [],
    redaction: {
      sensitiveValuesRedacted: true,
      redactedValueCount: 0,
      dataProvidedKeys: [],
      dataProvided: false,
      screenshotsOmittedAfterSensitiveData: false,
    },
    executor: {
      mode: 'deterministic',
      version: '0.1.0',
      retries: 0,
      stoppedOnFailure: false,
      continueOnFailure: false,
      safeTestMode: true,
    },
    ...overrides,
  };
}

/** A valid journey plan, for origin context. */
export function journey(overrides: Partial<JourneyPlan> = {}): JourneyPlan {
  return {
    schemaVersion: '1.0',
    goal: 'Try to complete checkout',
    normalizedGoal: 'try to complete checkout',
    journeyType: 'checkout',
    target: { url: 'https://fixture.test/checkout', finalUrl: 'https://fixture.test/checkout', title: 'Fixture' },
    steps: [],
    assumptions: [],
    warnings: [],
    missingInformation: [],
    planner: { mode: 'heuristic', version: '0.1.0' },
    ...overrides,
  };
}

/** A network event with sensible defaults. */
export function netEvent(overrides: Partial<ExecutionReport['rawEvidence']['networkEvents'][number]> = {}) {
  return {
    method: 'GET',
    url: 'https://fixture.test/api/thing',
    path: '/api/thing',
    status: 200,
    resourceType: 'xhr',
    durationMs: 12,
    thirdParty: false,
    failure: null,
    ...overrides,
  };
}

/** A console event with sensible defaults. */
export function consoleEvent(overrides: Partial<ExecutionReport['rawEvidence']['consoleEvents'][number]> = {}) {
  return {
    type: 'log',
    text: 'ordinary message',
    url: 'https://fixture.test/app.js',
    line: 10,
    ...overrides,
  };
}

/** A page error with sensible defaults. */
export function pageError(overrides: Partial<ExecutionReport['rawEvidence']['pageErrors'][number]> = {}) {
  return {
    message: 'something went wrong',
    stack: 'Error: something went wrong\n    at app.js:1:1',
    ...overrides,
  };
}

/** A structured step error, typed against the real `BlockReason` union. */
export function stepError(reason: StepError['reason'], message = 'step failed'): StepError {
  return { reason, message, attemptedLocators: [], missingDataKey: null };
}
