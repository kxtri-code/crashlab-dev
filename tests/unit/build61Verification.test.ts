import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { classifyAssertion, isUnverifiableAssertion, skipReasonFor } from '../../src/executor/assertionClassifier.js';
import { buildVerification, deriveExecutionStatus, isFullyVerified } from '../../src/executor/verification.js';
import { buildExecutionReport, summarizeExecution } from '../../src/executor/executionReport.js';
import { validateBaselineCandidate } from '../../src/baseline/validator.js';
import { buildBaseline } from '../../src/baseline/writer.js';
import { buildCandidateReport, summarizeCandidateReport } from '../../src/review/candidateReport.js';
import { parseBaselineArgs } from '../../src/cli/baselineCommand.js';
import type { JourneyStep } from '../../src/journey/types.js';
import type { StepExecutionResult } from '../../src/executor/types.js';
import {
  abortedExecution,
  anomalyReportWith,
  baselineOf,
  checkoutJourney,
  cleanExecution,
  fullyBlockedExecution,
  http500,
  identityOf,
  legacyExecution,
  planStep,
  reproductionWith,
  toSignals,
} from '../fixtures/build6Fixtures.js';
import { execution, journey } from '../fixtures/executionReports.js';
import { execStep } from '../fixtures/executionReports.js';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'crashlab-b61-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A plan step with planner defaults. */
function step(overrides: Partial<JourneyStep> & { id: string; order: number }): JourneyStep {
  return planStep(overrides);
}

/** The exact Build 2 shape: a final prose expectation with no target. */
function proseAssertionStep(id = 'step-005', order = 5): JourneyStep {
  return step({
    id,
    order,
    intent: 'define_login_success',
    action: 'assert',
    description: 'Define the expected successful outcome',
    expectedOutcome: 'The user is successfully logged in',
  });
}

/** A step result with executor defaults. */
function result(overrides: Partial<StepExecutionResult> & { id: string; status: StepExecutionResult['status'] }): StepExecutionResult {
  return execStep({ order: 1, ...overrides });
}

describe('prose-assertion classification', () => {
  it('classifies a targetless prose assertion as prose-only', () => {
    const verdict = classifyAssertion(proseAssertionStep());
    expect(verdict.kind).toBe('prose-only');
    if (verdict.kind === 'prose-only') {
      expect(verdict.skipReason).toBe('unsupported-prose-assertion');
    }
  });

  it('classifies an assertion with a usable locator as structured', () => {
    // Build 6.1 must not break the deterministic assertions Build 3 already
    // evaluated correctly.
    const verdict = classifyAssertion(
      step({ id: 'step-003', order: 3, action: 'assert', locatorCandidates: ["page.getByTestId('confirm')"] }),
    );
    expect(verdict.kind).toBe('structured');
  });

  it('classifies a targeted assertion with no usable locator as targeted-prose', () => {
    const verdict = classifyAssertion(
      step({ id: 'step-003', order: 3, action: 'assert', targetElementIds: ['element-004'], locatorCandidates: [] }),
    );
    expect(verdict.kind).toBe('targeted-prose');
  });

  it('ignores non-assertion steps', () => {
    expect(classifyAssertion(step({ id: 'step-001', order: 1, action: 'click' })).kind).toBe('not-an-assertion');
  });

  it('reports which steps are unverifiable', () => {
    expect(isUnverifiableAssertion(proseAssertionStep())).toBe(true);
    expect(isUnverifiableAssertion(step({ id: 's', order: 1, action: 'click' }))).toBe(false);
    expect(
      isUnverifiableAssertion(step({ id: 's', order: 1, action: 'assert', locatorCandidates: ['#x'] })),
    ).toBe(false);
  });

  it('gives a skip reason carrying the reason it could not evaluate', () => {
    const reason = skipReasonFor(proseAssertionStep());
    expect(reason?.skipReason).toBe('unsupported-prose-assertion');
    expect(reason?.reason).toMatch(/not evaluated/);
  });
});

describe('step-level status for an unverified assertion', () => {
  const skippedUnverified = result({
    id: 'step-005',
    order: 5,
    action: 'assert',
    status: 'skipped',
    skipReason: 'unsupported-prose-assertion',
    verification: { status: 'unverified', reason: 'natural language' },
    error: null,
  });

  it('is skipped, not failed', () => {
    expect(skippedUnverified.status).toBe('skipped');
  });

  it('is not blocked', () => {
    // A block is a refusal on safety grounds; this is not one.
    expect(skippedUnverified.status).not.toBe('blocked');
    expect(skippedUnverified.error).toBeNull();
  });

  it('is not passed', () => {
    // Nobody evaluated it, so it is not verified.
    expect(skippedUnverified.status).not.toBe('passed');
  });

  it('carries explicit verification metadata', () => {
    expect(skippedUnverified.verification?.status).toBe('unverified');
  });

  it('carries a skip reason', () => {
    expect(skippedUnverified.skipReason).toBe('unsupported-prose-assertion');
  });
});

describe('top-level status and verification', () => {
  const executed = result({ id: 'step-001', order: 1, status: 'passed' });
  const unverified = result({
    id: 'step-005',
    order: 5,
    action: 'assert',
    status: 'skipped',
    skipReason: 'unsupported-prose-assertion',
    verification: { status: 'unverified', reason: 'natural language' },
  });

  it('completes rather than aborting when only a prose assertion remains', () => {
    const status = deriveExecutionStatus([executed, unverified], false);
    expect(status).toBe('completed');
    expect(status).not.toBe('aborted');
    expect(status).not.toBe('failed');
  });

  it('is passed only when everything evaluated succeeded', () => {
    expect(deriveExecutionStatus([executed], false)).toBe('passed');
  });

  it('still fails when a real action failed alongside a prose assertion', () => {
    // An unverified assertion must not mask a real failure.
    const failed = result({ id: 'step-002', order: 2, status: 'failed' });
    expect(deriveExecutionStatus([executed, failed, unverified], false)).toBe('failed');
  });

  it('still blocks when a safety guard refused a step', () => {
    const blocked = result({ id: 'step-002', order: 2, status: 'blocked' });
    expect(deriveExecutionStatus([executed, blocked, unverified], false)).toBe('blocked');
  });

  it('aborts only on a real interruption', () => {
    expect(deriveExecutionStatus([executed], true)).toBe('aborted');
  });

  it('records verification as partial with executed-steps-only coverage', () => {
    const verification = buildVerification([executed, unverified], false);
    expect(verification.status).toBe('partial');
    expect(verification.complete).toBe(false);
    expect(verification.coverage).toBe('executed-steps-only');
    expect(verification.unverifiedAssertions).toBe(1);
    expect(verification.unverifiedStepIds).toEqual(['step-005']);
  });

  it('never claims complete while an unverified assertion remains', () => {
    expect(buildVerification([executed, unverified], false).complete).toBe(false);
  });

  it('is complete when every executed step succeeded and nothing is unverified', () => {
    const verification = buildVerification([executed], false);
    expect(verification.status).toBe('complete');
    expect(verification.complete).toBe(true);
    expect(verification.coverage).toBe('full-plan');
  });

  it('counts steps correctly', () => {
    const verification = buildVerification(
      [
        executed,
        result({ id: 'step-002', order: 2, status: 'failed' }),
        result({ id: 'step-003', order: 3, status: 'blocked' }),
        unverified,
      ],
      false,
    );
    expect(verification.executedSteps).toBe(3);
    expect(verification.passedSteps).toBe(1);
    expect(verification.failedSteps).toBe(1);
    expect(verification.blockedSteps).toBe(1);
    expect(verification.skippedSteps).toBe(1);
    expect(verification.unverifiedAssertions).toBe(1);
  });

  it('marks an interrupted run incomplete', () => {
    const verification = buildVerification([executed], true);
    expect(verification.status).toBe('incomplete');
    expect(verification.complete).toBe(false);
    expect(verification.coverage).toBe('partial-plan');
  });

  it('marks a failed run incomplete', () => {
    expect(buildVerification([result({ id: 's', order: 1, status: 'failed' })], false).status).toBe('incomplete');
  });

  it('records sorted unverified step ids', () => {
    const verification = buildVerification(
      [
        result({ id: 'step-009', order: 9, status: 'skipped', verification: { status: 'unverified', reason: 'r' } }),
        result({ id: 'step-002', order: 2, status: 'skipped', verification: { status: 'unverified', reason: 'r' } }),
      ],
      false,
    );
    expect(verification.unverifiedStepIds).toEqual(['step-002', 'step-009']);
  });

  it('distinguishes a benign skip from an unverified assertion', () => {
    // A no-target observation is skipped, but nothing is unverified.
    const benign = result({ id: 'step-004', order: 4, status: 'skipped', skipReason: 'no-target' });
    const verification = buildVerification([executed, benign], false);
    expect(verification.unverifiedAssertions).toBe(0);
    expect(verification.status).toBe('complete');
  });

  it('exposes a full-verification helper', () => {
    expect(isFullyVerified(buildVerification([executed], false))).toBe(true);
    expect(isFullyVerified(buildVerification([executed, unverified], false))).toBe(false);
    expect(isFullyVerified(null)).toBe(false);
  });
});

describe('execution report carries verification', () => {
  it('includes a verification object', () => {
    const report = buildExecutionReport({
      plan: checkoutJourney(),
      options: { plan: checkoutJourney(), planPath: 'reports/journey.json' },
      steps: [
        result({ id: 'step-001', order: 1, status: 'passed' }),
        result({
          id: 'step-005',
          order: 5,
          action: 'assert',
          status: 'skipped',
          skipReason: 'unsupported-prose-assertion',
          verification: { status: 'unverified', reason: 'natural language' },
        }),
      ],
      rawEvidence: { consoleEvents: [], pageErrors: [], networkEvents: [], screenshots: [] },
      redaction: {
        sensitiveValuesRedacted: true,
        redactedValueCount: 0,
        dataProvidedKeys: [],
        dataProvided: false,
        screenshotsOmittedAfterSensitiveData: false,
      },
      environment: null,
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:01.000Z',
      durationMs: 1000,
      finalUrl: null,
      aborted: false,
      stoppedOnFailure: false,
      warnings: [],
    });
    expect(report.status).toBe('completed');
    expect(report.verification?.status).toBe('partial');
    expect(report.verification?.coverage).toBe('executed-steps-only');
  });

  it('states in the summary that completion is not full verification', () => {
    const report = buildExecutionReport({
      plan: checkoutJourney(),
      options: { plan: checkoutJourney(), planPath: 'p' },
      steps: [
        result({ id: 'step-001', order: 1, status: 'passed' }),
        result({
          id: 'step-005',
          order: 5,
          action: 'assert',
          status: 'skipped',
          verification: { status: 'unverified', reason: 'natural language' },
        }),
      ],
      rawEvidence: { consoleEvents: [], pageErrors: [], networkEvents: [], screenshots: [] },
      redaction: {
        sensitiveValuesRedacted: true,
        redactedValueCount: 0,
        dataProvidedKeys: [],
        dataProvided: false,
        screenshotsOmittedAfterSensitiveData: false,
      },
      environment: null,
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:01.000Z',
      durationMs: 1,
      finalUrl: null,
      aborted: false,
      stoppedOnFailure: false,
      warnings: [],
    });
    const summary = summarizeExecution(report);
    expect(summary).toMatch(/COMPLETED/);
    expect(summary).toMatch(/partial/);
    expect(summary).toMatch(/does not mean every expected outcome was proven/);
  });
});

describe('baseline readiness with partial verification', () => {
  /** An execution that ran cleanly but left a prose assertion unverified. */
  function partialExecution() {
    return cleanExecution({
      status: 'completed',
      steps: [
        execStep({ id: 'step-001', order: 1, status: 'passed' }),
        execStep({
          id: 'step-005',
          order: 5,
          action: 'assert',
          status: 'skipped',
          skipReason: 'unsupported-prose-assertion',
          verification: { status: 'unverified', reason: 'natural language' },
        }),
      ],
      verification: {
        status: 'partial',
        complete: false,
        executedSteps: 1,
        passedSteps: 1,
        failedSteps: 0,
        blockedSteps: 0,
        skippedSteps: 1,
        unverifiedAssertions: 1,
        unverifiedStepIds: ['step-005'],
        coverage: 'executed-steps-only',
      },
    });
  }

  it('rejects a partial run without the allowance flag', () => {
    const result = validateBaselineCandidate({
      execution: partialExecution(),
      anomalies: anomalyReportWith([]),
      journey: checkoutJourney(),
      acceptedSignalIds: [],
    });
    expect(result.safe).toBe(false);
    expect(result.blockers.join(' ')).toMatch(/--allow-unverified-assertions/);
  });

  it('accepts a partial run when the operator allowed it', () => {
    const result = validateBaselineCandidate({
      execution: partialExecution(),
      anomalies: anomalyReportWith([]),
      journey: checkoutJourney(),
      acceptedSignalIds: [],
      allowUnverifiedAssertions: true,
    });
    expect(result.safe).toBe(true);
    expect(result.partial).toBe(true);
  });

  it('still rejects a failed action even with the allowance', () => {
    // The allowance covers unverified expectations, never a real failure.
    const result = validateBaselineCandidate({
      execution: cleanExecution({
        status: 'failed',
        steps: [execStep({ id: 'step-001', order: 1, status: 'failed' })],
      }),
      anomalies: anomalyReportWith([]),
      journey: checkoutJourney(),
      acceptedSignalIds: [],
      allowUnverifiedAssertions: true,
    });
    expect(result.safe).toBe(false);
    expect(result.blockers.join(' ')).toMatch(/failed/i);
  });

  it('still rejects a blocked action even with the allowance', () => {
    // A refusal is CrashLab declining, not a known-good state.
    const result = validateBaselineCandidate({
      execution: fullyBlockedExecution(),
      anomalies: anomalyReportWith([]),
      journey: checkoutJourney(),
      acceptedSignalIds: [],
      allowUnverifiedAssertions: true,
    });
    expect(result.safe).toBe(false);
  });

  it('still rejects an aborted run', () => {
    const result = validateBaselineCandidate({
      execution: abortedExecution(),
      anomalies: anomalyReportWith([]),
      journey: checkoutJourney(),
      acceptedSignalIds: [],
      allowUnverifiedAssertions: true,
    });
    expect(result.safe).toBe(false);
    expect(result.blockers.join(' ')).toMatch(/aborted/);
  });

  it('records a partial baseline as known-good-partial, never as fully verified', () => {
    const baseline = buildBaseline({
      baselineId: 'partial-v1',
      name: 'Partial',
      execution: partialExecution(),
      anomalies: anomalyReportWith([]),
      journey: checkoutJourney(),
      acceptedSignalIds: [],
      confirmedBy: 'operator',
      allowUnverifiedAssertions: true,
      paths: { execution: 'e', anomalies: 'a', journey: 'j' },
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    expect(baseline.status).toBe('known-good-partial');
    expect(baseline.verification.complete).toBe(false);
    expect(baseline.verification.coverage).toBe('executed-steps-only');
    expect(baseline.verification.unverifiedAssertions).toBe(1);
    expect(baseline.verification.operatorApproved).toBe(true);
  });

  it('keeps a fully verified baseline as known-good', () => {
    const baseline = buildBaseline({
      baselineId: 'good-v1',
      name: 'Good',
      execution: cleanExecution({
        verification: {
          status: 'complete',
          complete: true,
          executedSteps: 2,
          passedSteps: 2,
          failedSteps: 0,
          blockedSteps: 0,
          skippedSteps: 0,
          unverifiedAssertions: 0,
          unverifiedStepIds: [],
          coverage: 'full-plan',
        },
      }),
      anomalies: anomalyReportWith([]),
      journey: checkoutJourney(),
      acceptedSignalIds: [],
      confirmedBy: 'operator',
      paths: { execution: 'e', anomalies: 'a', journey: 'j' },
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    expect(baseline.status).toBe('known-good');
    expect(baseline.verification.complete).toBe(true);
    expect(baseline.verification.coverage).toBe('full-plan');
  });

  it('does not dress a legacy report up as verified', () => {
    const baseline = buildBaseline({
      baselineId: 'legacy-v1',
      name: 'Legacy',
      execution: legacyExecution(),
      anomalies: anomalyReportWith([]),
      journey: checkoutJourney(),
      acceptedSignalIds: [],
      confirmedBy: 'operator',
      allowUnverifiedAssertions: true,
      paths: { execution: 'e', anomalies: 'a', journey: 'j' },
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    // No verification metadata means nothing is claimed, not that all passed.
    expect(baseline.verification.coverage).toBe('unavailable');
    expect(baseline.verification.complete).toBe(false);
  });
});

describe('baseline CLI flags', () => {
  it('requires confirmation alongside the allowance', () => {
    // Allowing a partial run is not the same as approving it.
    const args = parseBaselineArgs(['--baseline-id', 'v1', '--allow-unverified-assertions']);
    expect(args.valid).toBe(false);
    expect(args.error).toMatch(/--confirm-known-good/);
  });

  it('accepts both flags together', () => {
    const args = parseBaselineArgs([
      '--baseline-id',
      'v1',
      '--confirm-known-good',
      '--allow-unverified-assertions',
    ]);
    expect(args.valid).toBe(true);
    expect(args.allowUnverifiedAssertions).toBe(true);
  });

  it('does not enable the allowance by default', () => {
    expect(parseBaselineArgs(['--baseline-id', 'v1', '--confirm-known-good']).allowUnverifiedAssertions).toBe(false);
  });
});

describe('candidate review understands a partial baseline', () => {
  const plan = checkoutJourney();

  /** A baseline recorded from a partially verified run. */
  function partialBaseline() {
    return {
      ...baselineOf({ identity: identityOf(cleanExecution(), plan), signals: toSignals([http500()], ['anomaly-001']) }),
      status: 'known-good-partial' as const,
      verification: {
        complete: false,
        coverage: 'executed-steps-only' as const,
        unverifiedAssertions: 1,
        operatorApproved: true,
      },
    };
  }

  const paths = {
    execution: 'reports/execution.json',
    anomalies: 'reports/anomalies.json',
    reproduction: 'reports/reproduction.json',
    journey: 'reports/journey.json',
    baseline: 'reports/baselines/partial-v1.json',
  };

  it('reports the baseline verification scope', () => {
    const report = buildCandidateReport({
      baseline: partialBaseline(),
      execution: cleanExecution(),
      anomalies: anomalyReportWith([http500()]),
      reproduction: reproductionWith([{ anomalyId: 'anomaly-001', ruleId: 'HTTP_5XX' }]),
      journey: plan,
      paths,
    });
    expect(report.baselineVerification?.status).toBe('partial');
    expect(report.baselineVerification?.coverage).toBe('executed-steps-only');
  });

  it('states the limitations of the comparison', () => {
    const report = buildCandidateReport({
      baseline: partialBaseline(),
      execution: cleanExecution(),
      anomalies: anomalyReportWith([http500()]),
      reproduction: reproductionWith([{ anomalyId: 'anomaly-001', ruleId: 'HTTP_5XX' }]),
      journey: plan,
      paths,
    });
    const limitations = report.comparisonLimitations.join(' ');
    expect(limitations).toMatch(/partially verified/);
    expect(limitations).toMatch(/executed steps only/);
  });

  it('records no limitation when both sides are fully verified', () => {
    const report = buildCandidateReport({
      baseline: baselineOf({ identity: identityOf(cleanExecution(), plan), signals: [] }),
      execution: cleanExecution({
        verification: {
          status: 'complete',
          complete: true,
          executedSteps: 2,
          passedSteps: 2,
          failedSteps: 0,
          blockedSteps: 0,
          skippedSteps: 0,
          unverifiedAssertions: 0,
          unverifiedStepIds: [],
          coverage: 'full-plan',
        },
      }),
      anomalies: anomalyReportWith([http500()]),
      reproduction: reproductionWith([{ anomalyId: 'anomaly-001', ruleId: 'HTTP_5XX' }]),
      journey: plan,
      paths,
    });
    expect(report.comparisonLimitations.join(' ')).toMatch(/None/);
  });

  it('does not call a signal from an unverified step novel', () => {
    // Nobody established what that step was supposed to prove, so novelty is
    // unsupportable there.
    const report = buildCandidateReport({
      baseline: baselineOf({ identity: identityOf(cleanExecution(), plan), signals: [] }),
      execution: cleanExecution({
        verification: {
          status: 'partial',
          complete: false,
          executedSteps: 1,
          passedSteps: 1,
          failedSteps: 0,
          blockedSteps: 0,
          skippedSteps: 1,
          unverifiedAssertions: 1,
          unverifiedStepIds: ['anomaly-001'],
          coverage: 'executed-steps-only',
        },
      }),
      anomalies: anomalyReportWith([http500()]),
      reproduction: reproductionWith([{ anomalyId: 'anomaly-001', ruleId: 'HTTP_5XX' }]),
      journey: plan,
      paths,
    });
    const candidate = report.candidates.find((c) => c.ruleId === 'HTTP_5XX');
    expect(candidate?.classification).toBe('unknown');
    expect(candidate?.classification).not.toBe('novel');
    expect(candidate?.message).toMatch(/unverified/);
  });

  it('prints the limitations in the terminal summary', () => {
    const report = buildCandidateReport({
      baseline: partialBaseline(),
      execution: cleanExecution(),
      anomalies: anomalyReportWith([http500()]),
      reproduction: reproductionWith([{ anomalyId: 'anomaly-001', ruleId: 'HTTP_5XX' }]),
      journey: plan,
      paths,
    });
    expect(summarizeCandidateReport(report)).toMatch(/LIMITS OF THIS COMPARISON/);
  });

  it('still marks every candidate unconfirmed', () => {
    const report = buildCandidateReport({
      baseline: partialBaseline(),
      execution: cleanExecution(),
      anomalies: anomalyReportWith([http500()]),
      reproduction: reproductionWith([{ anomalyId: 'anomaly-001', ruleId: 'HTTP_5XX' }]),
      journey: plan,
      paths,
    });
    expect(report.candidates.every((c) => c.confirmed === false)).toBe(true);
    expect(report.interpretation.confirmedBug).toBe(false);
  });

  it('remains deterministic', () => {
    const build = () =>
      JSON.stringify(
        buildCandidateReport({
          baseline: partialBaseline(),
          execution: cleanExecution(),
          anomalies: anomalyReportWith([http500()]),
          reproduction: reproductionWith([{ anomalyId: 'anomaly-001', ruleId: 'HTTP_5XX' }]),
          journey: plan,
          paths,
        }),
        null,
        2,
      );
    const first = build();
    for (let i = 0; i < 3; i++) expect(build()).toBe(first);
  });
});

describe('legacy compatibility', () => {
  it('reviews a report with no verification metadata', () => {
    const plan = checkoutJourney();
    const report = buildCandidateReport({
      baseline: null,
      execution: legacyExecution(),
      anomalies: anomalyReportWith([http500()], null),
      reproduction: reproductionWith([{ anomalyId: 'anomaly-001', ruleId: 'HTTP_5XX' }]),
      journey: plan,
      paths: {
        execution: 'e',
        anomalies: 'a',
        reproduction: 'r',
        journey: 'j',
        baseline: null,
      },
    });
    // Nothing invented, and nothing called novel without a baseline.
    expect(report.baselineVerification).toBeNull();
    expect(report.candidates.every((c) => c.classification !== 'novel')).toBe(true);
  });

  it('produces a status for a legacy execution without throwing', () => {
    const legacy = { ...execution(), environment: null, verification: null };
    expect(() => buildVerification(legacy.steps as StepExecutionResult[], false)).not.toThrow();
  });
});

describe('no behaviour change for real failures', () => {
  it('still fails a run whose action failed', () => {
    expect(deriveExecutionStatus([result({ id: 's', order: 1, status: 'failed' })], false)).toBe('failed');
  });

  it('still blocks a run whose safety guard refused a step', () => {
    expect(deriveExecutionStatus([result({ id: 's', order: 1, status: 'blocked' })], false)).toBe('blocked');
  });

  it('still aborts a run interrupted by a real condition', () => {
    expect(deriveExecutionStatus([], true)).toBe('aborted');
  });
});
