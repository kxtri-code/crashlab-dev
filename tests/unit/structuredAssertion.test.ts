import { describe, expect, it } from 'vitest';
import {
  ASSERTION_TYPES,
  isSafeExpectedText,
  isStablePath,
  normalizeOrigin,
  normalizePath,
  normalizeText,
  validateStructuredAssertion,
} from '../../src/journey/structuredAssertion.js';
import { validateJourneyPlan } from '../../src/executor/planValidator.js';
import { journey } from '../fixtures/executionReports.js';
import type { JourneyStep } from '../../src/journey/types.js';

/** A legacy journey step with no assertion field. */
function legacyStep(overrides: Partial<JourneyStep> = {}): Record<string, unknown> {
  return {
    id: 'step-001',
    order: 1,
    intent: 'define_login_success',
    action: 'assert',
    description: 'Define the expected successful outcome',
    targetElementIds: [],
    locatorCandidates: [],
    expectedOutcome: 'The user is successfully logged in',
    confidence: 0.5,
    executable: false,
    source: { report: 'reports/scout.json', elementIds: [] },
    ...overrides,
  };
}

describe('assertion type vocabulary', () => {
  it('declares exactly the six supported types', () => {
    expect([...ASSERTION_TYPES].sort()).toEqual([
      'element-enabled',
      'element-present',
      'element-visible',
      'text-contains',
      'url-origin',
      'url-path',
    ]);
  });
});

describe('normalizePath', () => {
  it('strips query, fragment and trailing slash', () => {
    expect(normalizePath('/cart/?ref=email#top')).toBe('/cart');
    expect(normalizePath('/cart/')).toBe('/cart');
  });

  it('roots a relative path', () => {
    expect(normalizePath('cart')).toBe('/cart');
    expect(normalizePath('')).toBe('/');
  });

  it('is idempotent', () => {
    const once = normalizePath('/checkout/step-2/?x=1');
    expect(normalizePath(once)).toBe(once);
  });
});

describe('normalizeOrigin', () => {
  it('keeps only the origin', () => {
    expect(normalizeOrigin('https://shop.test/cart?token=secret#x')).toBe('https://shop.test');
  });

  it('keeps a distinguishing port', () => {
    expect(normalizeOrigin('http://127.0.0.1:8080/a')).toBe('http://127.0.0.1:8080');
  });

  it('returns null for a file URL or garbage', () => {
    expect(normalizeOrigin('file:///C:/page.html')).toBeNull();
    expect(normalizeOrigin('not a url')).toBeNull();
    expect(normalizeOrigin('')).toBeNull();
  });
});

describe('normalizeText', () => {
  it('collapses whitespace deterministically', () => {
    expect(normalizeText('  Order   confirmed\n\tnow  ')).toBe('Order confirmed now');
  });
});

describe('isStablePath', () => {
  it('accepts declared routes', () => {
    for (const path of ['/cart', '/catalog', '/catalog/blue-widget', '/checkout/step-2', '/']) {
      expect(isStablePath(path), path).toBe(true);
    }
  });

  it('rejects a path carrying a generated id', () => {
    // Each shape a real app uses. A guard that misses one is worse than none.
    const generated = [
      '/orders/550e8400-e29b-41d4-a716-446655440000',
      '/orders/12345',
      '/orders/2026-01-15',
      '/a/0123456789abcdef0123',
      '/a/deadbeefcafe1234',
    ];
    for (const path of generated) {
      expect(isStablePath(path), path).toBe(false);
    }
  });

  it('does not reject a short word that merely looks numeric-ish', () => {
    expect(isStablePath('/v2')).toBe(true);
    expect(isStablePath('/top-10')).toBe(true);
  });
});

describe('isSafeExpectedText', () => {
  it('accepts short plain text', () => {
    expect(isSafeExpectedText('Order confirmed')).toBe(true);
    expect(isSafeExpectedText('  Cart is empty ')).toBe(true);
  });

  it('rejects empty text', () => {
    expect(isSafeExpectedText('')).toBe(false);
    expect(isSafeExpectedText('    ')).toBe(false);
  });

  it('rejects overlong prose nobody can check', () => {
    expect(isSafeExpectedText('x'.repeat(81))).toBe(false);
  });

  it('rejects secret-bearing text', () => {
    for (const text of ['password=hunter2', 'Your token is abc123', 'CVV 123', 'card number 4111', 'api_key: sk_live_1']) {
      expect(isSafeExpectedText(text), text).toBe(false);
    }
  });
});

describe('validateStructuredAssertion', () => {
  it('accepts each supported type', () => {
    const source = { kind: 'scout-element', elementId: 'element-001' } as const;
    for (const type of ['element-present', 'element-visible', 'element-enabled'] as const) {
      expect(validateStructuredAssertion({ type, source })?.type, type).toBe(type);
    }
    expect(validateStructuredAssertion({ type: 'text-contains', expectedText: 'Done', source })?.type).toBe('text-contains');
    expect(validateStructuredAssertion({ type: 'url-origin', expectedOrigin: 'https://a.test', source })?.type).toBe('url-origin');
    expect(validateStructuredAssertion({ type: 'url-path', expectedPath: '/cart', source })?.type).toBe('url-path');
  });

  it('requires a traceable source', () => {
    // An untraceable assertion is indistinguishable from an invented one.
    for (const value of [
      { type: 'url-path', expectedPath: '/cart' },
      { type: 'url-path', expectedPath: '/cart', source: {} },
      { type: 'url-path', expectedPath: '/cart', source: 'scout' },
      'nope',
      42,
      null,
      undefined,
      {},
    ]) {
      expect(validateStructuredAssertion(value), JSON.stringify(value)).toBeNull();
    }
  });

  it('rejects an unknown type', () => {
    expect(validateStructuredAssertion({ type: 'payment-succeeded', source: { kind: 'scout-element' } })).toBeNull();
  });

  it('rejects a url-path with a generated id', () => {
    expect(
      validateStructuredAssertion({
        type: 'url-path',
        expectedPath: '/orders/550e8400-e29b-41d4-a716-446655440000',
        source: { kind: 'scout-href' },
      }),
    ).toBeNull();
  });

  it('rejects an empty expected text', () => {
    expect(validateStructuredAssertion({ type: 'text-contains', expectedText: '   ', source: { kind: 'scout-visible-text' } })).toBeNull();
  });

  it('normalizes a validated url-path', () => {
    const a = validateStructuredAssertion({ type: 'url-path', expectedPath: '/cart/?x=1', source: { kind: 'scout-href' } });
    const b = validateStructuredAssertion({ type: 'url-path', expectedPath: '/cart', source: { kind: 'scout-href' } });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('normalizes text whitespace', () => {
    const parsed = validateStructuredAssertion({
      type: 'text-contains',
      expectedText: '  Order   confirmed ',
      source: { kind: 'scout-visible-text' },
    });
    expect(parsed && 'expectedText' in parsed ? parsed.expectedText : null).toBe('Order confirmed');
  });
});

describe('backward compatibility of the plan schema', () => {
  it('accepts a legacy step with no assertion field', () => {
    const validated = validateJourneyPlan({ ...journey(), steps: [legacyStep() as never] }, 'j.json');
    expect(validated.schemaVersion).toBe('1.0');
    expect(validated.steps[0]?.assertion).toBeUndefined();
    // Every legacy field survives unchanged.
    expect(validated.steps[0]?.expectedOutcome).toBe('The user is successfully logged in');
    expect(validated.steps[0]?.action).toBe('assert');
    expect(validated.steps[0]?.executable).toBe(false);
  });

  it('accepts a step carrying a valid structured assertion', () => {
    const validated = validateJourneyPlan(
      {
        ...journey(),
        steps: [
          legacyStep({
            assertion: {
              type: 'url-path',
              expectedPath: '/cart',
              match: 'exact',
              source: { kind: 'scout-href', elementId: 'element-008', field: 'href' },
            },
          }) as never,
        ],
      },
      'j.json',
    );
    expect(validated.steps[0]?.assertion).toEqual({
      type: 'url-path',
      expectedPath: '/cart',
      match: 'exact',
      source: { kind: 'scout-href', elementId: 'element-008', field: 'href' },
    });
  });

  it('drops an assertion it cannot vouch for', () => {
    // Dropped rather than carried: the executor then treats the step as prose,
    // which is the same safe outcome as never having an assertion.
    const validated = validateJourneyPlan(
      {
        ...journey(),
        steps: [
          legacyStep({
            assertion: {
              type: 'url-path',
              expectedPath: '/orders/550e8400-e29b-41d4-a716-446655440000',
              match: 'exact',
              source: { kind: 'scout-href' },
            },
          }) as never,
        ],
      },
      'j.json',
    );
    expect(validated.steps[0]?.assertion).toBeUndefined();
  });

  it('does not change schemaVersion when an assertion is present', () => {
    const validated = validateJourneyPlan(
      {
        ...journey(),
        steps: [
          legacyStep({
            assertion: { type: 'url-origin', expectedOrigin: 'https://a.test', match: 'exact', source: { kind: 'scout-href' } },
          }) as never,
        ],
      },
      'j.json',
    );
    // Adding an optional field is not a breaking contract change.
    expect(validated.schemaVersion).toBe('1.0');
  });

  it('still refuses a plan whose step claims executable true', () => {
    expect(() =>
      validateJourneyPlan(
        { ...journey(), steps: [legacyStep({ executable: true as never }) as never] },
        'j.json',
      ),
    ).toThrow(/executable must be false/);
  });
});
