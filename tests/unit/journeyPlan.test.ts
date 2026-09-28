import { describe, expect, it } from 'vitest';
import { HeuristicJourneyPlanner, planJourney } from '../../src/journey/plan.js';
import { classifyGoal } from '../../src/journey/classify.js';
import { normalizeGoal } from '../../src/journey/goal.js';
import { extractElements } from '../../src/journey/scoutLoader.js';
import { matchRole, matchRoles, rolesForJourney, requiresCredentials, requiresPayment } from '../../src/journey/match.js';
import { confidenceForMatch, overallConfidence, scoreConfidence, isLowConfidence } from '../../src/journey/confidence.js';
import { summarizeJourney } from '../../src/journey/report.js';
import { JOURNEY_SCHEMA_VERSION } from '../../src/journey/types.js';
import type { JourneyPlan, JourneyStep } from '../../src/journey/types.js';
import {
  ambiguousScoutReport,
  checkoutScoutReport,
  contactScoutReport,
  disabledOnlyScoutReport,
  el,
  emptyScoutReport,
  formScoutReport,
  hiddenOnlyScoutReport,
  loginScoutReport,
  noMatchScoutReport,
  registrationScoutReport,
  searchScoutReport,
  ticketScoutReport,
  uploadScoutReport,
} from '../fixtures/scoutReports.js';

const planner = new HeuristicJourneyPlanner();
const SCOUT_PATH = 'reports/scout.json';

/** Plan from a fixture report, as the CLI would. */
function plan(goal: string, report: Parameters<typeof planJourney>[1]): JourneyPlan {
  return planJourney(goal, report, SCOUT_PATH, planner);
}

/** Every locator a step offers, flattened. */
function allLocators(planResult: JourneyPlan): string[] {
  return planResult.steps.flatMap((step) => step.locatorCandidates);
}

describe('plan schema', () => {
  it('has every required top-level field', () => {
    const result = plan('log in', loginScoutReport());
    expect(Object.keys(result).sort()).toEqual(
      [
        'assumptions',
        'goal',
        'journeyType',
        'missingInformation',
        'normalizedGoal',
        'planner',
        'schemaVersion',
        'steps',
        'target',
        'warnings',
      ].sort(),
    );
  });

  it('has every required step field', () => {
    for (const step of plan('log in', loginScoutReport()).steps) {
      expect(Object.keys(step).sort()).toEqual(
        [
          'action',
          'confidence',
          'description',
          'executable',
          'expectedOutcome',
          'id',
          'intent',
          'locatorCandidates',
          'order',
          'source',
          'targetElementIds',
        ].sort(),
      );
    }
  });

  it('declares schema version 1.0 and a heuristic planner', () => {
    const result = plan('log in', loginScoutReport());
    expect(result.schemaVersion).toBe(JOURNEY_SCHEMA_VERSION);
    expect(result.schemaVersion).toBe('1.0');
    expect(result.planner.mode).toBe('heuristic');
    expect(result.planner.version).toBe('0.1.0');
  });

  it('echoes the target from the Scout report', () => {
    const result = plan('log in', loginScoutReport());
    expect(result.target.url).toBe('https://staging.example.test/login');
    expect(result.target.title).toBe('Sign in');
  });

  it('numbers steps sequentially with deterministic ids', () => {
    const steps = plan('log in', loginScoutReport()).steps;
    expect(steps.map((step) => step.id)).toEqual(steps.map((_, i) => `step-${String(i + 1).padStart(3, '0')}`));
    expect(steps.map((step) => step.order)).toEqual(steps.map((_, i) => i + 1));
  });

  it('uses only the documented action vocabulary', () => {
    const allowed = new Set(['observe', 'navigate', 'identify', 'click', 'fill', 'select', 'upload', 'submit', 'assert']);
    for (const goal of ['log in', 'complete checkout', 'upload a file', 'search for widgets']) {
      for (const step of plan(goal, checkoutScoutReport()).steps) {
        expect(allowed.has(step.action), `${step.intent} used ${step.action}`).toBe(true);
      }
    }
  });
});

describe('executable is always false', () => {
  it('marks every step non-executable for every journey type', () => {
    const reports = [
      loginScoutReport(),
      registrationScoutReport(),
      checkoutScoutReport(),
      ticketScoutReport(),
      formScoutReport(),
      searchScoutReport(),
      contactScoutReport(),
      uploadScoutReport(),
    ];
    const goals = [
      'log in',
      'register a new account',
      'complete checkout',
      'buy a ticket',
      'submit the form',
      'search for widgets',
      'contact support',
      'upload a file',
    ];

    for (const [i, goal] of goals.entries()) {
      const result = plan(goal, reports[i]!);
      expect(result.steps.length).toBeGreaterThan(0);
      for (const step of result.steps) {
        expect(step.executable, `${goal}/${step.id}`).toBe(false);
      }
    }
  });
});

describe('login journey', () => {
  it('classifies and plans the expected steps', () => {
    const result = plan('try to log in', loginScoutReport());
    expect(result.journeyType).toBe('login');
    expect(result.steps.map((step) => step.intent)).toEqual([
      'locate_login_form',
      'identify_username_field',
      'identify_password_field',
      'identify_login_submission',
      'define_login_success',
    ]);
  });

  it('finds the username, password and sign-in controls', () => {
    const result = plan('log in', loginScoutReport());
    const byIntent = new Map(result.steps.map((step) => [step.intent, step]));
    expect(byIntent.get('identify_username_field')?.targetElementIds).toContain('element-001');
    expect(byIntent.get('identify_password_field')?.targetElementIds).toContain('element-002');
    expect(byIntent.get('identify_login_submission')?.targetElementIds).toContain('element-003');
  });

  it('does not mistake the forgot-password link for the sign-in control', () => {
    const result = plan('log in', loginScoutReport());
    const submission = result.steps.find((step) => step.intent === 'identify_login_submission');
    expect(submission?.targetElementIds).not.toContain('element-004');
  });

  it('records that credentials are required', () => {
    const result = plan('log in', loginScoutReport());
    expect(result.missingInformation.join(' ')).toMatch(/credentials/i);
    expect(requiresCredentials('login')).toBe(true);
  });
});

describe('registration journey', () => {
  it('plans name, username, password, confirm and submission', () => {
    const result = plan('register a new account', registrationScoutReport());
    expect(result.journeyType).toBe('registration');
    const intents = result.steps.map((step) => step.intent);
    expect(intents).toContain('identify_name_field');
    expect(intents).toContain('identify_password_confirmation');
    expect(intents).toContain('identify_registration_submission');
  });

  it('distinguishes the password field from the confirmation field', () => {
    const result = plan('sign up', registrationScoutReport());
    const byIntent = new Map(result.steps.map((step) => [step.intent, step]));
    expect(byIntent.get('identify_password_field')?.targetElementIds).toContain('element-003');
    expect(byIntent.get('identify_password_confirmation')?.targetElementIds).toContain('element-004');
  });

  it('does not treat the sign-in link as the registration control', () => {
    const result = plan('register a new account', registrationScoutReport());
    const control = result.steps.find((step) => step.intent === 'identify_registration_submission');
    expect(control?.targetElementIds).not.toContain('element-006');
  });
});

describe('checkout journey', () => {
  it('plans the purchase path in order', () => {
    const result = plan('try to complete checkout', checkoutScoutReport());
    expect(result.journeyType).toBe('checkout');
    expect(result.steps.map((step) => step.intent)).toEqual([
      'identify_purchase_target',
      'identify_purchase_control',
      'identify_quantity_control',
      'identify_checkout_control',
      'identify_payment_control',
      'define_purchase_confirmation',
    ]);
  });

  it('finds add-to-cart, quantity and buy controls', () => {
    const result = plan('try to complete checkout', checkoutScoutReport());
    const byIntent = new Map(result.steps.map((step) => [step.intent, step]));
    expect(byIntent.get('identify_purchase_control')?.targetElementIds).toContain('element-003');
    expect(byIntent.get('identify_quantity_control')?.targetElementIds).toContain('element-004');
  });

  it('does not plan a hidden or disabled control as a usable target', () => {
    const result = plan('try to complete checkout', checkoutScoutReport());
    // element-006 is a hidden Checkout button, element-007 a disabled Pay now
    // button; neither may be offered as a planned candidate for any step.
    for (const step of result.steps) {
      expect(step.targetElementIds).not.toContain('element-006');
      expect(step.targetElementIds).not.toContain('element-007');
    }
  });

  it('still plans the visible cart link as a checkout-stage control', () => {
    const result = plan('try to complete checkout', checkoutScoutReport());
    const checkout = result.steps.find((step) => step.intent === 'identify_checkout_control');
    expect(checkout?.targetElementIds).toContain('element-005');
  });

  it('warns that a checkout control exists only in a hidden state', () => {
    const result = plan('try to complete checkout', checkoutScoutReport());
    expect(result.warnings.join(' ')).toMatch(/checkout control was found but is hidden/i);
  });

  it('warns that the payment control is disabled', () => {
    const result = plan('try to complete checkout', checkoutScoutReport());
    expect(result.warnings.join(' ')).toMatch(/payment or order control was found but is disabled/i);
  });

  it('records that a payment method and a product choice are needed', () => {
    const result = plan('try to complete checkout', checkoutScoutReport());
    const missing = result.missingInformation.join(' ');
    expect(missing).toMatch(/payment method/i);
    expect(missing).toMatch(/product, event, or ticket/i);
    expect(requiresPayment('checkout')).toBe(true);
  });

  it('makes no claim that payment is safe, available or successful', () => {
    const result = plan('try to complete checkout', checkoutScoutReport());
    // Every sentence mentioning payment must be a disclaimer, never an
    // assurance. Checked sentence by sentence so the disclaimer's own wording
    // ("no claim is made that payment is safe or available") is not a hit.
    const sentences = [
      ...result.warnings,
      ...result.missingInformation,
      ...result.assumptions,
      ...result.steps.map((step) => `${step.description} ${step.expectedOutcome}`),
    ]
      .join(' ')
      .split(/(?<=[.!?])\s+/)
      .filter((sentence) => /payment/i.test(sentence))
      .map((sentence) => sentence.toLowerCase());

    expect(sentences.length).toBeGreaterThan(0);
    for (const sentence of sentences) {
      expect(sentence, `unqualified payment claim: ${sentence}`).toMatch(
        /no claim|not captured|no payment data|required|unavailable|not found|identif|step|disclaimer|cannot/i,
      );
    }
  });

  it('states the payment disclaimer explicitly', () => {
    expect(plan('try to complete checkout', checkoutScoutReport()).warnings.join(' ')).toMatch(
      /no claim is made that payment is safe or available/i,
    );
  });

  it('invents no payment data', () => {
    const serialized = JSON.stringify(plan('try to complete checkout', checkoutScoutReport()));
    expect(serialized).not.toMatch(/\b4[0-9]{15}\b/); // card-number shaped
    expect(serialized).not.toMatch(/"cvv"|"cvc"|card number is|expiry date of/i);
  });
});

describe('ticket purchase journey', () => {
  it('classifies separately from generic checkout', () => {
    const result = plan('try to purchase a ticket', ticketScoutReport());
    expect(result.journeyType).toBe('ticket_purchase');
    expect(result.journeyType).not.toBe('checkout');
  });

  it('targets the ticket control first', () => {
    const result = plan('try to purchase a ticket', ticketScoutReport());
    const first = result.steps[0];
    expect(first?.intent).toBe('identify_purchase_target');
    expect(first?.targetElementIds).toContain('element-001');
  });

  it('finds the pay control and records payment as missing', () => {
    const result = plan('try to purchase a ticket', ticketScoutReport());
    const byIntent = new Map(result.steps.map((step) => [step.intent, step]));
    expect(byIntent.get('identify_payment_control')?.targetElementIds).toContain('element-005');
    expect(result.missingInformation.join(' ')).toMatch(/payment method/i);
  });

  it('finds the reserve and basket controls', () => {
    const result = plan('buy tickets for the concert', ticketScoutReport());
    const byIntent = new Map(result.steps.map((step) => [step.intent, step]));
    expect(byIntent.get('identify_purchase_control')?.targetElementIds).toContain('element-002');
    expect(byIntent.get('identify_checkout_control')?.targetElementIds).toContain('element-004');
  });
});

describe('form submission journey', () => {
  it('finds required fields, selects, textareas and the submit control', () => {
    const result = plan('submit the form', formScoutReport());
    expect(result.journeyType).toBe('form_submission');
    const byIntent = new Map(result.steps.map((step) => [step.intent, step]));
    expect(byIntent.get('identify_required_fields')?.targetElementIds).toContain('element-003');
    expect(byIntent.get('identify_message_field')?.targetElementIds).toContain('element-004');
    expect(byIntent.get('identify_file_field')?.targetElementIds).toContain('element-005');
    expect(byIntent.get('identify_submit_control')?.targetElementIds).toContain('element-006');
  });
});

describe('search journey', () => {
  it('finds the search field and submission control', () => {
    const result = plan('search for widgets', searchScoutReport());
    expect(result.journeyType).toBe('search');
    const byIntent = new Map(result.steps.map((step) => [step.intent, step]));
    expect(byIntent.get('locate_search_control')?.targetElementIds).toContain('element-001');
    expect(byIntent.get('identify_search_submission')?.targetElementIds).toContain('element-002');
  });
});

describe('contact journey', () => {
  it('finds the message field and send control', () => {
    const result = plan('contact support', contactScoutReport());
    expect(result.journeyType).toBe('contact');
    const byIntent = new Map(result.steps.map((step) => [step.intent, step]));
    expect(byIntent.get('identify_message_field')?.targetElementIds).toContain('element-003');
    expect(byIntent.get('identify_contact_submission')?.targetElementIds).toContain('element-004');
  });

  it('invents no message content', () => {
    const result = plan('contact support', contactScoutReport());
    const messageStep = result.steps.find((step) => step.intent === 'identify_message_field');
    expect(messageStep?.description).toMatch(/no message content is invented/i);
    // No step may carry a value for the message field.
    expect(result.steps.every((step) => step.locatorCandidates.every((locator) => !locator.includes('value=')))).toBe(true);
  });
});

describe('upload journey', () => {
  it('finds the file input and upload control', () => {
    const result = plan('upload a file', uploadScoutReport());
    expect(result.journeyType).toBe('upload');
    const byIntent = new Map(result.steps.map((step) => [step.intent, step]));
    expect(byIntent.get('locate_file_input')?.targetElementIds).toContain('element-001');
    expect(byIntent.get('identify_upload_control')?.targetElementIds).toContain('element-002');
  });
});

describe('unknown and empty goals', () => {
  it('produces a valid low-confidence plan for an unrecognised goal', () => {
    const result = plan('do something unspecified', checkoutScoutReport());
    expect(result.journeyType).toBe('unknown');
    expect(result.steps.length).toBeGreaterThan(0);
    expect(result.warnings.join(' ')).toMatch(/matched no known journey category/i);
  });

  it('produces a valid plan for an empty goal', () => {
    const result = plan('', checkoutScoutReport());
    expect(result.goal).toBe('');
    expect(result.normalizedGoal).toBe('');
    expect(result.journeyType).toBe('unknown');
    expect(result.steps.length).toBeGreaterThan(0);
    expect(result.steps.every((step) => step.executable === false)).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('produces a valid plan for a whitespace-only goal', () => {
    const result = plan('    ', checkoutScoutReport());
    expect(result.journeyType).toBe('unknown');
    expect(result.steps.length).toBeGreaterThan(0);
  });
});

describe('reports with no matching elements', () => {
  it('still produces a valid plan with warnings rather than failing', () => {
    const result = plan('try to complete checkout', noMatchScoutReport());
    expect(result.steps.length).toBeGreaterThan(0);
    // Every element-bearing step has nothing to point at, and says so with
    // zero confidence. The trailing assertion step has no element evidence by
    // nature, so it is excluded from the check.
    const elementSteps = result.steps.filter((step) => step.action !== 'assert');
    expect(elementSteps.every((step) => step.targetElementIds.length === 0)).toBe(true);
    expect(elementSteps.every((step) => step.confidence === 0)).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('handles a report with no interactive elements at all', () => {
    const result = plan('log in', emptyScoutReport());
    expect(result.steps.length).toBeGreaterThan(0);
    expect(result.warnings.join(' ')).toMatch(/no interactive elements/i);
  });
});

describe('ambiguity and hidden or disabled controls', () => {
  it('reports equally scoring candidates as ambiguous', () => {
    const result = plan('submit the form', ambiguousScoutReport());
    expect(result.warnings.join(' ')).toMatch(/matched the goal equally well/i);
  });

  it('includes all tied candidates in the step targets', () => {
    const result = plan('submit the form', ambiguousScoutReport());
    const submit = result.steps.find((step) => step.intent === 'identify_submit_control');
    expect(submit?.targetElementIds).toEqual(['element-001', 'element-002', 'element-003']);
  });

  it('lowers confidence when candidates tie', () => {
    // Isolates the tie penalty: a single control whose only difference from the
    // unique case is that it ties with an identical sibling.
    const tiedMatch = matchRole(extractElements(ambiguousScoutReport()), {
      role: 'submit_control',
      elementTypes: ['button', 'input'],
      textPatterns: [/^submit$/],
    });
    expect(tiedMatch.ambiguous).toBe(true);

    const singleReport = checkoutScoutReport();
    singleReport.interactiveElements = [
      el({ index: 0, type: 'button', tag: 'button', text: 'Submit', id: 'only-submit' }),
    ];
    const uniqueMatch = matchRole(extractElements(singleReport), {
      role: 'submit_control',
      elementTypes: ['button', 'input'],
      textPatterns: [/^submit$/],
    });

    const tied = confidenceForMatch(tiedMatch, { isRequired: true });
    const unique = confidenceForMatch(uniqueMatch, { isRequired: true });
    expect(tied).toBeLessThan(unique);
  });

  it('never plans a hidden control', () => {
    const result = plan('try to complete checkout', hiddenOnlyScoutReport());
    for (const step of result.steps) {
      expect(step.targetElementIds).not.toContain('element-001');
    }
    expect(result.warnings.join(' ')).toMatch(/hidden/i);
  });

  it('never plans a disabled control', () => {
    const result = plan('try to complete checkout', disabledOnlyScoutReport());
    for (const step of result.steps) {
      expect(step.targetElementIds).not.toContain('element-001');
    }
    expect(result.warnings.join(' ')).toMatch(/disabled/i);
  });
});

describe('determinism', () => {
  it('produces byte-identical output for repeated runs', () => {
    const goal = 'try to complete checkout';
    const report = checkoutScoutReport();
    const first = JSON.stringify(plan(goal, report), null, 2);
    for (let i = 0; i < 10; i++) {
      expect(JSON.stringify(plan(goal, report), null, 2)).toBe(first);
    }
  });

  it('contains no timestamp', () => {
    const serialized = JSON.stringify(plan('log in', loginScoutReport()));
    // ISO 8601 datetimes, the only timestamp shape the report could contain.
    expect(serialized).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });

  it('contains no absolute or machine-specific path', () => {
    const serialized = JSON.stringify(plan('log in', loginScoutReport()));
    expect(serialized).toContain('reports/scout.json');
    expect(serialized).not.toMatch(/[A-Z]:\\\\/);
    expect(serialized).not.toMatch(/\/Users\//);
    expect(serialized).not.toMatch(/\/home\//);
  });

  it('orders candidate targets stably by relevance then document order', () => {
    const result = plan('try to complete checkout', checkoutScoutReport());
    const quantity = result.steps.find((step) => step.intent === 'identify_quantity_control');
    // The labelled Quantity input outranks the unnamed number input that
    // follows it in document order.
    expect(quantity?.targetElementIds[0]).toBe('element-004');
  });

  it('deduplicates identical locator candidates', () => {
    const result = plan('try to complete checkout', checkoutScoutReport());
    for (const step of result.steps) {
      expect(new Set(step.locatorCandidates).size).toBe(step.locatorCandidates.length);
    }
  });

  it('deduplicates identical warnings and missing-information entries', () => {
    const result = plan('sign up then log in', loginScoutReport());
    expect(new Set(result.warnings).size).toBe(result.warnings.length);
    expect(new Set(result.missingInformation).size).toBe(result.missingInformation.length);
    expect(new Set(result.assumptions).size).toBe(result.assumptions.length);
  });
});

describe('element traceability', () => {
  it('only references element ids that exist in the Scout report', () => {
    const pairs: [string, Parameters<typeof planJourney>[1]][] = [
      ['log in', loginScoutReport()],
      ['register a new account', registrationScoutReport()],
      ['complete checkout', checkoutScoutReport()],
      ['buy a ticket', ticketScoutReport()],
      ['submit the form', formScoutReport()],
      ['search for widgets', searchScoutReport()],
      ['contact support', contactScoutReport()],
      ['upload a file', uploadScoutReport()],
    ];

    for (const [goal, report] of pairs) {
      const valid = new Set(extractElements(report).map((element) => `element-${String(element.index + 1).padStart(3, '0')}`));
      for (const step of plan(goal, report).steps) {
        for (const id of step.targetElementIds) {
          expect(valid.has(id), `${goal}: ${step.id} references unknown ${id}`).toBe(true);
        }
        // The source block must repeat the same ids as the step itself.
        expect(step.source.elementIds).toEqual(step.targetElementIds);
        expect(step.source.report).toBe(SCOUT_PATH);
      }
    }
  });

  it('keeps the Scout report path exactly as supplied', () => {
    const result = planJourney('log in', loginScoutReport(), 'C:\\somewhere\\else\\scout.json', planner);
    expect(result.steps[0]?.source.report).toBe('C:\\somewhere\\else\\scout.json');
  });
});

describe('no invented secrets', () => {
  const reports = [loginScoutReport(), registrationScoutReport(), checkoutScoutReport(), formScoutReport()];
  const goals = ['log in', 'register a new account', 'complete checkout', 'submit the form'];

  it('invents no credential values', () => {
    for (const [i, goal] of goals.entries()) {
      const serialized = JSON.stringify(plan(goal, reports[i]!));
      expect(serialized).not.toMatch(/password["']?\s*[:=]\s*["'][^"']+/i);
      expect(serialized).not.toMatch(/hunter2|secret123|letmein|qwerty/i);
    }
  });

  it('never reads a hidden input value into a step', () => {
    // A hidden password field carrying a value must not surface that value.
    const report = loginScoutReport();
    report.interactiveElements.push(
      el({ index: 4, type: 'input', tag: 'input', inputType: 'password', name: 'token', visible: false, value: 'supersecrettoken' }),
    );
    const serialized = JSON.stringify(plan('log in', report));
    expect(serialized).not.toContain('supersecrettoken');
  });

  it('never plans a hidden input as a target', () => {
    const report = loginScoutReport();
    report.interactiveElements.push(
      el({ index: 4, type: 'input', tag: 'input', inputType: 'password', name: 'token', visible: false }),
    );
    for (const step of plan('log in', report).steps) {
      expect(step.targetElementIds).not.toContain('element-005');
    }
  });
});

describe('expected outcome honesty', () => {
  it('states that the post-step state is not represented in Scout data', () => {
    for (const [goal, report] of [
      ['log in', loginScoutReport()],
      ['complete checkout', checkoutScoutReport()],
      ['search for widgets', searchScoutReport()],
    ] as [string, Parameters<typeof planJourney>[1]][]) {
      const result = plan(goal, report);
      const last = result.steps[result.steps.length - 1];
      expect(last?.action).toBe('assert');
      expect(last?.expectedOutcome).toMatch(/not found in the Scout report|must be observed at execution time/i);
      expect(result.missingInformation.join(' ')).toMatch(/state after the final step is unknown/i);
    }
  });
});

describe('confidence rules', () => {
  it('stays within 0..1 for every step', () => {
    const reports = [loginScoutReport(), checkoutScoutReport(), noMatchScoutReport(), emptyScoutReport()];
    const goals = ['log in', 'try to complete checkout', 'submit the form', 'contact support'];
    for (const goal of goals) {
      for (const report of reports) {
        for (const step of plan(goal, report).steps) {
          expect(step.confidence).toBeGreaterThanOrEqual(0);
          expect(step.confidence).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('never reaches 1.0, because no Scout evidence proves a journey works', () => {
    const result = plan('log in', loginScoutReport());
    expect(Math.max(...result.steps.map((step) => step.confidence))).toBeLessThan(1);
  });

  it('scores zero when nothing matched', () => {
    expect(scoreConfidence({ bestScore: null, tiedCandidates: 0, hiddenCount: 0, disabledCount: 0, hasLocator: false, isRequired: true })).toBe(0);
  });

  it('falls when a candidate has no usable locator', () => {
    const withLocator = scoreConfidence({ bestScore: 90, tiedCandidates: 1, hiddenCount: 0, disabledCount: 0, hasLocator: true, isRequired: true });
    const without = scoreConfidence({ bestScore: 90, tiedCandidates: 1, hiddenCount: 0, disabledCount: 0, hasLocator: false, isRequired: true });
    expect(without).toBeLessThan(withLocator);
  });

  it('falls when candidates tie', () => {
    const unique = scoreConfidence({ bestScore: 90, tiedCandidates: 1, hiddenCount: 0, disabledCount: 0, hasLocator: true, isRequired: true });
    const tied = scoreConfidence({ bestScore: 90, tiedCandidates: 2, hiddenCount: 0, disabledCount: 0, hasLocator: true, isRequired: true });
    expect(tied).toBeLessThan(unique);
  });

  it('falls when hidden or disabled equivalents exist', () => {
    const clean = scoreConfidence({ bestScore: 90, tiedCandidates: 1, hiddenCount: 0, disabledCount: 0, hasLocator: true, isRequired: true });
    const hidden = scoreConfidence({ bestScore: 90, tiedCandidates: 1, hiddenCount: 1, disabledCount: 0, hasLocator: true, isRequired: true });
    const disabled = scoreConfidence({ bestScore: 90, tiedCandidates: 1, hiddenCount: 0, disabledCount: 1, hasLocator: true, isRequired: true });
    expect(hidden).toBeLessThan(clean);
    expect(disabled).toBeLessThan(clean);
  });

  it('lets a weak required step drag the overall score down', () => {
    const strong = overallConfidence([
      { confidence: 0.95, isRequired: true },
      { confidence: 0.9, isRequired: false },
    ]);
    const weakRequired = overallConfidence([
      { confidence: 0.95, isRequired: true },
      { confidence: 0.1, isRequired: true },
    ]);
    expect(weakRequired).toBeLessThan(strong);
  });

  it('flags low-confidence plans for a warning', () => {
    expect(isLowConfidence(0.2)).toBe(true);
    expect(isLowConfidence(0.9)).toBe(false);
    const result = plan('try to complete checkout', noMatchScoutReport());
    expect(result.warnings.join(' ')).toMatch(/overall plan confidence is low/i);
  });

  it('raises confidence for a well-evidenced step', () => {
    const elements = extractElements(loginScoutReport());
    const matches = matchRoles(elements, rolesForJourney('login'), new Set(['log', 'in']));
    const password = matches.get('password_field');
    expect(password).toBeDefined();
    const confidence = confidenceForMatch(password!, { isRequired: true });
    expect(confidence).toBeGreaterThan(0.4);
  });
});

describe('assumptions', () => {
  it('always records that visibility is taken as captured and that nothing is executed', () => {
    for (const [goal, report] of [
      ['log in', loginScoutReport()],
      ['complete checkout', checkoutScoutReport()],
    ] as [string, Parameters<typeof planJourney>[1]][]) {
      const joined = plan(goal, report).assumptions.join(' ');
      expect(joined).toMatch(/not re-verified/);
      expect(joined).toMatch(/Build 2 does not execute any step/);
    }
  });

  it('records the resolution when a goal was ambiguous', () => {
    const result = plan('sign up then log in', loginScoutReport());
    expect(result.assumptions.join(' ')).toMatch(/Ambiguous goal resolved/);
  });
});

describe('summarizeJourney', () => {
  it('renders the goal, type, steps and the non-execution statement', () => {
    const summary = summarizeJourney(plan('try to complete checkout', checkoutScoutReport()));
    expect(summary).toContain('JOURNEY PLANNER v0.1.0');
    expect(summary).toContain('try to complete checkout');
    expect(summary).toContain('Journey type:');
    expect(summary).toContain('step-001');
    expect(summary).toContain('execution belongs to Build 3');
  });

  it('shows warnings and missing information', () => {
    const summary = summarizeJourney(plan('try to complete checkout', checkoutScoutReport()));
    expect(summary).toMatch(/WARNINGS \(\d+\)/);
    expect(summary).toMatch(/MISSING INFORMATION \(\d+\)/);
  });

  it('is deterministic', () => {
    const first = summarizeJourney(plan('log in', loginScoutReport()));
    expect(summarizeJourney(plan('log in', loginScoutReport()))).toBe(first);
  });
});

describe('planner seam', () => {
  it('accepts a custom planner implementation', () => {
    const custom = {
      plan: (): JourneyPlan => ({
        schemaVersion: JOURNEY_SCHEMA_VERSION,
        goal: 'custom',
        normalizedGoal: 'custom',
        journeyType: 'unknown' as const,
        target: { url: '', finalUrl: null, title: '' },
        steps: [] as JourneyStep[],
        assumptions: [],
        warnings: [],
        missingInformation: [],
        planner: { mode: 'heuristic' as const, version: 'test' },
      }),
    };
    expect(planJourney('anything', loginScoutReport(), SCOUT_PATH, custom).goal).toBe('custom');
  });
});

describe('classification is independent of the page', () => {
  it('classifies from the goal alone', () => {
    // The same goal must classify identically regardless of the Scout report.
    for (const report of [loginScoutReport(), emptyScoutReport(), checkoutScoutReport()]) {
      const normalized = normalizeGoal('try to complete checkout');
      expect(classifyGoal(normalized).journeyType).toBe('checkout');
      expect(plan('try to complete checkout', report).journeyType).toBe('checkout');
    }
  });
});
