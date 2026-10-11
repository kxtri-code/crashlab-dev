/**
 * Fixtures for Build 6 baseline and candidate-review tests.
 *
 * The reports here are shaped exactly as Builds 3 to 5 write them, so the
 * baseline and review logic is tested against the structures it will meet.
 * Every value is fake and local.
 */

import type { Anomaly } from '../../src/anomaly/types.js';
import type { AnomalyReport } from '../../src/anomaly/report.js';
import type { ExecutionReport, StepExecutionResult } from '../../src/executor/types.js';
import type { JourneyPlan, JourneyStep } from '../../src/journey/types.js';
import type { ReproductionReport } from '../../src/reproducer/types.js';
import { buildEnvironmentProvenance, toEnvironmentReference } from '../../src/provenance/reportMetadata.js';
import { collectRuntimeProvenance } from '../../src/provenance/reportMetadata.js';
import type { Baseline, BaselineIdentity, BaselineSignal } from '../../src/baseline/types.js';
import { buildBaselineIdentity, toBaselineSignal } from '../../src/baseline/identity.js';
import { execStep, execution, journey } from './executionReports.js';
import { signal } from './reproductionFixtures.js';

/** Build 5.1 provenance for a fixture, so fingerprints are real. */
function provenance(overrides: { environmentId?: string | null; appBuildId?: string | null; browserVersion?: string } = {}) {
  return buildEnvironmentProvenance(
    {
      targetUrl: 'https://shop.example.test/checkout',
      browserVersion: overrides.browserVersion ?? '153.0.8010.12',
      headless: true,
      timeoutMs: 15000,
      safeTestMode: true,
      journeySchemaVersion: '1.0',
      testDataFixtureHash: null,
    },
    collectRuntimeProvenance(),
    { environmentId: overrides.environmentId ?? 'local-shop', appBuildId: overrides.appBuildId ?? 'build-001' },
  );
}

/** A journey step with planner defaults. */
export function planStep(overrides: Partial<JourneyStep> & { id: string; order: number }): JourneyStep {
  return {
    intent: overrides.id,
    action: 'observe',
    description: '',
    targetElementIds: [],
    locatorCandidates: [],
    expectedOutcome: '',
    confidence: 0.7,
    executable: false,
    source: { report: 'reports/journey.json', elementIds: [] },
    ...overrides,
  };
}

/** A checkout journey plan. */
export function checkoutJourney(overrides: Partial<JourneyPlan> = {}): JourneyPlan {
  return journey({
    journeyType: 'checkout',
    target: { url: 'https://shop.example.test/checkout', finalUrl: null, title: 'Checkout' },
    steps: [
      planStep({ id: 'step-001', order: 1, intent: 'identify_purchase_control', action: 'identify' }),
      planStep({ id: 'step-002', order: 2, intent: 'identify_payment_control', action: 'identify' }),
    ],
    ...overrides,
  });
}

/** A journey plan that differs from `checkoutJourney`, for incompatible tests. */
export function differentJourney(): JourneyPlan {
  return journey({
    journeyType: 'login',
    goal: 'Try to log in',
    normalizedGoal: 'try to log in',
    target: { url: 'https://shop.example.test/login', finalUrl: null, title: 'Login' },
    steps: [planStep({ id: 'step-001', order: 1, intent: 'locate_login_form', action: 'identify' })],
  });
}

/** A completed execution, optionally with provenance. */
export function cleanExecution(overrides: Partial<ExecutionReport> = {}): ExecutionReport {
  const steps: StepExecutionResult[] = [
    execStep({ id: 'step-001', order: 1, status: 'passed' }),
    execStep({ id: 'step-002', order: 2, status: 'passed' }),
  ];
  return execution({
    status: 'passed',
    goal: 'Try to complete checkout',
    journeyType: 'checkout',
    target: { url: 'https://shop.example.test/checkout', finalUrl: null, title: 'Checkout' },
    steps,
    stepCounts: { total: 2, passed: 2, failed: 0, blocked: 0, skipped: 0 },
    environment: provenance(),
    ...overrides,
  });
}

/** An aborted execution, which must never become a baseline. */
export function abortedExecution(overrides: Partial<ExecutionReport> = {}): ExecutionReport {
  return execution({
    status: 'aborted',
    goal: 'Try to complete checkout',
    journeyType: 'checkout',
    target: { url: 'https://shop.example.test/checkout', finalUrl: null, title: 'Checkout' },
    steps: [execStep({ id: 'step-001', order: 1, status: 'passed' })],
    environment: provenance(),
    ...overrides,
  });
}

/** An execution where every step was blocked. */
export function fullyBlockedExecution(overrides: Partial<ExecutionReport> = {}): ExecutionReport {
  return execution({
    status: 'aborted',
    goal: 'Try to complete checkout',
    steps: [
      execStep({ id: 'step-001', order: 1, status: 'blocked', error: { reason: 'payment-blocked', message: 'blocked', attemptedLocators: [], missingDataKey: null } }),
    ],
    environment: provenance(),
    ...overrides,
  });
}

/** An execution with no safe-test mode, which must be refused. */
export function unsafeExecution(overrides: Partial<ExecutionReport> = {}): ExecutionReport {
  return cleanExecution({
    executor: {
      mode: 'deterministic',
      version: '0.1.0',
      retries: 0,
      stoppedOnFailure: false,
      continueOnFailure: false,
      safeTestMode: false,
    },
    ...overrides,
  });
}

/** A legacy execution report with no provenance. */
export function legacyExecution(overrides: Partial<ExecutionReport> = {}): ExecutionReport {
  const base = cleanExecution(overrides);
  return { ...base, environment: null };
}

/** An HTTP 500 signal with a stable key. */
export function http500(id = 'anomaly-001'): Anomaly {
  return signal({
    id,
    ruleId: 'HTTP_5XX',
    kind: 'http-error',
    signalLevel: 'error',
    details: {
      method: 'POST',
      statusCode: 500,
      resourceType: 'fetch',
      url: 'https://shop.example.test/api/orders',
    },
  });
}

/** A different HTTP status on the same target: a change, not a new signal. */
export function http404(id = 'anomaly-001'): Anomaly {
  return signal({
    id,
    ruleId: 'HTTP_4XX',
    kind: 'http-error',
    signalLevel: 'warning',
    possiblyExpected: true,
    details: {
      method: 'POST',
      statusCode: 404,
      resourceType: 'fetch',
      url: 'https://shop.example.test/api/orders',
    },
  });
}

/** A page error signal with a stable key. */
export function pageErrorSignal500(id = 'anomaly-002'): Anomaly {
  return signal({
    id,
    ruleId: 'PAGE_ERROR',
    kind: 'page-error',
    signalLevel: 'error',
    source: { executionReport: 'reports/execution.json', evidenceType: 'pageError', eventIndex: 0 },
    details: { errorMessage: 'TypeError: cart is undefined', stackSummary: 'TypeError: cart is undefined' },
  });
}

/** An anomaly report carrying the given signals. */
export function anomalyReportWith(
  anomalies: Anomaly[],
  environment: ReturnType<typeof provenance> | null = provenance(),
): AnomalyReport {
  return {
    schemaVersion: '1.0',
    executionReport: 'reports/execution.json',
    journeyReport: 'reports/journey.json',
    executionStatus: 'passed',
    goal: 'Try to complete checkout',
    journeyType: 'checkout',
    summary: {
      totalSignals: anomalies.length,
      httpErrors: 0,
      networkFailures: 0,
      consoleErrors: 0,
      pageErrors: 0,
      timeouts: 0,
      navigationSignals: 0,
      uiStateSignals: 0,
      duplicateRequestSignals: 0,
      stepFailureSignals: 0,
      ruleIds: [...new Set(anomalies.map((a) => a.ruleId))].sort(),
    },
    anomalies,
    warnings: environment === null ? ['Environment provenance is unavailable for this execution report.'] : [],
    analyzer: { mode: 'deterministic', version: '0.1.0' },
    environment: toEnvironmentReference(environment),
    interpretation: {
      confirmedBug: false,
      requiresInvestigation: anomalies.length > 0,
      note: 'fixture',
    },
  };
}

/** A reproduction result entry. */
function reproResult(
  id: string,
  anomalyId: string,
  classification: string,
  ruleId: string,
): ReproductionReport['results'][number] {
  return {
    id,
    anomalyId,
    ruleId,
    classification: classification as ReproductionReport['results'][number]['classification'],
    confirmed: false,
    matchingAttempts: classification === 'reproduced' ? 3 : 0,
    completedAttempts: 3,
    inconclusiveAttempts: 0,
    reproductionRatio: classification === 'reproduced' ? '3/3' : '0/3',
    matchingKey: 'key',
    evidence: [],
    reason: 'fixture',
    ineligibleBecause: null,
    requiresInvestigation: classification === 'reproduced',
    originalEnvironment: null,
    attemptEnvironments: [],
    environmentComparison: { classification: 'unknown', differences: [], unknownReason: null, interpretation: 'fixture' },
  };
}

/** A reproduction report where the given anomaly ids reproduced. */
export function reproductionWith(
  entries: { anomalyId: string; ruleId: string; classification?: string }[],
): ReproductionReport {
  return {
    schemaVersion: '1.0',
    journeyReport: 'reports/journey.json',
    anomalyReport: 'reports/anomalies.json',
    executionReport: 'reports/execution.json',
    goal: 'Try to complete checkout',
    summary: {
      totalSignals: entries.length,
      eligibleSignals: entries.length,
      reproduced: entries.filter((e) => (e.classification ?? 'reproduced') === 'reproduced').length,
      notReproduced: 0,
      inconclusive: 0,
      blocked: 0,
      ineligible: 0,
      candidatesRequiringInvestigation: entries.filter((e) => (e.classification ?? 'reproduced') === 'reproduced').length,
    },
    runs: [],
    results: entries.map((entry, index) =>
      reproResult(`reproduction-${String(index + 1).padStart(3, '0')}`, entry.anomalyId, entry.classification ?? 'reproduced', entry.ruleId),
    ),
    safety: {
      authorizedConfirmationRequired: true,
      safeTestMode: true,
      livePaymentAllowed: false,
      sensitiveValuesRedacted: true,
      attemptsBlockedBySafety: 0,
    },
    reproducer: {
      mode: 'controlled-deterministic',
      version: '0.1.0',
      automaticRetries: false,
      attemptsRequested: 3,
      attemptsCompleted: 3,
      attemptsBlocked: 0,
      attemptsFailed: 0,
    },
    expectations: null,
    interpretation: {
      confirmedBug: false,
      reproducedSignalsAreCandidatesOnly: true,
      note: 'fixture',
    },
  };
}

/** The identity a fixture execution carries. */
export function identityOf(exec: ExecutionReport, plan: JourneyPlan): BaselineIdentity {
  return buildBaselineIdentity(plan, exec);
}

/** Project anomalies into baseline signals. */
export function toSignals(anomalies: Anomaly[], accepted: string[] = []): BaselineSignal[] {
  const ids = new Set(accepted);
  return anomalies
    .map((anomaly) => toBaselineSignal(anomaly, ids.has(anomaly.id)))
    .filter((entry): entry is BaselineSignal => entry !== null);
}

/** Assemble a stored baseline for comparison tests. */
export function baselineOf(options: {
  baselineId?: string;
  identity: BaselineIdentity;
  signals?: BaselineSignal[];
  accepted?: string[];
  environmentFingerprint?: string | null;
}): Baseline {
  return {
    schemaVersion: '1.0',
    baselineId: options.baselineId ?? 'good-v1',
    name: 'Fixture baseline',
    status: 'known-good',
    createdAt: '2026-01-01T00:00:00.000Z',
    confirmation: { explicit: true, confirmedBy: 'operator', acceptedSignalIds: options.accepted ?? [] },
    source: {
      executionReport: 'reports/execution.json',
      anomalyReport: 'reports/anomalies.json',
      journeyReport: 'reports/journey.json',
    },
    identity: { ...options.identity, environmentFingerprint: options.environmentFingerprint ?? options.identity.environmentFingerprint },
    knownSignals: options.signals ?? [],
    verification: {
      complete: true,
      coverage: 'full-plan',
      unverifiedAssertions: 0,
      operatorApproved: false,
    },
    safety: { safeTestMode: true, livePaymentAllowed: false, executionHadFailures: false, executionIncomplete: false },
    rationale: 'fixture baseline',
    interpretation: { confirmedBug: false, automaticSeverity: false, note: 'fixture' },
  };
}
