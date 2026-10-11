/**
 * Build 6.5: operator-declared expectations for SPA/JS flows.
 *
 * Tests the validation, canonicalization, hashing, and evaluation of
 * operator-declared expectations. The trust model is separate from
 * Scout-observed evidence: only `source: "operator-declared"` is accepted,
 * and coverage is `operator-declared`, never `full-plan`.
 */

import { describe, expect, it } from 'vitest';
import {
  EXPECTATIONS_SCHEMA_VERSION,
  OPERATOR_DECLARED_SOURCE,
  REJECTED_SOURCES,
  EXPECTATION_BEARING_ACTIONS,
  URL_PATH_MATCH_MODES,
  URL_ORIGIN_MATCH_MODES,
  validateExpectationsFile,
  parseExpectationsFile,
  canonicalizeExpectations,
  hashExpectationsFile,
  evaluateExpectations,
  worstExpectationOutcome,
} from '../../src/executor/expectations.js';
import type { ExpectationsFile, OperatorExpectation, ExpectationOutcome } from '../../src/executor/expectations.js';
import { journeyHash } from '../../src/baseline/identity.js';
import { journey } from '../fixtures/executionReports.js';
import type { JourneyPlan, JourneyStep } from '../../src/journey/types.js';

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
  return {
    ...journey(),
    steps,
  };
}

/** A valid operator-declared expectation. */
function expectation(overrides: Partial<OperatorExpectation> = {}): OperatorExpectation {
  return {
    id: 'exp-001',
    afterStepId: 'step-1',
    type: 'url-path',
    expectedPath: '/success',
    match: 'exact',
    source: OPERATOR_DECLARED_SOURCE,
    reason: 'SPA success route',
    ...overrides,
  };
}

/** A valid expectations file bound to the given journey. */
function expectationsFile(j: JourneyPlan, expectations: OperatorExpectation[]): ExpectationsFile {
  return {
    schemaVersion: EXPECTATIONS_SCHEMA_VERSION,
    journeyPlanHash: journeyHash(j),
    expectations,
  };
}

describe('expectations schema and constants', () => {
  it('exports the expected schema version', () => {
    expect(EXPECTATIONS_SCHEMA_VERSION).toBe('1.0');
  });

  it('only accepts operator-declared as a source', () => {
    expect(OPERATOR_DECLARED_SOURCE).toBe('operator-declared');
  });

  it('lists rejected sources', () => {
    expect(REJECTED_SOURCES).toContain('scout-observed');
    expect(REJECTED_SOURCES).toContain('evidence-backed');
    expect(REJECTED_SOURCES).toContain('automatically-derived');
    expect(REJECTED_SOURCES).toContain('confirmed');
  });

  it('only allows click, submit, and navigate as expectation-bearing actions', () => {
    expect(EXPECTATION_BEARING_ACTIONS.has('click')).toBe(true);
    expect(EXPECTATION_BEARING_ACTIONS.has('submit')).toBe(true);
    expect(EXPECTATION_BEARING_ACTIONS.has('navigate')).toBe(true);
    expect(EXPECTATION_BEARING_ACTIONS.has('fill')).toBe(false);
    expect(EXPECTATION_BEARING_ACTIONS.has('observe')).toBe(false);
    expect(EXPECTATION_BEARING_ACTIONS.has('assert')).toBe(false);
  });

  it('supports exact and starts-with for url-path', () => {
    expect(URL_PATH_MATCH_MODES).toContain('exact');
    expect(URL_PATH_MATCH_MODES).toContain('starts-with');
  });

  it('supports only exact for url-origin', () => {
    expect(URL_ORIGIN_MATCH_MODES).toEqual(['exact']);
  });
});

describe('validateExpectationsFile', () => {
  it('accepts a valid expectations file', () => {
    const j = planWithSteps([planStep({ id: 'step-1', order: 1, action: 'click' })]);
    const file = expectationsFile(j, [expectation()]);
    const result = validateExpectationsFile(file, j);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects a non-object root', () => {
    const result = validateExpectationsFile(null, journey());
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('root must be a JSON object');
  });

  it('rejects an unsupported schema version', () => {
    const j = planWithSteps([planStep({ id: 'step-1', order: 1, action: 'click' })]);
    const file = { ...expectationsFile(j, [expectation()]), schemaVersion: '2.0' };
    const result = validateExpectationsFile(file, j);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('schemaVersion');
  });

  it('rejects a missing journeyPlanHash', () => {
    const j = planWithSteps([planStep({ id: 'step-1', order: 1, action: 'click' })]);
    const file = expectationsFile(j, [expectation()]);
    delete (file as unknown as Record<string, unknown>)['journeyPlanHash'];
    const result = validateExpectationsFile(file, j);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('journeyPlanHash');
  });

  it('rejects a journey plan hash mismatch', () => {
    const j = planWithSteps([planStep({ id: 'step-1', order: 1, action: 'click' })]);
    const file = expectationsFile(j, [expectation()]);
    file.journeyPlanHash = 'sha256:wrong';
    const result = validateExpectationsFile(file, j);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('hash mismatch');
  });

  it('rejects a missing expectations array', () => {
    const j = planWithSteps([planStep({ id: 'step-1', order: 1, action: 'click' })]);
    const file = expectationsFile(j, [expectation()]);
    delete (file as unknown as Record<string, unknown>)['expectations'];
    const result = validateExpectationsFile(file, j);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('expectations array');
  });

  it('rejects an empty expectations array', () => {
    const j = planWithSteps([planStep({ id: 'step-1', order: 1, action: 'click' })]);
    const file = expectationsFile(j, []);
    const result = validateExpectationsFile(file, j);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('empty');
  });

  it('rejects duplicate expectation ids', () => {
    const j = planWithSteps([planStep({ id: 'step-1', order: 1, action: 'click' })]);
    const file = expectationsFile(j, [expectation(), expectation({ id: 'exp-001' })]);
    const result = validateExpectationsFile(file, j);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Duplicate');
  });
});

describe('validateExpectationsFile: source validation', () => {
  it('rejects scout-observed source', () => {
    const j = planWithSteps([planStep({ id: 'step-1', order: 1, action: 'click' })]);
    const file = expectationsFile(j, [expectation({ source: 'scout-observed' as never })]);
    const result = validateExpectationsFile(file, j);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('scout-observed');
  });

  it('rejects evidence-backed source', () => {
    const j = planWithSteps([planStep({ id: 'step-1', order: 1, action: 'click' })]);
    const file = expectationsFile(j, [expectation({ source: 'evidence-backed' as never })]);
    const result = validateExpectationsFile(file, j);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('evidence-backed');
  });

  it('rejects automatically-derived source', () => {
    const j = planWithSteps([planStep({ id: 'step-1', order: 1, action: 'click' })]);
    const file = expectationsFile(j, [expectation({ source: 'automatically-derived' as never })]);
    const result = validateExpectationsFile(file, j);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('automatically-derived');
  });

  it('rejects confirmed source', () => {
    const j = planWithSteps([planStep({ id: 'step-1', order: 1, action: 'click' })]);
    const file = expectationsFile(j, [expectation({ source: 'confirmed' as never })]);
    const result = validateExpectationsFile(file, j);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('confirmed');
  });
});

describe('validateExpectationsFile: step reference validation', () => {
  it('rejects a reference to a non-existent step', () => {
    const j = planWithSteps([planStep({ id: 'step-1', order: 1, action: 'click' })]);
    const file = expectationsFile(j, [expectation({ afterStepId: 'step-99' })]);
    const result = validateExpectationsFile(file, j);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('does not exist');
  });

  it('rejects a reference to a fill step', () => {
    const j = planWithSteps([planStep({ id: 'step-1', order: 1, action: 'fill' })]);
    const file = expectationsFile(j, [expectation({ afterStepId: 'step-1' })]);
    const result = validateExpectationsFile(file, j);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('fill');
  });

  it('rejects a reference to an observe step', () => {
    const j = planWithSteps([planStep({ id: 'step-1', order: 1, action: 'observe' })]);
    const file = expectationsFile(j, [expectation({ afterStepId: 'step-1' })]);
    const result = validateExpectationsFile(file, j);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('observe');
  });

  it('accepts a reference to a click step', () => {
    const j = planWithSteps([planStep({ id: 'step-1', order: 1, action: 'click' })]);
    const file = expectationsFile(j, [expectation({ afterStepId: 'step-1' })]);
    const result = validateExpectationsFile(file, j);
    expect(result.valid).toBe(true);
  });

  it('accepts a reference to a submit step', () => {
    const j = planWithSteps([planStep({ id: 'step-1', order: 1, action: 'submit' })]);
    const file = expectationsFile(j, [expectation({ afterStepId: 'step-1' })]);
    const result = validateExpectationsFile(file, j);
    expect(result.valid).toBe(true);
  });

  it('accepts a reference to a navigate step', () => {
    const j = planWithSteps([planStep({ id: 'step-1', order: 1, action: 'navigate' })]);
    const file = expectationsFile(j, [expectation({ afterStepId: 'step-1' })]);
    const result = validateExpectationsFile(file, j);
    expect(result.valid).toBe(true);
  });
});

describe('validateExpectationsFile: type and value validation', () => {
  it('rejects an unsupported type', () => {
    const j = planWithSteps([planStep({ id: 'step-1', order: 1, action: 'click' })]);
    const file = expectationsFile(j, [expectation({ type: 'dom-state' as never })]);
    const result = validateExpectationsFile(file, j);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('unsupported type');
  });

  it('rejects a missing expectedPath for url-path', () => {
    const j = planWithSteps([planStep({ id: 'step-1', order: 1, action: 'click' })]);
    const exp = expectation();
    delete (exp as unknown as Record<string, unknown>)['expectedPath'];
    const file = expectationsFile(j, [exp]);
    const result = validateExpectationsFile(file, j);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('expectedPath');
  });

  it('rejects a missing expectedOrigin for url-origin', () => {
    const j = planWithSteps([planStep({ id: 'step-1', order: 1, action: 'click' })]);
    const exp = expectation({ type: 'url-origin', expectedOrigin: undefined });
    const file = expectationsFile(j, [exp]);
    const result = validateExpectationsFile(file, j);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('expectedOrigin');
  });

  it('rejects an invalid match for url-path', () => {
    const j = planWithSteps([planStep({ id: 'step-1', order: 1, action: 'click' })]);
    const file = expectationsFile(j, [expectation({ match: 'contains' as never })]);
    const result = validateExpectationsFile(file, j);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('match');
  });

  it('rejects a non-exact match for url-origin', () => {
    const j = planWithSteps([planStep({ id: 'step-1', order: 1, action: 'click' })]);
    const file = expectationsFile(j, [expectation({ type: 'url-origin', match: 'starts-with' as never })]);
    const result = validateExpectationsFile(file, j);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('exact');
  });
});

describe('validateExpectationsFile: security refusals', () => {
  it('rejects a UUID path', () => {
    const j = planWithSteps([planStep({ id: 'step-1', order: 1, action: 'click' })]);
    const file = expectationsFile(j, [expectation({ expectedPath: '/orders/550e8400-e29b-41d4-a716-446655440000' })]);
    const result = validateExpectationsFile(file, j);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('generated');
  });

  it('rejects a date-generated path', () => {
    const j = planWithSteps([planStep({ id: 'step-1', order: 1, action: 'click' })]);
    const file = expectationsFile(j, [expectation({ expectedPath: '/reports/2024-01-15' })]);
    const result = validateExpectationsFile(file, j);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('generated');
  });

  it('rejects a long random token path', () => {
    const j = planWithSteps([planStep({ id: 'step-1', order: 1, action: 'click' })]);
    const token = 'a'.repeat(40);
    const file = expectationsFile(j, [expectation({ expectedPath: `/route/${token}` })]);
    const result = validateExpectationsFile(file, j);
    expect(result.valid).toBe(false);
    // The path may be caught by either the secret pattern or the generated
    // pattern; both are valid refusals.
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects a secret-bearing path', () => {
    const j = planWithSteps([planStep({ id: 'step-1', order: 1, action: 'click' })]);
    const file = expectationsFile(j, [expectation({ expectedPath: '/api/token/abc123' })]);
    const result = validateExpectationsFile(file, j);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('secret');
  });

  it('rejects a password-bearing path', () => {
    const j = planWithSteps([planStep({ id: 'step-1', order: 1, action: 'click' })]);
    const file = expectationsFile(j, [expectation({ expectedPath: '/reset/password' })]);
    const result = validateExpectationsFile(file, j);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('secret');
  });

  it('rejects an unresolved template placeholder', () => {
    const j = planWithSteps([planStep({ id: 'step-1', order: 1, action: 'click' })]);
    // Use a path that survives normalizePath without URL-encoding the placeholder.
    const file = expectationsFile(j, [expectation({ expectedPath: '/orders/:orderId' })]);
    const result = validateExpectationsFile(file, j);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('placeholder'))).toBe(true);
  });

  it('rejects a payment-adjacent path', () => {
    const j = planWithSteps([planStep({ id: 'step-1', order: 1, action: 'click' })]);
    const file = expectationsFile(j, [expectation({ expectedPath: '/checkout/payment' })]);
    const result = validateExpectationsFile(file, j);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('payment');
  });

  it('rejects a cross-origin url-origin expectation', () => {
    const j = planWithSteps([planStep({ id: 'step-1', order: 1, action: 'click' })]);
    const file = expectationsFile(j, [expectation({ type: 'url-origin', expectedOrigin: 'https://evil.test' })]);
    const result = validateExpectationsFile(file, j);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('outside the authorized origin');
  });

  it('accepts a same-origin url-origin expectation', () => {
    const j = planWithSteps([planStep({ id: 'step-1', order: 1, action: 'click' })]);
    const file = expectationsFile(j, [expectation({ type: 'url-origin', expectedOrigin: 'https://fixture.test' })]);
    const result = validateExpectationsFile(file, j);
    expect(result.valid).toBe(true);
  });

  it('rejects a missing reason', () => {
    const j = planWithSteps([planStep({ id: 'step-1', order: 1, action: 'click' })]);
    const exp = expectation();
    delete (exp as unknown as Record<string, unknown>)['reason'];
    const file = expectationsFile(j, [exp]);
    const result = validateExpectationsFile(file, j);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('reason');
  });
});

describe('parseExpectationsFile', () => {
  it('parses and validates a valid JSON string', () => {
    const j = planWithSteps([planStep({ id: 'step-1', order: 1, action: 'click' })]);
    const file = expectationsFile(j, [expectation()]);
    const text = JSON.stringify(file);
    const parsed = parseExpectationsFile(text, j);
    expect(parsed.expectations).toHaveLength(1);
    expect(parsed.expectations[0]?.id).toBe('exp-001');
  });

  it('throws on invalid JSON', () => {
    expect(() => parseExpectationsFile('not json', journey())).toThrow('not valid JSON');
  });

  it('throws on validation failure', () => {
    const j = planWithSteps([planStep({ id: 'step-1', order: 1, action: 'click' })]);
    const file = expectationsFile(j, [expectation({ source: 'scout-observed' as never })]);
    const text = JSON.stringify(file);
    expect(() => parseExpectationsFile(text, j)).toThrow('invalid');
  });
});

describe('canonicalizeExpectations', () => {
  it('sorts by afterStepId', () => {
    const exps = [expectation({ id: 'exp-002', afterStepId: 'step-2' }), expectation({ id: 'exp-001', afterStepId: 'step-1' })];
    const sorted = canonicalizeExpectations(exps);
    expect(sorted[0]?.afterStepId).toBe('step-1');
    expect(sorted[1]?.afterStepId).toBe('step-2');
  });

  it('sorts by type within the same step', () => {
    const exps = [
      expectation({ id: 'exp-001', type: 'url-origin', expectedOrigin: 'https://fixture.test' }),
      expectation({ id: 'exp-002', type: 'url-path', expectedPath: '/success' }),
    ];
    const sorted = canonicalizeExpectations(exps);
    expect(sorted[0]?.type).toBe('url-origin');
    expect(sorted[1]?.type).toBe('url-path');
  });

  it('sorts by id as a tiebreaker', () => {
    const exps = [expectation({ id: 'exp-002' }), expectation({ id: 'exp-001' })];
    const sorted = canonicalizeExpectations(exps);
    expect(sorted[0]?.id).toBe('exp-001');
    expect(sorted[1]?.id).toBe('exp-002');
  });

  it('does not mutate the input array', () => {
    const exps = [expectation({ id: 'exp-002' }), expectation({ id: 'exp-001' })];
    const original = [...exps];
    canonicalizeExpectations(exps);
    expect(exps).toEqual(original);
  });
});

describe('hashExpectationsFile', () => {
  it('produces a sha256-prefixed hash', () => {
    const j = planWithSteps([planStep({ id: 'step-1', order: 1, action: 'click' })]);
    const file = expectationsFile(j, [expectation()]);
    const hash = hashExpectationsFile(file);
    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('is deterministic for identical content', () => {
    const j = planWithSteps([planStep({ id: 'step-1', order: 1, action: 'click' })]);
    const file1 = expectationsFile(j, [expectation()]);
    const file2 = expectationsFile(j, [expectation()]);
    expect(hashExpectationsFile(file1)).toBe(hashExpectationsFile(file2));
  });

  it('changes when expectations differ', () => {
    const j = planWithSteps([planStep({ id: 'step-1', order: 1, action: 'click' })]);
    const file1 = expectationsFile(j, [expectation()]);
    const file2 = expectationsFile(j, [expectation({ expectedPath: '/other' })]);
    expect(hashExpectationsFile(file1)).not.toBe(hashExpectationsFile(file2));
  });

  it('is order-independent due to canonicalization', () => {
    const j = planWithSteps([planStep({ id: 'step-1', order: 1, action: 'click' })]);
    const file1 = expectationsFile(j, [expectation({ id: 'exp-001' }), expectation({ id: 'exp-002', expectedPath: '/other' })]);
    const file2 = expectationsFile(j, [expectation({ id: 'exp-002', expectedPath: '/other' }), expectation({ id: 'exp-001' })]);
    expect(hashExpectationsFile(file1)).toBe(hashExpectationsFile(file2));
  });
});

describe('evaluateExpectations', () => {
  it('returns an empty array when no expectations are bound to the step', async () => {
    const j = planWithSteps([planStep({ id: 'step-1', order: 1, action: 'click' })]);
    const file = expectationsFile(j, [expectation({ afterStepId: 'step-2' })]);
    const page = { url: () => 'https://fixture.test/success' } as never;
    const results = await evaluateExpectations(page, file, 'step-1');
    expect(results).toEqual([]);
  });

  it('matches a url-path exact expectation', async () => {
    const j = planWithSteps([planStep({ id: 'step-1', order: 1, action: 'click' })]);
    const file = expectationsFile(j, [expectation({ expectedPath: '/success' })]);
    const page = { url: () => 'https://fixture.test/success' } as never;
    const results = await evaluateExpectations(page, file, 'step-1');
    expect(results).toHaveLength(1);
    expect(results[0]?.result).toBe('matched');
    expect(results[0]?.actualPath).toBe('/success');
  });

  it('does not match a url-path exact expectation when the path differs', async () => {
    const j = planWithSteps([planStep({ id: 'step-1', order: 1, action: 'click' })]);
    const file = expectationsFile(j, [expectation({ expectedPath: '/success' })]);
    const page = { url: () => 'https://fixture.test/failure' } as never;
    const results = await evaluateExpectations(page, file, 'step-1');
    expect(results[0]?.result).toBe('not-matched');
  });

  it('matches a url-path starts-with expectation', async () => {
    const j = planWithSteps([planStep({ id: 'step-1', order: 1, action: 'click' })]);
    const file = expectationsFile(j, [expectation({ expectedPath: '/dashboard', match: 'starts-with' })]);
    const page = { url: () => 'https://fixture.test/dashboard/settings' } as never;
    const results = await evaluateExpectations(page, file, 'step-1');
    expect(results[0]?.result).toBe('matched');
  });

  it('matches a url-origin expectation', async () => {
    const j = planWithSteps([planStep({ id: 'step-1', order: 1, action: 'click' })]);
    const file = expectationsFile(j, [expectation({ type: 'url-origin', expectedOrigin: 'https://fixture.test' })]);
    const page = { url: () => 'https://fixture.test/anything' } as never;
    const results = await evaluateExpectations(page, file, 'step-1');
    expect(results[0]?.result).toBe('matched');
    expect(results[0]?.actualOrigin).toBe('https://fixture.test');
  });

  it('does not match a url-origin expectation when the origin differs', async () => {
    const j = planWithSteps([planStep({ id: 'step-1', order: 1, action: 'click' })]);
    const file = expectationsFile(j, [expectation({ type: 'url-origin', expectedOrigin: 'https://fixture.test' })]);
    const page = { url: () => 'https://other.test/page' } as never;
    const results = await evaluateExpectations(page, file, 'step-1');
    expect(results[0]?.result).toBe('not-matched');
  });

  it('returns unevaluable when the page URL cannot be read', async () => {
    const j = planWithSteps([planStep({ id: 'step-1', order: 1, action: 'click' })]);
    const file = expectationsFile(j, [expectation()]);
    const page = { url: () => '' } as never;
    const results = await evaluateExpectations(page, file, 'step-1');
    expect(results[0]?.result).toBe('unevaluable');
    expect(results[0]?.reason).toBeDefined();
  });

  it('returns unevaluable for a chrome-error page', async () => {
    const j = planWithSteps([planStep({ id: 'step-1', order: 1, action: 'click' })]);
    const file = expectationsFile(j, [expectation()]);
    const page = { url: () => 'chrome-error://chromewebdata/' } as never;
    const results = await evaluateExpectations(page, file, 'step-1');
    expect(results[0]?.result).toBe('unevaluable');
  });
});

describe('worstExpectationOutcome', () => {
  it('returns null for an empty array', () => {
    expect(worstExpectationOutcome([])).toBeNull();
  });

  it('returns matched when all expectations matched', () => {
    const outcomes: ExpectationOutcome[] = [
      { expectationId: 'exp-001', afterStepId: 'step-1', type: 'url-path', result: 'matched' },
      { expectationId: 'exp-002', afterStepId: 'step-1', type: 'url-path', result: 'matched' },
    ];
    expect(worstExpectationOutcome(outcomes)).toBe('matched');
  });

  it('returns not-matched when any expectation did not match', () => {
    const outcomes: ExpectationOutcome[] = [
      { expectationId: 'exp-001', afterStepId: 'step-1', type: 'url-path', result: 'matched' },
      { expectationId: 'exp-002', afterStepId: 'step-1', type: 'url-path', result: 'not-matched' },
    ];
    expect(worstExpectationOutcome(outcomes)).toBe('not-matched');
  });

  it('returns unevaluable when any expectation is unevaluable and none not-matched', () => {
    const outcomes: ExpectationOutcome[] = [
      { expectationId: 'exp-001', afterStepId: 'step-1', type: 'url-path', result: 'matched' },
      { expectationId: 'exp-002', afterStepId: 'step-1', type: 'url-path', result: 'unevaluable', reason: 'no url' },
    ];
    expect(worstExpectationOutcome(outcomes)).toBe('unevaluable');
  });

  it('prioritizes not-matched over unevaluable', () => {
    const outcomes: ExpectationOutcome[] = [
      { expectationId: 'exp-001', afterStepId: 'step-1', type: 'url-path', result: 'unevaluable', reason: 'no url' },
      { expectationId: 'exp-002', afterStepId: 'step-1', type: 'url-path', result: 'not-matched' },
    ];
    expect(worstExpectationOutcome(outcomes)).toBe('not-matched');
  });
});
