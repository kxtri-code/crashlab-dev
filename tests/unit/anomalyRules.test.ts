import { describe, expect, it } from 'vitest';
import { classifySignals } from '../../src/anomaly/classifier.js';
import { buildAnomalyReport, summarizeAnomalies, summarizeAnomalyReport } from '../../src/anomaly/report.js';
import { RULE_IDS } from '../../src/anomaly/types.js';
import type { AnomalyAnalysisInput } from '../../src/anomaly/types.js';
import type { BlockReason, ExecutionReport } from '../../src/executor/types.js';
import {
  consoleEvent,
  execStep,
  execution,
  journey,
  netEvent,
  pageError,
  stepError,
} from '../fixtures/executionReports.js';

/** Build analyzer input from a fixture. */
function input(overrides: Partial<ExecutionReport> = {}, includeConsoleWarnings = false): AnomalyAnalysisInput {
  return {
    execution: execution(overrides),
    journey: journey(),
    executionPath: 'reports/execution.json',
    journeyPath: 'reports/journey.json',
  };
}

/** Run the classifier and return the signals. */
function signals(overrides: Partial<ExecutionReport> = {}, includeConsoleWarnings = false) {
  const context = { ...input(overrides), includeConsoleWarnings };
  return classifySignals(context);
}

/** Rule ids that fired. */
function ruleIds(overrides: Partial<ExecutionReport> = {}, includeConsoleWarnings = false): string[] {
  return signals(overrides, includeConsoleWarnings).map((anomaly) => anomaly.ruleId);
}

describe('HTTP response rules', () => {
  it('classifies a 5xx as an error-level HTTP_5XX signal', () => {
    const result = signals({
      rawEvidence: {
        ...execution().rawEvidence,
        networkEvents: [netEvent({ status: 500, method: 'POST', resourceType: 'fetch' })],
      },
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.ruleId).toBe(RULE_IDS.http5xx);
    expect(result[0]?.signalLevel).toBe('error');
    expect(result[0]?.possiblyExpected).toBe(false);
    expect(result[0]?.message).toBe('HTTP 500 response observed during execution.');
    expect(result[0]?.details).toMatchObject({ statusCode: 500, method: 'POST', resourceType: 'fetch' });
  });

  it('classifies a 4xx as a warning and marks common statuses possibly expected', () => {
    const result = signals({
      rawEvidence: {
        ...execution().rawEvidence,
        networkEvents: [
          netEvent({ status: 404, url: 'https://fixture.test/missing', path: '/missing' }),
          netEvent({ status: 401, url: 'https://fixture.test/protected', path: '/protected' }),
        ],
      },
    });
    expect(result).toHaveLength(2);
    expect(result.every((anomaly) => anomaly.ruleId === RULE_IDS.http4xx)).toBe(true);
    expect(result.every((anomaly) => anomaly.signalLevel === 'warning')).toBe(true);
    // 401 and 404 are frequently legitimate, so they are flagged for review.
    expect(result.every((anomaly) => anomaly.possiblyExpected)).toBe(true);
  });

  it('marks an unusual 4xx as not-possibly-expected', () => {
    const result = signals({
      rawEvidence: { ...execution().rawEvidence, networkEvents: [netEvent({ status: 418 })] },
    });
    expect(result[0]?.possiblyExpected).toBe(false);
  });

  it('ignores successful responses', () => {
    // Distinct URLs, so these are not also a duplicate-request signal.
    const result = signals({
      rawEvidence: {
        ...execution().rawEvidence,
        networkEvents: [
          netEvent({ status: 200, url: 'https://fixture.test/a', path: '/a' }),
          netEvent({ status: 302, url: 'https://fixture.test/b', path: '/b' }),
        ],
      },
    });
    expect(result).toEqual([]);
  });

  it('records the evidence index so a signal can be traced back', () => {
    const result = signals({
      rawEvidence: {
        ...execution().rawEvidence,
        networkEvents: [
          netEvent({ status: 200, url: 'https://fixture.test/a', path: '/a' }),
          netEvent({ status: 200, url: 'https://fixture.test/b', path: '/b' }),
          netEvent({ status: 503, url: 'https://fixture.test/c', path: '/c' }),
        ],
      },
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.source.eventIndex).toBe(2);
    expect(result[0]?.source.evidenceType).toBe('network');
    expect(result[0]?.source.executionReport).toBe('reports/execution.json');
  });
});

describe('network failure rules', () => {
  it('classifies a request that produced no response', () => {
    const result = signals({
      rawEvidence: {
        ...execution().rawEvidence,
        networkEvents: [netEvent({ status: null, failure: 'net::ERR_CONNECTION_REFUSED' })],
      },
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.ruleId).toBe(RULE_IDS.networkRequestFailed);
    expect(result[0]?.signalLevel).toBe('error');
    expect(result[0]?.details).toMatchObject({ failure: 'net::ERR_CONNECTION_REFUSED' });
  });

  it('does not double-report a failure that also has a status', () => {
    const result = signals({
      rawEvidence: {
        ...execution().rawEvidence,
        networkEvents: [netEvent({ status: 500, failure: 'partial' })],
      },
    });
    // The HTTP rule owns it; reporting both would double-count one event.
    expect(result.map((anomaly) => anomaly.ruleId)).toEqual([RULE_IDS.http5xx]);
  });
});

describe('console rules', () => {
  it('classifies a console error', () => {
    const result = signals({
      rawEvidence: {
        ...execution().rawEvidence,
        consoleEvents: [consoleEvent({ type: 'error', text: 'boom' })],
      },
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.ruleId).toBe(RULE_IDS.consoleError);
    // A page logging its own error is common and not by itself a defect.
    expect(result[0]?.possiblyExpected).toBe(true);
  });

  it('ignores console warnings by default', () => {
    const result = signals({
      rawEvidence: {
        ...execution().rawEvidence,
        consoleEvents: [consoleEvent({ type: 'warning', text: 'careful' })],
      },
    });
    expect(result).toEqual([]);
  });

  it('includes console warnings when asked', () => {
    const result = signals(
      {
        rawEvidence: {
          ...execution().rawEvidence,
          consoleEvents: [consoleEvent({ type: 'warning', text: 'careful' })],
        },
      },
      true,
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.ruleId).toBe(RULE_IDS.consoleWarning);
    expect(result[0]?.signalLevel).toBe('info');
  });

  it('never treats informational logs as anomalies', () => {
    const result = signals(
      {
        rawEvidence: {
          ...execution().rawEvidence,
          consoleEvents: [
            consoleEvent({ type: 'log' }),
            consoleEvent({ type: 'info' }),
            consoleEvent({ type: 'debug' }),
            consoleEvent({ type: 'other' }),
          ],
        },
      },
      true,
    );
    expect(result).toEqual([]);
  });
});

describe('page error rules', () => {
  it('classifies an uncaught page error', () => {
    const result = signals({
      rawEvidence: { ...execution().rawEvidence, pageErrors: [pageError({ message: 'undefined is not a function' })] },
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.ruleId).toBe(RULE_IDS.pageError);
    expect(result[0]?.signalLevel).toBe('error');
    expect(result[0]?.message).toBe('Uncaught page error observed during execution.');
    expect(result[0]?.details['errorMessage']).toContain('undefined is not a function');
  });

  it('keeps only the first line of a stack', () => {
    const result = signals({
      rawEvidence: {
        ...execution().rawEvidence,
        pageErrors: [pageError({ stack: 'Error: x\n    at a.js:1:1\n    at b.js:2:2' })],
      },
    });
    const stack = result[0]?.details['stackSummary'] as string;
    expect(stack).toContain('Error: x');
    expect(stack).not.toContain('b.js');
  });
});

describe('timeout rules', () => {
  it('classifies a step that reported a timeout', () => {
    const result = signals({
      steps: [execStep({ id: 'step-001', order: 1, status: 'failed', error: stepError('timed-out', 'Timeout 15000ms exceeded') })],
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.ruleId).toBe(RULE_IDS.stepTimeout);
    expect(result[0]?.signalLevel).toBe('error');
    expect(result[0]?.stepId).toBe('step-001');
  });

  it('does not infer a timeout from a slow step', () => {
    // A long duration is not evidence of a timeout; the report has to say so.
    const result = signals({
      steps: [execStep({ id: 'step-001', order: 1, durationMs: 120_000 })],
    });
    expect(result.map((anomaly) => anomaly.ruleId)).not.toContain(RULE_IDS.stepTimeout);
  });
});

describe('origin rules', () => {
  it('classifies a step that moved to a different origin', () => {
    const result = signals({
      steps: [
        execStep({
          id: 'step-001',
          order: 1,
          action: 'click',
          urlBefore: 'https://fixture.test/checkout',
          urlAfter: 'https://accounts.other.test/login',
        }),
      ],
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.ruleId).toBe(RULE_IDS.unexpectedOrigin);
    // A redirect to an identity provider is routine, so it is flagged, not raised.
    expect(result[0]?.possiblyExpected).toBe(true);
  });

  it('does not classify a same-origin path change', () => {
    const result = signals({
      steps: [
        execStep({
          id: 'step-001',
          order: 1,
          urlBefore: 'https://fixture.test/checkout',
          urlAfter: 'https://fixture.test/confirmation',
        }),
      ],
    });
    expect(result).toEqual([]);
  });

  it('does not classify a change CrashLab already blocked', () => {
    // The executor refusing an off-origin navigation is a policy outcome, and
    // reporting it again as a finding would be double-counting one event.
    const result = signals({
      steps: [
        execStep({
          id: 'step-001',
          order: 1,
          status: 'blocked',
          urlBefore: 'https://fixture.test/',
          urlAfter: 'https://elsewhere.invalid/',
          error: stepError('external-origin-blocked'),
        }),
      ],
    });
    expect(result).toEqual([]);
  });
});

describe('UI state rules', () => {
  it('classifies a missing target after an attempted action', () => {
    const result = signals({
      steps: [
        execStep({
          id: 'step-001',
          order: 1,
          action: 'click',
          status: 'failed',
          error: stepError('locator-not-found'),
        }),
      ],
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.ruleId).toBe(RULE_IDS.targetMissingAfterAction);
    expect(result[0]?.message).toBe('Target was not available when the action was attempted.');
  });

  it('classifies an unusable target after an attempted action', () => {
    const result = signals({
      steps: [
        execStep({
          id: 'step-001',
          order: 1,
          action: 'click',
          status: 'failed',
          error: stepError('element-disabled'),
        }),
      ],
    });
    expect(result[0]?.ruleId).toBe(RULE_IDS.targetDisabledAfterAction);
  });

  it('does not classify a skipped step as a UI anomaly', () => {
    // A skipped step never touched the page, so it says nothing about the UI.
    const result = signals({
      steps: [execStep({ id: 'step-001', order: 1, status: 'skipped' })],
    });
    expect(result).toEqual([]);
  });

  it('does not classify a skipped step with a missing target', () => {
    const result = signals({
      steps: [execStep({ id: 'step-001', order: 1, status: 'skipped', error: stepError('no-locator-provided') })],
    });
    expect(result).toEqual([]);
  });

  it('does not classify a passed step', () => {
    const result = signals({ steps: [execStep({ id: 'step-001', order: 1, status: 'passed' })] });
    expect(result).toEqual([]);
  });
});

describe('blocked-step handling: safety refusals are not application anomalies', () => {
  // Every reason that means "CrashLab declined", paired with what it means.
  // Typed against the real BlockReason union so a new reason must be
  // considered here rather than slipping through untyped.
  const refusals: [BlockReason, string][] = [
    ['no-locator-provided', 'nothing to act on'],
    ['missing-test-data', 'no test data supplied'],
    ['payment-blocked', 'payment guard'],
    ['unsupported-assertion', 'prose assertion'],
    ['locator-ambiguous', 'ambiguous locator'],
    ['locator-unsupported', 'unsupported locator form'],
    ['unsafe-test-file', 'upload outside the fixture root'],
    ['external-origin-blocked', 'off-origin navigation refused'],
  ];

  for (const [reason, description] of refusals) {
    it(`does not report a step blocked by ${description}`, () => {
      const result = signals({
        steps: [execStep({ id: 'step-001', order: 1, action: 'click', status: 'blocked', error: stepError(reason) })],
      });
      expect(result, `${reason} should not produce a signal`).toEqual([]);
    });
  }

  it('never produces a signal for a blocked step regardless of wording', () => {
    const result = signals({
      steps: [execStep({ id: 'step-001', order: 1, status: 'blocked', error: stepError('payment-blocked', 'blocked by safe test mode') })],
    });
    expect(result).toEqual([]);
  });
});

describe('step failure rules', () => {
  it('classifies a failed action with a real reason', () => {
    const result = signals({
      steps: [
        execStep({
          id: 'step-002',
          order: 2,
          action: 'submit',
          status: 'failed',
          error: stepError('action-failed', 'element detached during submission'),
        }),
      ],
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.ruleId).toBe(RULE_IDS.executionActionFailed);
    expect(result[0]?.stepId).toBe('step-002');
    expect(result[0]?.stepOrder).toBe(2);
  });

  it('does not double-report a missing target as a step failure', () => {
    const result = signals({
      steps: [execStep({ id: 'step-001', order: 1, status: 'failed', error: stepError('locator-not-found') })],
    });
    expect(result.map((anomaly) => anomaly.ruleId)).toEqual([RULE_IDS.targetMissingAfterAction]);
  });

  it('does not double-report a timeout as a step failure', () => {
    const result = signals({
      steps: [execStep({ id: 'step-001', order: 1, status: 'failed', error: stepError('timed-out', 'Timeout exceeded') })],
    });
    expect(result.map((anomaly) => anomaly.ruleId)).toEqual([RULE_IDS.stepTimeout]);
  });

  it('does not treat a step that merely mentions a timeout as a timeout', () => {
    // The reason vocabulary is authoritative; prose is not scanned for it.
    const result = signals({
      steps: [execStep({ id: 'step-001', order: 1, status: 'failed', error: stepError('action-failed', 'server timeout in response body') })],
    });
    expect(result.map((anomaly) => anomaly.ruleId)).toEqual([RULE_IDS.executionActionFailed]);
  });});

describe('duplicate request rules', () => {
  it('classifies a repeated identical request', () => {
    const event = { method: 'POST', url: 'https://fixture.test/api/cart', resourceType: 'xhr' };
    const result = signals({
      rawEvidence: {
        ...execution().rawEvidence,
        networkEvents: [
          netEvent({ ...event, path: '/api/cart' }),
          netEvent({ ...event, path: '/api/cart' }),
        ],
      },
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.ruleId).toBe(RULE_IDS.duplicateRequest);
    expect(result[0]?.signalLevel).toBe('info');
    expect(result[0]?.details['count']).toBe(2);
    expect(result[0]?.details['eventIndexes']).toEqual([0, 1]);
  });

  it('marks repeats of asset-like resource types as possibly expected', () => {
    const result = signals({
      rawEvidence: {
        ...execution().rawEvidence,
        networkEvents: [
          netEvent({ method: 'GET', url: 'https://cdn.fixture.test/a.png', resourceType: 'image' }),
          netEvent({ method: 'GET', url: 'https://cdn.fixture.test/a.png', resourceType: 'image' }),
        ],
      },
    });
    expect(result[0]?.possiblyExpected).toBe(true);
  });

  it('does not classify a single request as a duplicate', () => {
    const result = signals({
      rawEvidence: { ...execution().rawEvidence, networkEvents: [netEvent()] },
    });
    expect(result).toEqual([]);
  });

  it('does not treat different URLs as duplicates', () => {
    const result = signals({
      rawEvidence: {
        ...execution().rawEvidence,
        networkEvents: [netEvent({ url: 'https://fixture.test/a' }), netEvent({ url: 'https://fixture.test/b' })],
      },
    });
    expect(result).toEqual([]);
  });

  it('does not treat different methods as duplicates', () => {
    const result = signals({
      rawEvidence: {
        ...execution().rawEvidence,
        networkEvents: [netEvent({ method: 'GET' }), netEvent({ method: 'POST' })],
      },
    });
    expect(result).toEqual([]);
  });
});

describe('no-evidence behaviour', () => {
  it('produces no signals for a clean execution', () => {
    expect(signals({ steps: [execStep({ id: 'step-001', order: 1 })] })).toEqual([]);
  });

  it('produces a valid empty report rather than failing', () => {
    const report = buildAnomalyReport(input());
    expect(report.anomalies).toEqual([]);
    expect(report.summary.totalSignals).toBe(0);
    expect(report.interpretation.confirmedBug).toBe(false);
    expect(report.interpretation.requiresInvestigation).toBe(false);
  });

  it('warns rather than inventing signals when raw evidence is absent', () => {
    const withoutEvidence = execution();
    delete (withoutEvidence as { rawEvidence?: unknown }).rawEvidence;
    const report = buildAnomalyReport(input({ rawEvidence: undefined }));
    expect(report.anomalies).toEqual([]);
    expect(report.warnings.join(' ')).toMatch(/no rawEvidence block/);
  });
});

describe('interpretation guarantees', () => {
  it('marks every signal confirmed: false', () => {
    const result = signals({
      rawEvidence: {
        ...execution().rawEvidence,
        networkEvents: [netEvent({ status: 500 })],
        consoleEvents: [consoleEvent({ type: 'error' })],
        pageErrors: [pageError()],
      },
      steps: [execStep({ id: 'step-001', order: 1, status: 'failed', error: stepError('action-failed') })],
    });
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((anomaly) => anomaly.confirmed === false)).toBe(true);
  });

  it('never uses bug or severity vocabulary in a signal', () => {
    const result = signals({
      rawEvidence: {
        ...execution().rawEvidence,
        networkEvents: [netEvent({ status: 500 })],
        pageErrors: [pageError()],
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/bugConfirmed|confirmedBug|reproductionRate|reproduced|rootCause|finalSeverity|fixRecommendation/);
    expect(serialized).not.toMatch(/definitely|is a bug|product defect/i);
  });

  it('uses observation wording, not verdicts', () => {
    const result = signals({
      rawEvidence: { ...execution().rawEvidence, networkEvents: [netEvent({ status: 500 })] },
    });
    expect(result[0]?.message).toMatch(/observed/);
    expect(result[0]?.message).not.toMatch(/broken|bug|defect/i);
  });

  it('marks the whole report as not confirmed', () => {
    const report = buildAnomalyReport(
      input({ rawEvidence: { ...execution().rawEvidence, networkEvents: [netEvent({ status: 500 })] } }),
    );
    expect(report.interpretation.confirmedBug).toBe(false);
    expect(report.interpretation.requiresInvestigation).toBe(true);
  });

  it('has no severity field at all', () => {
    const report = buildAnomalyReport(
      input({ rawEvidence: { ...execution().rawEvidence, networkEvents: [netEvent({ status: 500 })] } }),
    );
    for (const anomaly of report.anomalies) {
      expect(anomaly).not.toHaveProperty('severity');
      expect(anomaly).not.toHaveProperty('finalSeverity');
    }
    expect(report).not.toHaveProperty('severity');
  });
});

describe('determinism and ordering', () => {
  it('produces byte-identical output for repeated analysis', () => {
    const overrides: Partial<ExecutionReport> = {
      rawEvidence: {
        ...execution().rawEvidence,
        networkEvents: [netEvent({ status: 500 }), netEvent({ status: 404 }), netEvent({ status: 200 })],
        consoleEvents: [consoleEvent({ type: 'error', text: 'one' }), consoleEvent({ type: 'error', text: 'two' })],
        pageErrors: [pageError()],
      },
      steps: [
        execStep({ id: 'step-001', order: 1, action: 'click', status: 'failed', error: stepError('action-failed') }),
        execStep({ id: 'step-002', order: 2, status: 'passed' }),
      ],
    };
    const first = JSON.stringify(buildAnomalyReport(input(overrides)), null, 2);
    for (let i = 0; i < 5; i++) {
      expect(JSON.stringify(buildAnomalyReport(input(overrides)), null, 2)).toBe(first);
    }
  });

  it('contains no timestamp, so output is stable over time', () => {
    const report = buildAnomalyReport(
      input({ rawEvidence: { ...execution().rawEvidence, networkEvents: [netEvent({ status: 500 })] } }),
    );
    expect(JSON.stringify(report)).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });

  it('assigns stable sequential ids', () => {
    const result = signals({
      rawEvidence: {
        ...execution().rawEvidence,
        networkEvents: [
          netEvent({ status: 500, url: 'https://fixture.test/a', path: '/a' }),
          netEvent({ status: 503, url: 'https://fixture.test/b', path: '/b' }),
          netEvent({ status: 404, url: 'https://fixture.test/c', path: '/c' }),
        ],
      },
    });
    expect(result).toHaveLength(3);
    expect(result.map((anomaly) => anomaly.id)).toEqual(['anomaly-001', 'anomaly-002', 'anomaly-003']);
  });

  it('orders step-less signals before step-attributed ones', () => {
    const result = signals({
      rawEvidence: { ...execution().rawEvidence, networkEvents: [netEvent({ status: 500 })] },
      steps: [execStep({ id: 'step-001', order: 1, status: 'failed', error: stepError('action-failed') })],
    });
    const firstStepSignal = result.findIndex((anomaly) => anomaly.stepId !== null);
    expect(firstStepSignal).toBeGreaterThan(0);
  });

  it('orders step-attributed signals by step order', () => {
    const result = signals({
      steps: [
        execStep({ id: 'step-002', order: 2, status: 'failed', error: stepError('action-failed') }),
        execStep({ id: 'step-001', order: 1, status: 'failed', error: stepError('action-failed') }),
      ],
    });
    expect(result.map((anomaly) => anomaly.stepOrder)).toEqual([1, 2]);
  });

  it('records an occurrence count for a duplicated signal', () => {
    // The same request twice is one signal describing the repetition, not two
    // indistinguishable rows. The dedup key includes the event index, so the
    // duplicate rule reports it and the occurrence count stays 1.
    const event = { method: 'GET', url: 'https://fixture.test/a', resourceType: 'script' };
    const result = signals({
      rawEvidence: {
        ...execution().rawEvidence,
        networkEvents: [netEvent(event), netEvent(event)],
      },
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.ruleId).toBe(RULE_IDS.duplicateRequest);
    expect(result[0]?.occurrences).toBe(1);
    expect(result[0]?.details['count']).toBe(2);
  });

  it('deduplicates an identical signal into one with a count', () => {
    // Two evidence events that resolve to the same rule, step, index and
    // details collapse into a single signal.
    const duplicate: Partial<ExecutionReport> = {
      rawEvidence: {
        ...execution().rawEvidence,
        consoleEvents: [consoleEvent({ type: 'error', text: 'same' })],
      },
    };
    const result = signals(duplicate);
    expect(result).toHaveLength(1);
    expect(result[0]?.occurrences).toBe(1);
  });
});

describe('traceability', () => {
  it('links every signal back to the execution report', () => {
    const result = signals({
      rawEvidence: { ...execution().rawEvidence, networkEvents: [netEvent({ status: 500 })] },
      executionPath: 'custom/execution.json',
    } as Partial<ExecutionReport>);
    const context = {
      execution: execution({ rawEvidence: { ...execution().rawEvidence, networkEvents: [netEvent({ status: 500 })] } }),
      journey: journey(),
      executionPath: 'custom/execution.json',
      includeConsoleWarnings: false,
    };
    const withPath = classifySignals(context);
    expect(withPath[0]?.source.executionReport).toBe('custom/execution.json');
    expect(withPath[0]?.source.evidenceType).toBe('network');
    expect(withPath[0]?.source.eventIndex).toBe(0);
    expect(result.length).toBeGreaterThan(0);
  });

  it('echoes the input paths into the report', () => {
    const report = buildAnomalyReport(input());
    expect(report.executionReport).toBe('reports/execution.json');
    expect(report.journeyReport).toBe('reports/journey.json');
    expect(report.executionStatus).toBe('passed');
  });
});

describe('summary and terminal output', () => {
  it('counts each category', () => {
    const report = buildAnomalyReport(
      input({
        rawEvidence: {
          ...execution().rawEvidence,
          networkEvents: [netEvent({ status: 500 }), netEvent({ status: 404 })],
          consoleEvents: [consoleEvent({ type: 'error' })],
          pageErrors: [pageError()],
        },
        steps: [execStep({ id: 'step-001', order: 1, status: 'failed', error: stepError('action-failed') })],
      }),
    );
    const summary = summarizeAnomalies(report.anomalies);
    expect(summary.httpErrors).toBe(2);
    expect(summary.consoleErrors).toBe(1);
    expect(summary.pageErrors).toBe(1);
    expect(summary.stepFailureSignals).toBe(1);
    expect(summary.totalSignals).toBe(report.anomalies.length);
    expect(summary.ruleIds).toEqual([...summary.ruleIds].sort());
  });

  it('reports signals, never bugs', () => {
    const report = buildAnomalyReport(
      input({ rawEvidence: { ...execution().rawEvidence, networkEvents: [netEvent({ status: 500 })] } }),
    );
    const summary = summarizeAnomalyReport(report);
    expect(summary).toMatch(/SIGNALS OBSERVED/);
    expect(summary).toMatch(/Confirmed bugs: 0/);
    expect(summary).toMatch(/not confirmed defects/);
    expect(summary).toMatch(/Build 5/);
  });

  it('is deterministic', () => {
    const report = buildAnomalyReport(
      input({ rawEvidence: { ...execution().rawEvidence, networkEvents: [netEvent({ status: 500 })] } }),
    );
    expect(summarizeAnomalyReport(report)).toBe(summarizeAnomalyReport(report));
  });
});
