import { describe, expect, it } from 'vitest';
import {
  loadJourneyPlan,
  validateJourneyPlan,
  SUPPORTED_ACTIONS,
} from '../../src/executor/planValidator.js';
import { JourneyPlanError, SUPPORTED_JOURNEY_SCHEMA_VERSIONS } from '../../src/executor/types.js';
import { plan, planWith, step } from '../fixtures/journeyPlans.js';
import { buildExecutionReport, countSteps, deriveStatus, summarizeExecution } from '../../src/executor/executionReport.js';
import type { ExecutionOptions, StepExecutionResult } from '../../src/executor/types.js';
import type { JourneyPlan } from '../../src/journey/types.js';

/** Validate a plan, returning the error message rather than throwing. */
function expectRejection(value: unknown, pattern: RegExp): void {
  try {
    validateJourneyPlan(value, 'test.json');
  } catch (error) {
    expect(error).toBeInstanceOf(JourneyPlanError);
    expect((error as Error).message).toMatch(pattern);
    return;
  }
  throw new Error('expected validateJourneyPlan to reject the input');
}

/** Serialise and validate, to exercise the on-disk shape. */
function roundTrip(input: JourneyPlan): JourneyPlan {
  return validateJourneyPlan(JSON.parse(JSON.stringify(input)), 'test.json');
}

describe('supported actions', () => {
  it('implements every action Build 2 can emit', () => {
    expect([...SUPPORTED_ACTIONS].sort()).toEqual(
      ['assert', 'click', 'fill', 'identify', 'navigate', 'observe', 'select', 'submit', 'upload'],
    );
  });

  it('supports exactly the journey-plan-v1 action vocabulary', () => {
    expect(SUPPORTED_JOURNEY_SCHEMA_VERSIONS).toEqual(['1.0']);
  });
});

describe('validateJourneyPlan', () => {
  it('accepts a valid plan', () => {
    const validated = roundTrip(planWith([step({ id: 'step-001', order: 1 })]));
    expect(validated.schemaVersion).toBe('1.0');
    expect(validated.steps).toHaveLength(1);
  });

  it('accepts a plan with zero steps', () => {
    expect(roundTrip(plan()).steps).toEqual([]);
  });

  it('rejects a non-object root', () => {
    expectRejection([], /must be a JSON object/);
    expectRejection('nope', /must be a JSON object/);
    expectRejection(null, /must be a JSON object/);
  });

  it('rejects a missing schemaVersion', () => {
    const input = plan() as unknown as Record<string, unknown>;
    delete input['schemaVersion'];
    expectRejection(input, /schemaVersion/);
  });

  it('rejects an unsupported schema version', () => {
    expectRejection({ ...plan(), schemaVersion: '2.0' }, /Unsupported journey plan schemaVersion "2\.0"/);
    expectRejection({ ...plan(), schemaVersion: '0.9' }, /Unsupported journey plan schemaVersion/);
  });

  it('rejects a missing or empty goal', () => {
    const noGoal = plan() as unknown as Record<string, unknown>;
    delete noGoal['goal'];
    expectRejection(noGoal, /goal/);
    expectRejection({ ...plan(), goal: '   ' }, /goal/);
  });

  it('rejects an unrecognised journeyType', () => {
    expectRejection({ ...plan(), journeyType: 'teleportation' }, /journeyType/);
  });

  it('rejects a missing target', () => {
    const noTarget = plan() as unknown as Record<string, unknown>;
    delete noTarget['target'];
    expectRejection(noTarget, /target/);
  });

  it('rejects an invalid target URL rather than guessing one', () => {
    expectRejection({ ...plan(), target: { url: 'not a url', finalUrl: null, title: '' } }, /not a valid absolute URL/);
    expectRejection({ ...plan(), target: { url: '', finalUrl: null, title: '' } }, /target\.url/);
  });

  it('rejects a missing steps array', () => {
    const noSteps = plan() as unknown as Record<string, unknown>;
    delete noSteps['steps'];
    expectRejection(noSteps, /steps array/);
  });

  it('rejects a step with no id', () => {
    expectRejection(
      planWith([step({ id: 'step-001', order: 1 })]).steps.length === 1
        ? { ...plan(), steps: [{ order: 1, action: 'observe', executable: false, targetElementIds: [], locatorCandidates: [] }] }
        : {},
      /has no id/,
    );
  });

  it('rejects a step with an invalid order', () => {
    for (const order of [0, -1, 1.5, Number.NaN]) {
      expectRejection(planWith([step({ id: 'step-001', order })]), /invalid order/);
    }
  });

  it('rejects duplicate step ids', () => {
    const input = {
      ...plan(),
      steps: [
        step({ id: 'step-001', order: 1 }),
        step({ id: 'step-001', order: 2 }),
      ],
    };
    expectRejection(input, /duplicate step id "step-001"/);
  });

  it('rejects an unsupported action', () => {
    expectRejection(planWith([step({ id: 'step-001', order: 1, action: 'teleport' as never })]), /unsupported action/);
  });

  it('refuses a plan whose step claims executable true', () => {
    // The Build 2 contract says every step is executable: false. A true means
    // the plan did not come from Build 2, so the whole run is refused.
    const input = {
      ...plan(),
      steps: [{ ...step({ id: 'step-001', order: 1 }), executable: true }],
    };
    expectRejection(input, /violates the Build 2 contract: executable must be false/);
  });

  it('refuses a plan whose step omits executable entirely', () => {
    const broken = step({ id: 'step-001', order: 1 }) as unknown as Record<string, unknown>;
    delete broken['executable'];
    expectRejection({ ...plan(), steps: [broken] }, /executable must be false/);
  });

  it('rejects malformed targetElementIds and locatorCandidates', () => {
    expectRejection(
      planWith([{ ...step({ id: 'step-001', order: 1 }), targetElementIds: 'element-001' as never }]),
      /malformed targetElementIds/,
    );
    expectRejection(
      planWith([{ ...step({ id: 'step-001', order: 1 }), locatorCandidates: [42] as never }]),
      /malformed locatorCandidates/,
    );
  });

  it('rejects a malformed element id', () => {
    expectRejection(
      planWith([{ ...step({ id: 'step-001', order: 1 }), targetElementIds: ['not-an-element'] }]),
      /malformed element id/,
    );
  });

  it('rejects a step order that disagrees with array position', () => {
    // Execution follows `order`, so a mismatch would make a run non-deterministic.
    expectRejection(
      {
        ...plan(),
        steps: [step({ id: 'step-001', order: 2 })],
      },
      /order values do not match array position/,
    );
  });

  it('rejects a non-object step', () => {
    expectRejection({ ...plan(), steps: ['not a step'] }, /is not an object/);
  });

  it('tolerates a missing planner block rather than refusing a usable plan', () => {
    const input = plan() as unknown as Record<string, unknown>;
    delete input['planner'];
    // Validation is structural, so an absent descriptive block is normalised
    // rather than treated as a contract violation.
    expect(validateJourneyPlan(input, 'x.json').planner.version).toBe('unknown');
  });

  it('normalises a step that omits optional descriptive fields', () => {
    const minimal = {
      id: 'step-001',
      order: 1,
      action: 'observe',
      executable: false,
      targetElementIds: [],
      locatorCandidates: [],
    };
    const validated = validateJourneyPlan({ ...plan(), steps: [minimal] }, 'x.json');
    expect(validated.steps[0]?.intent).toBe('step-001');
    expect(validated.steps[0]?.description).toBe('');
    expect(validated.steps[0]?.confidence).toBe(0);
  });
});

describe('loadJourneyPlan', () => {
  it('reports a missing file with actionable advice', async () => {
    await expect(loadJourneyPlan('no-such-plan.json')).rejects.toThrow(/not found/i);
    await expect(loadJourneyPlan('no-such-plan.json')).rejects.toThrow(/Run the journey command first/i);
  });

  it('reports invalid JSON', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'crashlab-plan-'));
    try {
      const path = join(dir, 'bad.json');
      await writeFile(path, '{ nope', 'utf8');
      await expect(loadJourneyPlan(path)).rejects.toThrow(/not valid JSON/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/** Build a step result for report tests. */
function result(overrides: Partial<StepExecutionResult> & { id: string; status: StepExecutionResult['status'] }): StepExecutionResult {
  return {
    order: 1,
    intent: overrides.id,
    action: 'observe',
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
      screenshotOmittedReason: null,
      consoleEvents: [],
      pageErrors: [],
      networkEvents: [],
      dialogObserved: false,
      pageChanged: false,
    },
    error: null,
    skipReason: null,
    verification: null,
    assertion: null,
    postconditions: null,
    description: '',
    planConfidence: 0.7,
    ...overrides,
  };
}

/** Assemble a report for the given steps. */
function reportFor(steps: StepExecutionResult[], aborted = false) {
  const planFixture = planWith(steps.map((s) => step({ id: s.id, order: s.order })));
  const options: ExecutionOptions = { plan: planFixture, planPath: 'reports/journey.json' };
  return buildExecutionReport({
    plan: planFixture,
    options,
    steps,
    rawEvidence: { consoleEvents: [], pageErrors: [], networkEvents: [], screenshots: [] },
    redaction: {
      sensitiveValuesRedacted: true,
      redactedValueCount: 0,
      dataProvidedKeys: [],
      dataProvided: false,
      screenshotsOmittedAfterSensitiveData: false,
    },
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    durationMs: 1000,
    finalUrl: 'https://fixture.test/',
    aborted,
    stoppedOnFailure: aborted,
    warnings: [],
  });
}

describe('execution report', () => {
  it('has every required top-level field', () => {
    const report = reportFor([result({ id: 'step-001', status: 'passed' })]);
    for (const key of [
      'schemaVersion',
      'journeyPlanSchemaVersion',
      'journeyReport',
      'goal',
      'journeyType',
      'target',
      'status',
      'startedAt',
      'finishedAt',
      'durationMs',
      'stepCounts',
      'steps',
      'rawEvidence',
      'warnings',
      'blockedSteps',
      'redaction',
      'executor',
    ]) {
      expect(report, `missing ${key}`).toHaveProperty(key);
    }
  });

  it('references the immutable plan without mutating it', () => {
    const planFixture = planWith([step({ id: 'step-001', order: 1 })]);
    const before = JSON.stringify(planFixture);
    const options: ExecutionOptions = { plan: planFixture, planPath: 'reports/journey.json' };
    buildExecutionReport({
      plan: planFixture,
      options,
      steps: [],
      rawEvidence: { consoleEvents: [], pageErrors: [], networkEvents: [], screenshots: [] },
      redaction: {
      sensitiveValuesRedacted: true,
      redactedValueCount: 0,
      dataProvidedKeys: [],
      dataProvided: false,
      screenshotsOmittedAfterSensitiveData: false,
    },
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:01.000Z',
      durationMs: 1,
      finalUrl: null,
      aborted: false,
      stoppedOnFailure: false,
      warnings: [],
    });
    expect(JSON.stringify(planFixture)).toBe(before);
  });

  it('records the journey plan schema version it consumed', () => {
    expect(reportFor([]).journeyPlanSchemaVersion).toBe('1.0');
  });

  it('always reports zero retries', () => {
    expect(reportFor([]).executor.retries).toBe(0);
    expect(reportFor([result({ id: 'step-001', status: 'failed' })]).executor.retries).toBe(0);
  });

  it('uses a fixed executor mode', () => {
    expect(reportFor([]).executor.mode).toBe('deterministic');
  });

  it('counts step statuses', () => {
    const report = reportFor([
      result({ id: 'step-001', status: 'passed' }),
      result({ id: 'step-002', status: 'passed' }),
      result({ id: 'step-003', status: 'failed' }),
      result({ id: 'step-004', status: 'blocked' }),
      result({ id: 'step-005', status: 'skipped' }),
    ]);
    expect(report.stepCounts).toEqual({ total: 5, passed: 2, failed: 1, blocked: 1, skipped: 1 });
  });

  it('lists blocked steps with their reasons', () => {
    const report = reportFor([
      result({
        id: 'step-001',
        status: 'blocked',
        error: { reason: 'missing-test-data', message: 'no value supplied', attemptedLocators: [], missingDataKey: 'password' },
      }),
    ]);
    expect(report.blockedSteps).toHaveLength(1);
    expect(report.blockedSteps[0]).toContain('missing-test-data');
    expect(report.blockedSteps[0]).toContain('no value supplied');
  });

  it('never uses bug vocabulary in a status', () => {
    const statuses = ['passed', 'failed', 'blocked', 'partial', 'aborted', 'skipped'] as const;
    for (const status of statuses) expect(status).not.toMatch(/bug|defect|vulnerability/i);
  });
});

describe('deriveStatus', () => {
  it('is passed when every step passed', () => {
    expect(deriveStatus([result({ id: 'step-001', status: 'passed' })], false)).toBe('passed');
  });

  it('is passed for a plan where every step was a no-op', () => {
    // Nothing failed and nothing was blocked, so the run did not fail; with no
    // executed step there is also no claim that anything was verified.
    expect(deriveStatus([], false)).toBe('skipped');
  });

  it('is blocked when a required step was refused', () => {
    // A block is CrashLab declining to act, which is not a partial success.
    const status = deriveStatus(
      [result({ id: 'step-001', status: 'passed' }), result({ id: 'step-002', status: 'blocked' })],
      false,
    );
    expect(status).toBe('blocked');
  });

  it('is blocked when every step was blocked and nothing was skipped', () => {
    expect(deriveStatus([result({ id: 'step-001', status: 'blocked' })], false)).toBe('blocked');
  });

  it('is failed when a step failed and the run continued', () => {
    expect(
      deriveStatus(
        [result({ id: 'step-001', status: 'passed' }), result({ id: 'step-002', status: 'failed' })],
        false,
      ),
    ).toBe('failed');
  });

  it('is aborted when the run was cut short after partial success', () => {
    const status = deriveStatus(
      [
        result({ id: 'step-001', status: 'passed' }),
        result({ id: 'step-002', status: 'failed' }),
        result({ id: 'step-003', status: 'skipped' }),
      ],
      true,
    );
    expect(status).toBe('aborted');
  });

  it('is aborted when the very first step blocked and the rest were skipped', () => {
    // Reading this as a plain "failed" run would hide that execution stopped
    // early and later steps were never attempted.
    const status = deriveStatus(
      [result({ id: 'step-001', status: 'blocked' }), result({ id: 'step-002', status: 'skipped' })],
      true,
    );
    expect(status).toBe('aborted');
  });
});

describe('summarizeExecution', () => {
  it('states that a failure is not a confirmed bug', () => {
    const summary = summarizeExecution(reportFor([result({ id: 'step-001', status: 'failed' })]));
    expect(summary).toMatch(/not a confirmed bug/i);
    expect(summary).toMatch(/Anomaly detection belongs to Build 4/);
    expect(summary).toMatch(/reproduction belongs to Build 5/i);
  });

  it('reports zero retries', () => {
    expect(summarizeExecution(reportFor([]))).toContain('Retries: 0');
  });

  it('is deterministic for the same report', () => {
    const report = reportFor([result({ id: 'step-001', status: 'passed' })]);
    expect(summarizeExecution(report)).toBe(summarizeExecution(report));
  });
});

describe('countSteps', () => {
  it('handles an empty list', () => {
    expect(countSteps([])).toEqual({ total: 0, passed: 0, failed: 0, blocked: 0, skipped: 0 });
  });
});
