import { describe, expect, it } from 'vitest';
import {
  coversExpectedOutcome,
  describePostconditionOutcome,
  isGenericPlaceholderAssertion,
  planAssertionCleanup,
  rewordExpectedOutcome,
} from '../../src/journey/assertionCleanup.js';
import type { JourneyStep, Postcondition } from '../../src/journey/types.js';

/** A journey step with planner defaults. */
function step(overrides: Partial<JourneyStep> & { id: string; order: number }): JourneyStep {
  return {
    intent: overrides.id,
    action: 'observe',
    description: '',
    targetElementIds: [],
    locatorCandidates: [],
    expectedOutcome: '',
    confidence: 0.7,
    executable: false,
    source: { report: 'r', elementIds: [] },
    ...overrides,
  };
}

/** The planner's own unevaluable terminal placeholder. */
function placeholder(id = 'step-005', order = 5): JourneyStep {
  return step({
    id,
    order,
    intent: 'define_form_success',
    action: 'assert',
    description: 'Define the expected successful outcome',
    expectedOutcome: 'The expected confirmation text or state was not found in the Scout report and must be observed at execution time.',
  });
}

/** A submit step carrying a url-path postcondition. */
function submitWithPostcondition(postcondition: Postcondition | null = urlPath('/thank-you')): JourneyStep {
  return step({
    id: 'step-004',
    order: 4,
    intent: 'identify_submit_control',
    action: 'submit',
    description: 'Submit the contact form',
    ...(postcondition ? { postconditions: [postcondition] } : {}),
    expectedOutcome: 'Submit the form',
  });
}

/** A url-path postcondition read from a form's declared action. */
function urlPath(path: string): Postcondition {
  return {
    type: 'url-path',
    expectedPath: path,
    match: 'exact',
    source: { kind: 'scout-form-action', elementId: 'contact-form', field: 'action' },
  };
}

function urlOrigin(origin: string): Postcondition {
  return {
    type: 'url-origin',
    expectedOrigin: origin,
    match: 'exact',
    source: { kind: 'scout-form-action', elementId: 'contact-form', field: 'action' },
  };
}

describe('generic placeholder detection', () => {
  it('recognises the planner terminal placeholder', () => {
    expect(isGenericPlaceholderAssertion(placeholder())).toBe(true);
  });

  it('recognises every planner terminal intent', () => {
    for (const intent of [
      'define_login_success',
      'define_registration_success',
      'define_purchase_confirmation',
      'define_form_success',
      'define_search_results',
      'define_contact_success',
      'define_upload_success',
      'define_navigation_destination',
    ]) {
      const candidate = step({
        id: 'step-009',
        order: 9,
        intent,
        action: 'assert',
        description: 'Define the expected successful outcome',
        expectedOutcome: 'The expected confirmation text or state was not found in the Scout report and must be observed at execution time.',
      });
      expect(isGenericPlaceholderAssertion(candidate), intent).toBe(true);
    }
  });

  it('is not a non-assert step', () => {
    expect(isGenericPlaceholderAssertion(step({ id: 's', order: 1, action: 'click', intent: 'define_form_success' }))).toBe(false);
  });

  it('is not a step carrying a structured assertion', () => {
    const withAssertion = step({
      id: 's',
      order: 1,
      intent: 'define_form_success',
      action: 'assert',
      description: 'Define the expected successful outcome',
      expectedOutcome: 'not found in the Scout report',
      assertion: urlPath('/cart'),
    });
    expect(isGenericPlaceholderAssertion(withAssertion)).toBe(false);
  });

  it('is not a step with a target element', () => {
    const withTarget = placeholder();
    withTarget.targetElementIds = ['element-001'];
    expect(isGenericPlaceholderAssertion(withTarget)).toBe(false);
  });

  it('is not a step with a usable locator', () => {
    const withLocator = placeholder();
    withLocator.locatorCandidates = ['#c'];
    expect(isGenericPlaceholderAssertion(withLocator)).toBe(false);
  });

  it('is not a hand-authored assertion with a concrete expectation', () => {
    // The false positive that matters: a user-supplied expectation must never
    // be mistaken for a planner placeholder, however vague it sounds.
    const authored = step({
      id: 'step-002',
      order: 2,
      intent: 'confirm_order_accepted',
      action: 'assert',
      description: 'Check the order state',
      expectedOutcome: 'The confirmation message says the request was received.',
    });
    expect(isGenericPlaceholderAssertion(authored)).toBe(false);
  });

  it('is not a planner-intent step with concrete prose', () => {
    // Same intent, but the prose states something specific. Deleting this
    // would discard a real requirement.
    const concrete = step({
      id: 'step-005',
      order: 5,
      intent: 'define_form_success',
      action: 'assert',
      description: 'Confirm the total matches',
      expectedOutcome: 'The order total is exactly 42.00 USD.',
    });
    expect(isGenericPlaceholderAssertion(concrete)).toBe(false);
  });
});

describe('postcondition coverage', () => {
  it('covers a generic terminal expectation for a url-path postcondition', () => {
    expect(coversExpectedOutcome(urlPath('/thank-you'))).toBe(true);
  });

  it('covers it for a url-origin postcondition', () => {
    expect(coversExpectedOutcome(urlOrigin('https://fixture.test'))).toBe(true);
  });

  it('does not cover an empty expectation', () => {
    expect(coversExpectedOutcome(urlPath(''))).toBe(false);
  });

  it('describes a path postcondition without a business claim', () => {
    const described = describePostconditionOutcome(urlPath('/thank-you'));
    expect(described).toContain('/thank-you');
    // Navigation is not business success.
    expect(described).not.toMatch(/paid|order completed|email|transaction/i);
  });

  it('describes an origin postcondition without a business claim', () => {
    const described = describePostconditionOutcome(urlOrigin('https://fixture.test'));
    expect(described).toContain('https://fixture.test');
    expect(described).not.toMatch(/paid|succeeded|created/i);
  });
});

describe('assertion cleanup', () => {
  it('removes a placeholder an earlier postcondition covers', () => {
    const { remove } = planAssertionCleanup([submitWithPostcondition(), placeholder()]);
    expect(remove).toEqual(['step-005']);
  });

  it('retains the placeholder when the action has no postcondition', () => {
    const { remove, retained } = planAssertionCleanup([submitWithPostcondition(null), placeholder()]);
    expect(remove).toEqual([]);
    expect(retained).toHaveLength(1);
    expect(retained[0]?.stepId).toBe('step-005');
  });

  it('retains the placeholder when the postcondition is not evaluable', () => {
    const { remove } = planAssertionCleanup([submitWithPostcondition(urlPath('')), placeholder()]);
    expect(remove).toEqual([]);
  });

  it('removes it for a url-origin postcondition too', () => {
    const { remove } = planAssertionCleanup([submitWithPostcondition(urlOrigin('https://fixture.test')), placeholder()]);
    expect(remove).toEqual(['step-005']);
  });

  it('removes it for a link click with a postcondition', () => {
    const click = step({
      id: 'step-003',
      order: 3,
      action: 'click',
      intent: 'identify_checkout_control',
      postconditions: [urlPath('/cart')],
    });
    const { remove } = planAssertionCleanup([click, placeholder()]);
    expect(remove).toEqual(['step-005']);
  });

  it('never removes a placeholder that a later action could cover', () => {
    // Looking forward would let a step justify deleting an assertion that runs
    // before it.
    const submit = submitWithPostcondition();
    const { remove } = planAssertionCleanup([placeholder(), submit]);
    expect(remove).toEqual([]);
  });

  it('leaves a meaningful assertion alone', () => {
    const meaningful = step({
      id: 'step-006',
      order: 6,
      intent: 'confirm_message',
      action: 'assert',
      description: 'Confirm the message',
      // A real requirement the URL postcondition says nothing about.
      expectedOutcome: 'The confirmation message says the request was received.',
    });
    const { remove } = planAssertionCleanup([submitWithPostcondition(), meaningful]);
    expect(remove).toEqual([]);
  });

  it('ignores a plan with no placeholder at all', () => {
    const { remove, retained } = planAssertionCleanup([submitWithPostcondition()]);
    expect(remove).toEqual([]);
    expect(retained).toEqual([]);
  });

  it('is deterministic for the same steps', () => {
    const steps = [submitWithPostcondition(), placeholder()];
    const first = JSON.stringify(planAssertionCleanup(steps));
    for (let i = 0; i < 3; i++) expect(JSON.stringify(planAssertionCleanup(steps))).toBe(first);
  });
});

describe('expectedOutcome rewording', () => {
  it('states what a postcondition checks, and nothing more', () => {
    const reworded = rewordExpectedOutcome(submitWithPostcondition());
    expect(reworded).toContain('/thank-you');
    expect(reworded).toMatch(/not that the operation succeeded/i);
  });

  it('does not claim a business outcome', () => {
    const reworded = rewordExpectedOutcome(submitWithPostcondition()).toLowerCase();
    for (const forbidden of ['payment', 'order completed', 'account created', 'email sent', 'database']) {
      expect(reworded, forbidden).not.toContain(forbidden);
    }
  });

  it('leaves a step with no postcondition untouched', () => {
    const plain = step({ id: 's', order: 1, expectedOutcome: 'Submit the form' });
    expect(rewordExpectedOutcome(plain)).toBe('Submit the form');
  });

  it('leaves a step with a structured assertion to its own wording', () => {
    // The assertion, not the postcondition, is the primary claim here.
    const withAssertion = step({
      id: 's',
      order: 1,
      action: 'assert',
      expectedOutcome: 'The cart is empty.',
      assertion: { type: 'text-contains', expectedText: 'Cart is empty', match: 'exact', source: { kind: 'scout-visible-text' } },
    });
    expect(rewordExpectedOutcome(withAssertion)).toBe('The cart is empty.');
  });

  it('is deterministic', () => {
    const target = submitWithPostcondition();
    const first = rewordExpectedOutcome(target);
    for (let i = 0; i < 3; i++) expect(rewordExpectedOutcome(target)).toBe(first);
  });
});
