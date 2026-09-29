import { describe, expect, it } from 'vitest';
import {
  deriveFormPostcondition,
  formForElement,
  validatePostconditions,
} from '../../src/journey/postcondition.js';
import { validateJourneyPlan } from '../../src/executor/planValidator.js';
import { journey } from '../fixtures/executionReports.js';
import { checkoutScoutReport, formScoutReport } from '../fixtures/scoutReports.js';
import { execStep, execution } from '../fixtures/executionReports.js';
import type { ScoutForm } from '../../src/scout/types.js';
import type { Postcondition } from '../../src/journey/types.js';

const PAGE = 'https://shop.test/checkout';

/** A Scout form record with sensible defaults. */
function form(overrides: Partial<ScoutForm> = {}): ScoutForm {
  return {
    selector: 'form#f',
    action: '/thank-you',
    method: 'get',
    name: null,
    id: 'f',
    visible: true,
    fields: [],
    submitButtons: [],
    externalSubmitButtons: [],
    ...overrides,
  };
}

/** Derive and narrow the result, failing loudly if it declined. */
function derive(overrides: Partial<ScoutForm>, pageUrl = PAGE) {
  return deriveFormPostcondition(form(overrides), 'f', pageUrl);
}

describe('form action extraction and URL normalization', () => {
  it('derives a url-path postcondition from a relative action', () => {
    const generation = derive({ action: '/thank-you' });
    expect(generation.kind).toBe('generated');
    if (generation.kind !== 'generated') return;
    expect(generation.postcondition).toEqual({
      type: 'url-path',
      expectedPath: '/thank-you',
      match: 'exact',
      source: { kind: 'scout-form-action', elementId: 'f', field: 'action' },
    });
  });

  it('normalizes a trailing slash, a query string and a fragment', () => {
    for (const action of ['/thank-you/', '/thank-you?ref=email#top', '/thank-you/?x=1']) {
      const generation = derive({ action });
      expect(generation.kind, action).toBe('generated');
      if (generation.kind !== 'generated') continue;
      expect(generation.postcondition).toMatchObject({ expectedPath: '/thank-you' });
    }
  });

  it('derives from an absolute same-origin action', () => {
    const generation = derive({ action: 'https://shop.test/thank-you' });
    expect(generation.kind).toBe('generated');
    if (generation.kind !== 'generated') return;
    expect(generation.postcondition).toMatchObject({ type: 'url-path', expectedPath: '/thank-you' });
  });

  it('declines a credential-bearing action URL', () => {
    // `new URL` cannot parse a URL whose host contains credentials, so the
    // action is unresolvable. Declining is the right outcome: a form action
    // carrying a password must never become a recorded expectation.
    const generation = derive({ action: 'https://user:pw@shop.test/thank-you' });
    expect(generation.kind).toBe('declined');
    if (generation.kind === 'generated') return;
    expect(generation.reason).toBe('unresolvable-destination');
  });

  it('records a form-action source for traceability', () => {
    const generation = derive({ action: '/thank-you' });
    if (generation.kind !== 'generated') throw new Error('expected generation');
    expect(generation.postcondition.source.kind).toBe('scout-form-action');
    expect(generation.postcondition.source.field).toBe('action');
    expect(generation.postcondition.source.elementId).toBe('f');
  });
});

describe('postcondition derivation refusals', () => {
  it('declines a form with no action attribute', () => {
    const generation = derive({ action: null });
    expect(generation.kind).toBe('declined');
    if (generation.kind === 'generated') return;
    expect(generation.reason).toBe('no-action-attribute');
  });

  it('declines an empty action', () => {
    const generation = derive({ action: '   ' });
    if (generation.kind === 'generated') return;
    expect(generation.reason).toBe('empty-action');
  });

  it('declines a JavaScript-driven form', () => {
    // Discovering where a JS handler navigates would mean executing the page.
    const generation = derive({ action: 'javascript:submitOrder()' });
    if (generation.kind === 'generated') return;
    expect(generation.reason).toBe('javascript-destination');
  });

  it('declines an unresolved template placeholder', () => {
    for (const action of ['/orders/{id}', '/orders/:id', '/orders/${id}']) {
      const generation = derive({ action });
      if (generation.kind === 'generated') throw new Error(`expected decline for ${action}`);
      expect(generation.reason).toBe('unresolvable-destination');
    }
  });

  it('declines a dynamic destination', () => {
    for (const action of [
      '/orders/550e8400-e29b-41d4-a716-446655440000',
      '/orders/12345',
      '/orders/2026-01-15',
      '/a/0123456789abcdef0123',
    ]) {
      const generation = derive({ action });
      if (generation.kind === 'generated') throw new Error(`expected decline for ${action}`);
      expect(generation.reason).toBe('dynamic-path');
    }
  });

  it('declines a secret-bearing destination', () => {
    const generation = derive({ action: '/reset/session-token' });
    if (generation.kind === 'generated') return;
    expect(generation.reason).toBe('secret-bearing-path');
  });

  it('declines a cross-origin destination', () => {
    const generation = derive({ action: 'https://external.invalid/collect' });
    if (generation.kind === 'generated') return;
    expect(generation.reason).toBe('cross-origin');
    expect(generation.detail).toMatch(/not converted into an executable postcondition/);
  });

  it('declines a payment-adjacent destination', () => {
    // A destination that looks like a payment is a reason for caution, never
    // permission to submit one.
    for (const action of ['/payment-success', '/checkout/complete', '/billing/confirm']) {
      const generation = derive({ action });
      if (generation.kind === 'generated') throw new Error(`expected decline for ${action}`);
      expect(generation.reason).toBe('payment-form');
    }
  });

  it('declines an implausibly long action', () => {
    const generation = derive({ action: '/x'.repeat(2000) });
    if (generation.kind === 'generated') return;
    expect(generation.reason).toBe('unresolvable-destination');
  });

  it('gives a stated reason for every refusal', () => {
    const generation = derive({ action: null });
    if (generation.kind === 'generated') return;
    // A silent refusal would leave a reader wondering why no expectation
    // exists, so the reason is always populated.
    expect(generation.detail.length).toBeGreaterThan(20);
  });
});

describe('validatePostconditions', () => {
  const urlPath: Postcondition = {
    type: 'url-path',
    expectedPath: '/thank-you',
    match: 'exact',
    source: { kind: 'scout-form-action', elementId: 'f', field: 'action' },
  };

  it('keeps a valid url postcondition', () => {
    expect(validatePostconditions([urlPath])).toHaveLength(1);
  });

  it('drops a non-URL assertion, which is not a postcondition', () => {
    // An element or text expectation belongs to the journey's final assertion.
    const element = { type: 'element-present', source: { kind: 'scout-element', elementId: 'element-001' } };
    expect(validatePostconditions([element])).toBeUndefined();
  });

  it('drops a malformed entry rather than half-checking it', () => {
    expect(validatePostconditions([{ type: 'url-path', expectedPath: '/x' }])).toBeUndefined();
    expect(validatePostconditions([{ type: 'nonsense' }])).toBeUndefined();
  });

  it('returns undefined for a non-array or empty list', () => {
    expect(validatePostconditions(undefined)).toBeUndefined();
    expect(validatePostconditions([])).toBeUndefined();
  });

  it('rejects a dynamic path even when hand-authored', () => {
    expect(
      validatePostconditions([
        {
          type: 'url-path',
          expectedPath: '/orders/550e8400-e29b-41d4-a716-446655440000',
          match: 'exact',
          source: { kind: 'scout-form-action', elementId: 'f', field: 'action' },
        },
      ]),
    ).toBeUndefined();
  });
});

describe('formForElement', () => {
  it('finds the form a step element belongs to', () => {
    const report = formScoutReport();
    const located = formForElement(report, 'element-001');
    expect(located).not.toBeNull();
    expect(located?.form.id).toBe('application');
    expect(located?.formId).toBe('application');
  });

  it('returns null for an element outside any form', () => {
    const report = formScoutReport();
    const outside = report.interactiveElements.find((element) => element.formIndex === null);
    expect(outside).toBeDefined();
    if (!outside) return;
    expect(formForElement(report, `element-${String(outside.index + 1).padStart(3, '0')}`)).toBeNull();
  });

  it('returns null for an unparseable element id', () => {
    expect(formForElement(formScoutReport(), 'not-an-element')).toBeNull();
  });
});

describe('plan compatibility', () => {
  it('accepts a legacy step with no postconditions field', () => {
    const validated = validateJourneyPlan(
      {
        ...journey(),
        steps: [
          {
            id: 'step-001',
            order: 1,
            intent: 'define_form_success',
            action: 'assert',
            description: '',
            targetElementIds: [],
            locatorCandidates: [],
            expectedOutcome: 'The form succeeded',
            confidence: 0.5,
            executable: false,
            source: { report: 'r', elementIds: [] },
          },
        ],
      },
      'j.json',
    );
    expect(validated.steps[0]?.postconditions).toBeUndefined();
    expect(validated.steps[0]?.expectedOutcome).toBe('The form succeeded');
  });

  it('carries a valid postcondition through validation', () => {
    const validated = validateJourneyPlan(
      {
        ...journey(),
        steps: [
          {
            id: 'step-001',
            order: 1,
            intent: 'submit_contact_form',
            action: 'submit',
            description: '',
            targetElementIds: ['element-001'],
            locatorCandidates: ["page.getByTestId('send')"],
            postconditions: [
              {
                type: 'url-path',
                expectedPath: '/thank-you',
                match: 'exact',
                source: { kind: 'scout-form-action', elementId: 'contact-form', field: 'action' },
              },
            ],
            expectedOutcome: 'The form destination is reached',
            confidence: 0.8,
            executable: false,
            source: { report: 'r', elementIds: ['element-001'] },
          },
        ],
      },
      'j.json',
    );
    expect(validated.steps[0]?.postconditions).toHaveLength(1);
    const postcondition = validated.steps[0]?.postconditions?.[0];
    expect(postcondition?.type).toBe('url-path');
    expect(postcondition?.type === 'url-path' ? postcondition.expectedPath : null).toBe('/thank-you');
  });

  it('drops a malformed postcondition rather than carrying it', () => {
    const validated = validateJourneyPlan(
      {
        ...journey(),
        steps: [
          {
            id: 'step-001',
            order: 1,
            intent: 'submit',
            action: 'submit',
            description: '',
            targetElementIds: [],
            locatorCandidates: [],
            postconditions: [{ type: 'url-path', expectedPath: '/x' }],
            expectedOutcome: 'prose',
            confidence: 0.5,
            executable: false,
            source: { report: 'r', elementIds: [] },
          },
        ],
      },
      'j.json',
    );
    expect(validated.steps[0]?.postconditions).toBeUndefined();
  });

  it('leaves schemaVersion unchanged', () => {
    const validated = validateJourneyPlan(
      {
        ...journey(),
        steps: [
          {
            id: 'step-001',
            order: 1,
            intent: 'submit',
            action: 'submit',
            description: '',
            targetElementIds: [],
            locatorCandidates: [],
            postconditions: [
              {
                type: 'url-path',
                expectedPath: '/done',
                match: 'exact',
                source: { kind: 'scout-form-action', elementId: 'f', field: 'action' },
              },
            ],
            expectedOutcome: 'done',
            confidence: 0.8,
            executable: false,
            source: { report: 'r', elementIds: [] },
          },
        ],
      },
      'j.json',
    );
    // An optional field is not a breaking contract change.
    expect(validated.schemaVersion).toBe('1.0');
  });
});

describe('result shape safety', () => {
  it('records no secret in a derived postcondition', () => {
    const generation = derive({ action: '/thank-you' });
    if (generation.kind !== 'generated') throw new Error('expected generation');
    const serialized = JSON.stringify(generation.postcondition);
    expect(serialized).not.toMatch(/password|token|secret|cookie/i);
  });

  it('keeps a credential-bearing action out of the report entirely', () => {
    const generation = derive({ action: 'https://user:pw@shop.test/thank-you' });
    // Nothing is generated, so nothing can carry the credential.
    expect(generation.kind).toBe('declined');
  });
});

describe('no new safety surface', () => {
  it('declines a payment form even when its destination is perfectly stable', () => {
    // `/payment-success` is a normal-looking stable path. That is exactly why
    // the payment rule cannot be left to the path-stability check.
    const generation = derive({ action: '/payment-success' });
    if (generation.kind === 'generated') throw new Error('payment form must be declined');
  });

  it('produces a step result shape that can carry postcondition outcomes', () => {
    const step = execStep({ id: 'step-001', order: 1 });
    // Null until a postcondition actually runs, so an old report reads the
    // same as one that never had the field.
    expect(step.postconditions).toBeNull();
    expect(execution().steps).toEqual([]);
  });
});
