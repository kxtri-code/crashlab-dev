/**
 * Build 6.5: CLI integration for operator-declared expectations.
 *
 * Tests the --expectations flag on execute and reproduce, and the
 * --allow-declared-expectations flag on baseline. Also tests that
 * baseline validation refuses declared expectations without approval.
 */

import { describe, expect, it } from 'vitest';
import { parseExecuteArgs, EXECUTE_FLAGS } from '../../src/cli/executeCommand.js';
import { parseReproduceArgs, REPRODUCE_FLAGS } from '../../src/cli/reproduceCommand.js';
import { parseBaselineArgs, BASELINE_FLAGS } from '../../src/cli/baselineCommand.js';
import { validateBaselineCandidate } from '../../src/baseline/validator.js';
import { buildBaseline } from '../../src/baseline/writer.js';
import { journeyHash } from '../../src/baseline/identity.js';
import { journey, execution, execStep } from '../fixtures/executionReports.js';
import { signal } from '../fixtures/reproductionFixtures.js';
import type { AnomalyReport } from '../../src/anomaly/report.js';
import type { ExecutionReport } from '../../src/executor/types.js';
import type { JourneyPlan, JourneyStep } from '../../src/journey/types.js';
import type { ExpectationsFile } from '../../src/executor/expectations.js';
import { EXPECTATIONS_SCHEMA_VERSION, OPERATOR_DECLARED_SOURCE } from '../../src/executor/expectations.js';

/** A journey step with planner defaults. */
function planStep(overrides: Partial<JourneyStep> & { id: string; order: number }): JourneyStep {
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

/** A journey plan with the given steps. */
function planWithSteps(steps: JourneyStep[]): JourneyPlan {
  return { ...journey(), steps };
}

/** A valid expectations file bound to the given journey. */
function expectationsFile(j: JourneyPlan): ExpectationsFile {
  return {
    schemaVersion: EXPECTATIONS_SCHEMA_VERSION,
    journeyPlanHash: journeyHash(j),
    expectations: [
      {
        id: 'exp-001',
        afterStepId: 'step-1',
        type: 'url-path',
        expectedPath: '/success',
        match: 'exact',
        source: OPERATOR_DECLARED_SOURCE,
        reason: 'SPA success route',
      },
    ],
  };
}

/** A minimal anomaly report for baseline tests. */
function anomalyReport(): AnomalyReport {
  return {
    schemaVersion: '1.0',
    executionReport: 'reports/execution.json',
    journeyReport: 'reports/journey.json',
    executionStatus: 'passed',
    goal: 'Try to complete checkout',
    journeyType: 'checkout',
    summary: {
      totalSignals: 0,
      httpErrors: 0,
      networkFailures: 0,
      consoleErrors: 0,
      pageErrors: 0,
      timeouts: 0,
      navigationSignals: 0,
      uiStateSignals: 0,
      duplicateRequestSignals: 0,
      stepFailureSignals: 0,
      ruleIds: [],
    },
    anomalies: [],
    warnings: [],
    analyzer: { mode: 'deterministic', version: '0.1.0' },
    environment: {
      fingerprint: null,
      origin: null,
      browserName: 'chromium',
      browserVersion: '1.0.0',
      environmentId: null,
      applicationBuildId: null,
    },
    interpretation: {
      confirmedBug: false as const,
      requiresInvestigation: false,
      note: 'fixture',
    },
  };
}

/** An execution report with an expectationFileHash. */
function executionWithExpectations(): ExecutionReport {
  return {
    ...execution(),
    steps: [execStep({ id: 'step-1', order: 1, action: 'click' })],
    stepCounts: { total: 1, passed: 1, failed: 0, blocked: 0, skipped: 0 },
    expectationFileHash: 'sha256:abc123',
    verification: {
      status: 'complete',
      complete: true,
      executedSteps: 1,
      passedSteps: 1,
      failedSteps: 0,
      blockedSteps: 0,
      skippedSteps: 0,
      unverifiedAssertions: 0,
      unverifiedStepIds: [],
      coverage: 'operator-declared',
    },
  };
}

/** An execution report with full verification and no expectations. */
function executionFullyVerified(): ExecutionReport {
  return {
    ...execution(),
    steps: [execStep({ id: 'step-1', order: 1, action: 'click' })],
    stepCounts: { total: 1, passed: 1, failed: 0, blocked: 0, skipped: 0 },
    verification: {
      status: 'complete',
      complete: true,
      executedSteps: 1,
      passedSteps: 1,
      failedSteps: 0,
      blockedSteps: 0,
      skippedSteps: 0,
      unverifiedAssertions: 0,
      unverifiedStepIds: [],
      coverage: 'full-plan',
    },
  };
}

describe('execute CLI: --expectations flag', () => {
  it('includes --expectations in EXECUTE_FLAGS', () => {
    expect(EXECUTE_FLAGS).toContain('--expectations');
  });

  it('parses --expectations with a value', () => {
    const args = parseExecuteArgs(['--journey', 'reports/journey.json', '--expectations', 'reports/expectations.json', '--confirm-authorized']);
    expect(args.valid).toBe(true);
    expect(args.expectationsPath).toBe('reports/expectations.json');
  });

  it('defaults expectationsPath to null', () => {
    const args = parseExecuteArgs(['--journey', 'reports/journey.json', '--confirm-authorized']);
    expect(args.valid).toBe(true);
    expect(args.expectationsPath).toBeNull();
  });

  it('rejects --expectations without a value', () => {
    const args = parseExecuteArgs(['--journey', 'reports/journey.json', '--expectations']);
    expect(args.valid).toBe(false);
    expect(args.error).toContain('requires a value');
  });
});

describe('reproduce CLI: --expectations flag', () => {
  it('includes --expectations in REPRODUCE_FLAGS', () => {
    expect(REPRODUCE_FLAGS).toContain('--expectations');
  });

  it('parses --expectations with a value', () => {
    const args = parseReproduceArgs(['--anomalies', 'reports/anomalies.json', '--journey', 'reports/journey.json', '--expectations', 'reports/expectations.json', '--confirm-authorized']);
    expect(args.valid).toBe(true);
    expect(args.expectationsPath).toBe('reports/expectations.json');
  });

  it('defaults expectationsPath to null', () => {
    const args = parseReproduceArgs(['--anomalies', 'reports/anomalies.json', '--journey', 'reports/journey.json', '--confirm-authorized']);
    expect(args.valid).toBe(true);
    expect(args.expectationsPath).toBeNull();
  });

  it('rejects --expectations without a value', () => {
    const args = parseReproduceArgs(['--anomalies', 'reports/anomalies.json', '--journey', 'reports/journey.json', '--expectations']);
    expect(args.valid).toBe(false);
    expect(args.error).toContain('requires a value');
  });
});

describe('baseline CLI: --allow-declared-expectations flag', () => {
  it('includes --allow-declared-expectations in BASELINE_FLAGS', () => {
    expect(BASELINE_FLAGS).toContain('--allow-declared-expectations');
  });

  it('parses --allow-declared-expectations', () => {
    const args = parseBaselineArgs(['--confirm-known-good', '--allow-declared-expectations', '--baseline-id', 'test']);
    expect(args.valid).toBe(true);
    expect(args.allowDeclaredExpectations).toBe(true);
  });

  it('defaults allowDeclaredExpectations to false', () => {
    const args = parseBaselineArgs(['--confirm-known-good', '--baseline-id', 'test']);
    expect(args.valid).toBe(true);
    expect(args.allowDeclaredExpectations).toBe(false);
  });

  it('rejects --allow-declared-expectations without --confirm-known-good', () => {
    const args = parseBaselineArgs(['--allow-declared-expectations', '--baseline-id', 'test']);
    expect(args.valid).toBe(false);
    expect(args.error).toContain('requires --confirm-known-good');
  });
});

describe('baseline validation: declared expectations', () => {
  it('refuses a baseline when expectations were used but not approved', () => {
    const j = planWithSteps([planStep({ id: 'step-1', order: 1, action: 'click' })]);
    const exec = executionWithExpectations();
    const result = validateBaselineCandidate({
      execution: exec,
      anomalies: anomalyReport(),
      journey: j,
      acceptedSignalIds: [],
      allowDeclaredExpectations: false,
    });
    expect(result.safe).toBe(false);
    expect(result.blockers[0]).toContain('operator-declared expectations');
  });

  it('allows a baseline when expectations were used and approved', () => {
    const j = planWithSteps([planStep({ id: 'step-1', order: 1, action: 'click' })]);
    const exec = executionWithExpectations();
    const result = validateBaselineCandidate({
      execution: exec,
      anomalies: anomalyReport(),
      journey: j,
      acceptedSignalIds: [],
      allowDeclaredExpectations: true,
    });
    expect(result.safe).toBe(true);
  });

  it('allows a baseline when no expectations were used and approval is absent', () => {
    const j = planWithSteps([planStep({ id: 'step-1', order: 1, action: 'click' })]);
    const exec = executionFullyVerified();
    const result = validateBaselineCandidate({
      execution: exec,
      anomalies: anomalyReport(),
      journey: j,
      acceptedSignalIds: [],
      allowDeclaredExpectations: false,
    });
    expect(result.safe).toBe(true);
  });
});

describe('baseline writer: known-good-declared status', () => {
  it('produces known-good-declared when expectations were used and approved', () => {
    const j = planWithSteps([planStep({ id: 'step-1', order: 1, action: 'click' })]);
    const exec = executionWithExpectations();
    const baseline = buildBaseline({
      baselineId: 'test-baseline',
      name: 'Test',
      execution: exec,
      anomalies: anomalyReport(),
      journey: j,
      acceptedSignalIds: [],
      confirmedBy: null,
      paths: { execution: 'reports/execution.json', anomalies: 'reports/anomalies.json', journey: 'reports/journey.json' },
      allowDeclaredExpectations: true,
    });
    expect(baseline.status).toBe('known-good-declared');
    expect(baseline.verification.coverage).toBe('operator-declared');
    expect(baseline.verification.complete).toBe(true);
  });

  it('produces known-good when expectations were used but not approved', () => {
    const j = planWithSteps([planStep({ id: 'step-1', order: 1, action: 'click' })]);
    const exec = executionWithExpectations();
    const baseline = buildBaseline({
      baselineId: 'test-baseline',
      name: 'Test',
      execution: exec,
      anomalies: anomalyReport(),
      journey: j,
      acceptedSignalIds: [],
      confirmedBy: null,
      paths: { execution: 'reports/execution.json', anomalies: 'reports/anomalies.json', journey: 'reports/journey.json' },
      allowDeclaredExpectations: false,
    });
    // Without approval, the baseline falls back to known-good (the validator
    // would have blocked it, but the writer itself doesn't enforce that).
    expect(baseline.status).toBe('known-good');
  });

  it('produces known-good when no expectations were used', () => {
    const j = planWithSteps([planStep({ id: 'step-1', order: 1, action: 'click' })]);
    const exec = executionFullyVerified();
    const baseline = buildBaseline({
      baselineId: 'test-baseline',
      name: 'Test',
      execution: exec,
      anomalies: anomalyReport(),
      journey: j,
      acceptedSignalIds: [],
      confirmedBy: null,
      paths: { execution: 'reports/execution.json', anomalies: 'reports/anomalies.json', journey: 'reports/journey.json' },
      allowDeclaredExpectations: false,
    });
    expect(baseline.status).toBe('known-good');
    expect(baseline.verification.coverage).toBe('full-plan');
  });
});
