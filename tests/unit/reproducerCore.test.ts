import { describe, expect, it } from 'vitest';
import { ineligibilityFor, partitionEligible, hasEligibleSignals } from '../../src/reproducer/eligibility.js';
import { matchingKeyFor, normalizeMessage, normalizeUrl, signalsMatch } from '../../src/reproducer/normalization.js';
import { classifyReproduction, formatRatio } from '../../src/reproducer/resultClassifier.js';
import { buildResults, summarizeResults } from '../../src/reproducer/reproductionReport.js';
import { attemptName, attemptPaths } from '../../src/reproducer/attemptRunner.js';
import { validateAttempts } from '../../src/reproducer/inputLoader.js';
import { REPRODUCTION_THRESHOLD } from '../../src/reproducer/types.js';
import type { ReproductionInput } from '../../src/reproducer/types.js';
import {
  attempt,
  anomalyReport,
  consoleErrorSignal,
  duplicateSignal,
  failedAttempt,
  http4xxSignal,
  http5xxSignal,
  missingTargetSignal,
  networkFailureSignal,
  pageErrorSignal,
  reproJourney,
  signal,
  timeoutSignal,
} from '../fixtures/reproductionFixtures.js';

/** Build a reproducer input around the given signals. */
function input(overrides: Partial<ReproductionInput> = {}): ReproductionInput {
  return {
    anomalies: anomalyReport([http5xxSignal()]),
    journey: reproJourney(),
    attempts: 3,
    authorized: true,
    anomalyPath: 'reports/anomalies.json',
    journeyPath: 'reports/journey.json',
    executionPath: 'reports/execution.json',
    includePossiblyExpected: false,
    outputDir: 'reports/reproduction',
    ...overrides,
  };
}

describe('attempt limits', () => {
  it('accepts the documented range', () => {
    for (const value of [1, 2, 3, 4, 5]) {
      expect(validateAttempts(value)).toBe(value);
    }
  });

  it('rejects zero and negative values rather than clamping', () => {
    expect(() => validateAttempts(0)).toThrow(/at least 1/);
    expect(() => validateAttempts(-1)).toThrow(/at least 1/);
  });

  it('rejects values above the maximum rather than clamping', () => {
    // A caller asking for 50 must find out, not silently run 5.
    expect(() => validateAttempts(6)).toThrow(/at most 5/);
    expect(() => validateAttempts(50)).toThrow(/at most 5/);
    expect(() => validateAttempts(500)).toThrow(/deliberately bounded/);
  });

  it('rejects a non-integer', () => {
    expect(() => validateAttempts(2.5)).toThrow(/whole number/);
    expect(() => validateAttempts(Number.NaN)).toThrow(/whole number/);
  });

  it('produces stable attempt directory names', () => {
    expect(attemptName(1)).toBe('attempt-001');
    expect(attemptName(2)).toBe('attempt-002');
    expect(attemptName(5)).toBe('attempt-005');
    // Never a random id, and stable across runs.
    expect(attemptName(3)).toBe(attemptName(3));
  });

  it('places per-attempt artifacts in a dedicated directory', () => {
    const paths = attemptPaths('reports/reproduction', 2);
    // Compared segment-wise so the assertion holds on Windows and POSIX.
    expect(paths.execution.split(/[\\/]/)).toEqual(['reports', 'reproduction', 'attempt-002', 'execution.json']);
    expect(paths.anomalies.split(/[\\/]/)).toEqual(['reports', 'reproduction', 'attempt-002', 'anomalies.json']);
  });
});

describe('eligibility', () => {
  it('accepts genuine failure signals', () => {
    const eligibleSignals = [
      http5xxSignal(),
      networkFailureSignal(),
      consoleErrorSignal(),
      pageErrorSignal(),
      timeoutSignal(),
      missingTargetSignal(),
    ];
    for (const candidate of eligibleSignals) {
      expect(ineligibilityFor(candidate, false), candidate.ruleId).toBeNull();
    }
  });

  it('excludes potentially-expected rules by default, with a reason', () => {
    for (const candidate of [http4xxSignal(), duplicateSignal()]) {
      const reason = ineligibilityFor(candidate, false);
      expect(reason, candidate.ruleId).not.toBeNull();
      expect(reason?.code).toBe('rule-excluded');
      expect(reason?.detail).toMatch(/excluded by default/);
    }
  });

  it('includes potentially-expected rules when asked', () => {
    expect(ineligibilityFor(http4xxSignal(), true)).toBeNull();
    expect(ineligibilityFor(duplicateSignal(), true)).toBeNull();
  });

  it('never reproduces a signal with no stable key', () => {
    const noKey = signal({ id: 'anomaly-009', ruleId: 'EXECUTION_ACTION_FAILED', stepId: null });
    const reason = ineligibilityFor(noKey, false);
    expect(reason?.code).toBe('no-stable-key');
  });

  it('never reproduces an informational signal, which is not a failure', () => {
    // Even with the rule included, an `info`-level signal is not a failure and
    // must not be spent browser attempts on.
    const info = signal({
      id: 'anomaly-010',
      ruleId: 'DUPLICATE_REQUEST',
      signalLevel: 'info',
      details: {
        method: 'GET',
        url: 'https://fixture.test/analytics',
        resourceType: 'xhr',
        duplicateKey: 'k',
      },
    });
    expect(ineligibilityFor(info, true)?.code).toBe('skipped-step');
  });

  it('partitions signals into eligible and ineligible', () => {
    const { eligible, ineligible } = partitionEligible(
      [http5xxSignal('anomaly-001'), http4xxSignal('anomaly-002'), duplicateSignal('anomaly-003')],
      false,
    );
    expect(eligible.map((s) => s.id)).toEqual(['anomaly-001']);
    expect(ineligible.map((entry) => entry.anomaly.id)).toEqual(['anomaly-002', 'anomaly-003']);
  });

  it('reports whether any signal is worth a browser attempt', () => {
    expect(hasEligibleSignals(input({ anomalies: anomalyReport([http5xxSignal()]) }))).toBe(true);
    expect(hasEligibleSignals(input({ anomalies: anomalyReport([http4xxSignal()]) }))).toBe(false);
    expect(hasEligibleSignals(input({ anomalies: anomalyReport([]) }))).toBe(false);
  });
});

describe('normalization', () => {
  it('replaces a varying port so two local runs compare equal', () => {
    expect(normalizeUrl('http://127.0.0.1:53211/shop')).toBe(normalizeUrl('http://127.0.0.1:61789/shop'));
  });

  it('replaces a dynamic id', () => {
    const a = normalizeUrl('https://fixture.test/order/550e8400-e29b-41d4-a716-446655440000');
    const b = normalizeUrl('https://fixture.test/order/6ba7b810-9dad-11d1-80b4-00c04fd430c8');
    expect(a).toBe(b);
  });

  it('keeps a meaningful path difference', () => {
    expect(normalizeUrl('https://fixture.test/a')).not.toBe(normalizeUrl('https://fixture.test/b'));
  });

  it('keeps a secret query value out of a normalized url', () => {
    expect(normalizeUrl('https://fixture.test/api?token=abcsecret')).not.toContain('abcsecret');
  });

  it('normalizes whitespace and case in a message', () => {
    expect(normalizeMessage('  Something   Failed  ')).toBe(normalizeMessage('something failed'));
  });

  it('replaces a timestamp in a message', () => {
    const a = normalizeMessage('failed at 2026-01-01T00:00:00.000Z');
    const b = normalizeMessage('failed at 2026-02-02T11:11:11.000Z');
    expect(a).toBe(b);
  });

  it('handles an empty or absent value', () => {
    expect(normalizeUrl(undefined)).toBe('');
    expect(normalizeMessage(null)).toBe('');
  });
});

describe('matching keys', () => {
  it('preserves a meaningful HTTP distinction', () => {
    const notFound = http5xxSignal('anomaly-001');
    const serverError = http5xxSignal('anomaly-002');
    notFound.details = { ...http5xxSignal('a').details, statusCode: 404 };
    serverError.details = { ...http5xxSignal('b').details, statusCode: 500 };
    // 404 and 500 must never match each other.
    expect(matchingKeyFor(notFound)).not.toBe(matchingKeyFor(serverError));
    expect(signalsMatch(notFound, serverError)).toBe(false);
  });

  it('preserves a method distinction', () => {
    const get = networkFailureSignal('a');
    const post = networkFailureSignal('b');
    post.details = { ...post.details, method: 'POST' };
    expect(signalsMatch(get, post)).toBe(false);
  });

  it('matches an identical HTTP 5xx across runs', () => {
    expect(signalsMatch(http5xxSignal('a'), http5xxSignal('b'))).toBe(true);
  });

  it('matches an identical page error across runs', () => {
    expect(signalsMatch(pageErrorSignal('a'), pageErrorSignal('b'))).toBe(true);
  });

  it('matches an identical console error across runs', () => {
    expect(signalsMatch(consoleErrorSignal('a'), consoleErrorSignal('b'))).toBe(true);
  });

  it('matches an identical network failure across runs', () => {
    expect(signalsMatch(networkFailureSignal('a'), networkFailureSignal('b'))).toBe(true);
  });

  it('matches an identical timeout across runs', () => {
    expect(signalsMatch(timeoutSignal('a'), timeoutSignal('b'))).toBe(true);
  });

  it('matches a UI-state signal only within the same step', () => {
    const otherStep = missingTargetSignal('b');
    otherStep.stepId = 'step-009';
    expect(signalsMatch(missingTargetSignal('a'), otherStep)).toBe(false);
  });

  it('matches a duplicate request on method, url and type', () => {
    expect(signalsMatch(duplicateSignal('a'), duplicateSignal('b'))).toBe(true);
  });

  it('never matches a console error against a page error', () => {
    expect(signalsMatch(consoleErrorSignal('a'), pageErrorSignal('b'))).toBe(false);
  });

  it('yields no key for a signal with no evidence', () => {
    expect(matchingKeyFor(signal({ id: 'anomaly-001', ruleId: 'HTTP_5XX' }))).toBeNull();
  });
});

describe('classification', () => {
  it('is reproduced when the signal recurs in every attempt', () => {
    const outcome = classifyReproduction(http5xxSignal(), [
      attempt(1, [http5xxSignal()]),
      attempt(2, [http5xxSignal()]),
      attempt(3, [http5xxSignal()]),
    ]);
    expect(outcome.classification).toBe('reproduced');
    expect(outcome.matchingAttempts).toBe(3);
    expect(outcome.completedAttempts).toBe(3);
  });

  it('is reproduced when it recurs in a majority of attempts', () => {
    const outcome = classifyReproduction(http5xxSignal(), [
      attempt(1, [http5xxSignal()]),
      attempt(2, []),
      attempt(3, [http5xxSignal()]),
    ]);
    expect(outcome.classification).toBe('reproduced');
    expect(outcome.matchingAttempts).toBe(REPRODUCTION_THRESHOLD);
  });

  it('is not-reproduced when the signal is absent everywhere', () => {
    const outcome = classifyReproduction(http5xxSignal(), [attempt(1), attempt(2), attempt(3)]);
    expect(outcome.classification).toBe('not-reproduced');
    expect(outcome.matchingAttempts).toBe(0);
  });

  it('is inconclusive when it occurs in only one of three', () => {
    // One hit out of three is a coincidence far more often than a fault.
    const outcome = classifyReproduction(http5xxSignal(), [
      attempt(1, [http5xxSignal()]),
      attempt(2),
      attempt(3),
    ]);
    expect(outcome.classification).toBe('inconclusive');
    expect(outcome.matchingAttempts).toBe(1);
  });

  it('is blocked when no attempt completed', () => {
    const outcome = classifyReproduction(http5xxSignal(), [failedAttempt(1), failedAttempt(2)]);
    expect(outcome.classification).toBe('blocked');
    expect(outcome.completedAttempts).toBe(0);
  });

  it('is blocked when no attempt ran at all', () => {
    const outcome = classifyReproduction(http5xxSignal(), []);
    expect(outcome.classification).toBe('blocked');
  });

  it('is inconclusive when the signal has no stable key', () => {
    const noKey = signal({ id: 'anomaly-001', ruleId: 'HTTP_5XX' });
    const outcome = classifyReproduction(noKey, [attempt(1), attempt(2), attempt(3)]);
    expect(outcome.classification).toBe('inconclusive');
  });

  it('never produces a confirmed result', () => {
    for (const attempts of [
      [attempt(1, [http5xxSignal()]), attempt(2, [http5xxSignal()])],
      [attempt(1), attempt(2)],
      [failedAttempt(1)],
    ]) {
      const outcome = classifyReproduction(http5xxSignal(), attempts);
      expect(['reproduced', 'not-reproduced', 'inconclusive', 'blocked']).toContain(outcome.classification);
    }
  });

  it('formats a ratio as a count, never a probability', () => {
    expect(formatRatio(2, 3)).toBe('2/3');
    expect(formatRatio(0, 3)).toBe('0/3');
    expect(formatRatio(0, 0)).toBe('0/0');
  });

  it('gives a factual reason with no claim of certainty', () => {
    const outcome = classifyReproduction(http5xxSignal(), [attempt(1, [http5xxSignal()]), attempt(2, [http5xxSignal()])]);
    expect(outcome.reason).toMatch(/occurred in/);
    expect(outcome.reason).not.toMatch(/proves|definite|defect|broken/i);
  });
});

describe('result building', () => {
  it('accounts for every signal, eligible or not', () => {
    const results = buildResults(
      input({ anomalies: anomalyReport([http5xxSignal('anomaly-001'), http4xxSignal('anomaly-002')]) }),
      [attempt(1, [http5xxSignal()]), attempt(2, [http5xxSignal()])],
    );
    expect(results).toHaveLength(2);
    expect(results.map((result) => result.classification).sort()).toEqual(['ineligible', 'reproduced']);
  });

  it('assigns stable sequential ids', () => {
    const results = buildResults(
      input({ anomalies: anomalyReport([http5xxSignal('a'), http5xxSignal('b')]) }),
      [attempt(1, [http5xxSignal()]), attempt(2, [http5xxSignal()])],
    );
    expect(results.map((result) => result.id)).toEqual(['reproduction-001', 'reproduction-002']);
  });

  it('orders ineligible results first, mirroring the input ordering', () => {
    const results = buildResults(
      input({ anomalies: anomalyReport([http4xxSignal('anomaly-001'), http5xxSignal('anomaly-002')]) }),
      [attempt(1, [http5xxSignal()]), attempt(2, [http5xxSignal()])],
    );
    expect(results[0]?.anomalyId).toBe('anomaly-001');
    expect(results[0]?.classification).toBe('ineligible');
    expect(results[1]?.anomalyId).toBe('anomaly-002');
  });

  it('marks every result confirmed: false', () => {
    const results = buildResults(
      input({ anomalies: anomalyReport([http5xxSignal(), http4xxSignal()]) }),
      [attempt(1, [http5xxSignal()]), attempt(2, [http5xxSignal()])],
    );
    expect(results.every((result) => result.confirmed === false)).toBe(true);
  });

  it('marks only a reproduced signal as requiring investigation', () => {
    const results = buildResults(
      input({ anomalies: anomalyReport([http5xxSignal('a'), pageErrorSignal('b')]) }),
      [attempt(1, [http5xxSignal()]), attempt(2, [http5xxSignal()])],
    );
    const reproduced = results.find((result) => result.anomalyId === 'a');
    const notReproduced = results.find((result) => result.anomalyId === 'b');
    expect(reproduced?.requiresInvestigation).toBe(true);
    expect(notReproduced?.requiresInvestigation).toBe(false);
  });

  it('links evidence to the attempt that matched', () => {
    const results = buildResults(input(), [attempt(1, [http5xxSignal()]), attempt(2, [http5xxSignal()])]);
    expect(results[0]?.evidence).toHaveLength(2);
    expect(results[0]?.evidence[0]?.attempt).toBe(1);
    expect(results[0]?.evidence[0]?.anomalyId).toBe('anomaly-001');
  });

  it('records a ratio, not a probability', () => {
    const results = buildResults(input(), [attempt(1, [http5xxSignal()]), attempt(2, [http5xxSignal()])]);
    expect(results[0]?.reproductionRatio).toBe('2/2');
  });

  it('produces a result for every signal when no attempt ran', () => {
    const results = buildResults(input({ anomalies: anomalyReport([http5xxSignal(), http4xxSignal()]) }), []);
    expect(results).toHaveLength(2);
    expect(results.every((result) => result.classification === 'blocked' || result.classification === 'ineligible')).toBe(true);
  });
});

describe('summary', () => {
  it('counts every classification', () => {
    const results = buildResults(
      input({ anomalies: anomalyReport([http5xxSignal('a'), pageErrorSignal('b'), http4xxSignal('c')]) }),
      [attempt(1, [http5xxSignal()]), attempt(2, [http5xxSignal()])],
    );
    const summary = summarizeResults(results);
    expect(summary.totalSignals).toBe(3);
    expect(summary.reproduced).toBe(1);
    expect(summary.ineligible).toBe(1);
    expect(summary.candidatesRequiringInvestigation).toBe(1);
  });

  it('handles an empty signal set', () => {
    const summary = summarizeResults([]);
    expect(summary.totalSignals).toBe(0);
    expect(summary.reproduced).toBe(0);
  });
});
