/**
 * Journey planning.
 *
 * The default {@link JourneyPlanner}: deterministic, local, heuristic. It
 * imports nothing from Playwright and performs no I/O - it is a pure function
 * of a goal string and a validated Scout report.
 *
 * Planning flow: classify the goal, match Scout elements against the roles that
 * journey type cares about, emit one step per role in a fixed order, and let
 * confidence and warnings fall out of what did and did not match.
 *
 * Nothing is executed. Every step is `executable: false`, and no step carries
 * invented credentials, payment data, or hidden field values.
 */

import type { ScoutReport } from '../scout/types.js';
import type {
  JourneyAction,
  JourneyPlan,
  JourneyPlanner,
  JourneyPlannerInput,
  JourneyStep,
  JourneyType,
  Postcondition,
  StructuredAssertion,
} from './types.js';
import { JOURNEY_SCHEMA_VERSION, confidenceBand } from './types.js';
import { normalizeGoal, tokenize } from './goal.js';
import { classifyGoal } from './classify.js';
import { bestCandidate, confidenceForMatch, isLowConfidence, overallConfidence } from './confidence.js';
import { matchRoles, requiresCredentials, requiresPayment, rolesForJourney } from './match.js';
import { generatePostActionAssertion } from './structuredAssertion.js';
import { deriveFormPostcondition, formForElement } from './postcondition.js';
import { planAssertionCleanup, rewordExpectedOutcome } from './assertionCleanup.js';
import {
  AUTH_ACTION_TEXTS,
  PURCHASE_ACTION_TEXTS,
  SUBMIT_ACTION_TEXTS,
  decideAction,
} from './actionability.js';
import type { ElementRole, RoleMatch, RoleSpec } from './match.js';
import { extractElements } from './scoutLoader.js';
import { TOOL_VERSION } from '../version.js';

/** A step template for one journey type, evaluated against the Scout data. */
interface StepTemplate {
  intent: string;
  /** The action used when the match is not strong enough to act on. */
  action: JourneyAction;
  /**
   * The action used when the match is strong, unique, visible and enabled.
   * Omitted for structural steps, which never carry a target.
   */
  actionable?: JourneyAction;
  /** Exact element text that would justify `actionable`. Empty skips the gate. */
  requiredText?: readonly string[];
  /** Reads the step's description and outcome from what actually matched. */
  describe: (context: StepContext) => { description: string; expectedOutcome: string };
  /** The element role this step targets, when it targets one. */
  role?: ElementRole;
  /** A step without a role is structural (e.g. "review the result"). */
  isRequired?: boolean;
}

/** What a template needs in order to describe itself. */
interface StepContext {
  journeyType: JourneyType;
  match: RoleMatch | null;
  hasAnyCandidate: boolean;
  /** Why the step stayed observational despite a match, when applicable. */
  inertBecause: string | null;
}

/** Human-readable role names, used in step descriptions. */
const ROLE_LABELS: Record<ElementRole, string> = {
  email_field: 'email field',
  username_field: 'username or email field',
  password_field: 'password field',
  confirm_password_field: 'password confirmation field',
  name_field: 'name field',
  search_field: 'search field',
  message_field: 'message field',
  text_field: 'text field',
  select_field: 'select field',
  file_field: 'file field',
  submit_control: 'submission control',
  login_control: 'sign-in control',
  register_control: 'registration control',
  add_to_cart_control: 'add-to-cart control',
  checkout_control: 'checkout control',
  buy_control: 'purchase control',
  ticket_control: 'ticket selection control',
  search_control: 'search control',
  contact_control: 'contact submission control',
  upload_control: 'upload control',
  product_card: 'purchase target',
  quantity_control: 'quantity control',
  payment_control: 'payment or order control',
  link: 'navigation link',
  generic_control: 'control',
};

/** Fallback description for a step whose role matched nothing. */
function describeMissing(context: StepContext, noun: string): { description: string; expectedOutcome: string } {
  const label = ROLE_LABELS[context.match?.role ?? 'generic_control'] ?? noun;
  return {
    description: `No clearly identifiable ${label} was found in the Scout report for this goal.`,
    expectedOutcome: `A ${label} must be located manually, or the page must be re-scouted, before this step can be executed.`,
  };
}

/** Step templates per journey type, in the order a user would attempt them. */
function templatesFor(journeyType: JourneyType): StepTemplate[] {
  switch (journeyType) {
    case 'login':
      return [
        {
          intent: 'locate_login_form',
          action: 'identify',
          role: 'submit_control',
          isRequired: true,
          describe: (ctx) => ({
            description: 'Locate the login or sign-in form on the page.',
            expectedOutcome: ctx.hasAnyCandidate
              ? 'A sign-in form or control is present and identifiable.'
              : 'No sign-in form or control was found; the page may not offer a login.',
          }),
        },
        {
          intent: 'identify_username_field',
          action: 'identify',
          actionable: 'fill',
          role: 'username_field',
          isRequired: true,
          describe: (ctx) =>
            ctx.hasAnyCandidate
              ? {
                  description: 'Identify the email or username field that would receive an identifier.',
                  expectedOutcome: 'A username or email input is identified for later use.',
                }
              : describeMissing(ctx, 'username field'),
        },
        {
          intent: 'identify_password_field',
          action: 'identify',
          actionable: 'fill',
          role: 'password_field',
          isRequired: true,
          describe: (ctx) =>
            ctx.hasAnyCandidate
              ? {
                  description: 'Identify the password field. No credential value is captured or invented.',
                  expectedOutcome: 'A password input is identified; a test credential must be supplied separately before execution.',
                }
              : describeMissing(ctx, 'password field'),
        },
        {
          intent: 'identify_login_submission',
          action: 'identify',
          actionable: 'click',
          requiredText: AUTH_ACTION_TEXTS,
          role: 'login_control',
          isRequired: true,
          describe: (ctx) =>
            ctx.hasAnyCandidate
              ? {
                  description: 'Identify the control that submits the sign-in.',
                  expectedOutcome: 'The sign-in submission control is identified.',
                }
              : describeMissing(ctx, 'sign-in control'),
        },
        {
          intent: 'define_login_success',
          action: 'assert',
          describe: (ctx) => ({
            description: 'Define the observable outcome of a successful sign-in.',
            expectedOutcome:
              journeyType === 'login'
                ? 'The expected post-login state is not represented in the Scout report and must be observed at execution time.'
                : 'Post-login state is unknown.',
          }),
        },
      ];

    case 'registration':
      return [
        {
          intent: 'locate_registration_form',
          action: 'identify',
          role: 'register_control',
          isRequired: true,
          describe: (ctx) => ({
            description: 'Locate the registration or sign-up form on the page.',
            expectedOutcome: ctx.hasAnyCandidate
              ? 'A registration form or control is present and identifiable.'
              : 'No registration form or control was found; the page may not offer sign-up.',
          }),
        },
        {
          intent: 'identify_name_field',
          action: 'identify',
          actionable: 'fill',
          role: 'name_field',
          describe: (ctx) =>
            ctx.hasAnyCandidate
              ? { description: 'Identify a name field if the form requests one.', expectedOutcome: 'A name input is identified.' }
              : describeMissing(ctx, 'name field'),
        },
        {
          intent: 'identify_username_field',
          action: 'identify',
          actionable: 'fill',
          role: 'username_field',
          isRequired: true,
          describe: (ctx) =>
            ctx.hasAnyCandidate
              ? { description: 'Identify the email or username field.', expectedOutcome: 'A username or email input is identified.' }
              : describeMissing(ctx, 'username field'),
        },
        {
          intent: 'identify_password_field',
          action: 'identify',
          actionable: 'fill',
          role: 'password_field',
          isRequired: true,
          describe: (ctx) =>
            ctx.hasAnyCandidate
              ? {
                  description: 'Identify password fields. No credential values are captured or invented.',
                  expectedOutcome: 'Password inputs are identified; test credentials must be supplied separately before execution.',
                }
              : describeMissing(ctx, 'password field'),
        },
        {
          intent: 'identify_password_confirmation',
          action: 'identify',
          actionable: 'fill',
          role: 'confirm_password_field',
          describe: (ctx) =>
            ctx.hasAnyCandidate
              ? { description: 'Identify a password confirmation field if present.', expectedOutcome: 'A confirm-password input is identified.' }
              : describeMissing(ctx, 'confirmation field'),
        },
        {
          intent: 'identify_registration_submission',
          action: 'identify',
          actionable: 'click',
          requiredText: AUTH_ACTION_TEXTS,
          role: 'register_control',
          isRequired: true,
          describe: (ctx) =>
            ctx.hasAnyCandidate
              ? { description: 'Identify the control that submits the registration.', expectedOutcome: 'The registration submission control is identified.' }
              : describeMissing(ctx, 'registration control'),
        },
        {
          intent: 'define_registration_success',
          action: 'assert',
          describe: () => ({
            description: 'Define the observable outcome of successful account creation.',
            expectedOutcome: 'The expected post-registration state is not represented in the Scout report and must be observed at execution time.',
          }),
        },
      ];

    case 'checkout':
    case 'purchase':
    case 'ticket_purchase': {
      const isTicket = journeyType === 'ticket_purchase';
      return [
        {
          intent: 'identify_purchase_target',
          action: 'identify',
          role: isTicket ? 'ticket_control' : 'product_card',
          isRequired: true,
          describe: (ctx) => ({
            description: isTicket
              ? 'Identify the ticket or event entry point to purchase.'
              : 'Identify the relevant product, event, or ticket.',
            expectedOutcome: ctx.hasAnyCandidate
              ? `A relevant ${isTicket ? 'ticket' : 'purchase'} target is identified.`
              : 'No purchase target was identified; the intended product or ticket is unknown.',
          }),
        },
        {
          intent: 'identify_purchase_control',
          action: 'identify',
          actionable: 'click',
          requiredText: PURCHASE_ACTION_TEXTS,
          role: 'add_to_cart_control',
          isRequired: true,
          describe: (ctx) =>
            ctx.hasAnyCandidate
              ? { description: 'Identify the control that adds the selection to the cart or basket.', expectedOutcome: 'An add-to-cart control is identified.' }
              : describeMissing(ctx, 'add-to-cart control'),
        },
        {
          intent: 'identify_quantity_control',
          action: 'identify',
          actionable: 'select',
          role: 'quantity_control',
          describe: (ctx) =>
            ctx.hasAnyCandidate
              ? { description: 'Identify a quantity or variation control if one is present.', expectedOutcome: 'A quantity control is identified.' }
              : describeMissing(ctx, 'quantity control'),
        },
        {
          intent: 'identify_checkout_control',
          action: 'identify',
          actionable: 'click',
          requiredText: PURCHASE_ACTION_TEXTS,
          role: 'checkout_control',
          isRequired: true,
          describe: (ctx) =>
            ctx.hasAnyCandidate
              ? { description: 'Identify the control that proceeds to checkout.', expectedOutcome: 'A checkout control is identified.' }
              : describeMissing(ctx, 'checkout control'),
        },
        {
          // Deliberately inert. A payment or order-placement control is
          // identified but never planned as an action, so a generated plan
          // cannot reach a charge even before the executor's guard.
          intent: 'identify_payment_control',
          action: 'identify',
          role: 'payment_control',
          isRequired: true,
          describe: (ctx) =>
            ctx.hasAnyCandidate
              ? {
                  description: 'Identify the payment or order submission control. No payment data is captured, and this plan makes no claim about payment safety or availability.',
                  expectedOutcome: 'A payment or order submission control is identified.',
                }
              : describeMissing(ctx, 'payment control'),
        },
        {
          intent: 'define_purchase_confirmation',
          action: 'assert',
          describe: () => ({
            description: 'Define the expected order or ticket confirmation state.',
            expectedOutcome: 'The expected confirmation text or state was not found in the Scout report and must be observed at execution time.',
          }),
        },
      ];
    }

    case 'form_submission':
      return [
        {
          intent: 'locate_form',
          action: 'identify',
          role: 'text_field',
          isRequired: true,
          describe: (ctx) => ({
            description: 'Locate the relevant form and its required fields.',
            expectedOutcome: ctx.hasAnyCandidate ? 'A form with identifiable fields is present.' : 'No form fields were found on the page.',
          }),
        },
        {
          intent: 'identify_required_fields',
          action: 'identify',
          actionable: 'select',
          role: 'select_field',
          isRequired: true,
          describe: (ctx) =>
            ctx.hasAnyCandidate
              ? { description: 'Identify required inputs, including selects.', expectedOutcome: 'Required fields are identified.' }
              : describeMissing(ctx, 'select field'),
        },
        {
          intent: 'identify_message_field',
          action: 'identify',
          actionable: 'fill',
          role: 'message_field',
          describe: (ctx) =>
            ctx.hasAnyCandidate
              ? { description: 'Identify a textarea or long-form message field if present.', expectedOutcome: 'A message field is identified.' }
              : describeMissing(ctx, 'message field'),
        },
        {
          intent: 'identify_file_field',
          action: 'identify',
          actionable: 'upload',
          role: 'file_field',
          describe: (ctx) =>
            ctx.hasAnyCandidate
              ? { description: 'Identify a file input if the form requires one.', expectedOutcome: 'A file input is identified.' }
              : describeMissing(ctx, 'file field'),
        },
        {
          intent: 'identify_submit_control',
          action: 'identify',
          // A submit control performs a submission, so it maps to `submit` and
          // can carry the form's declared destination. Build 6.3 depends on
          // this: a postcondition attached to a plain `click` would be checked
          // after an action that does not navigate.
          //
          // No `requiredText` here, unlike the other actionable steps. A submit
          // control is already identified by the matcher's evidence - it lives
          // in a form, is a submit-type input or button - so demanding an
          // exact phrase like "Submit" would reject a perfectly ordinary
          // "Send message" and leave the journey without a postcondition.
          actionable: 'submit',
          role: 'submit_control',
          isRequired: true,
          describe: (ctx) =>
            ctx.hasAnyCandidate
              ? { description: 'Identify the control that submits the form.', expectedOutcome: 'The form submission control is identified.' }
              : describeMissing(ctx, 'submission control'),
        },
        {
          intent: 'define_form_success',
          action: 'assert',
          describe: () => ({
            description: 'Define the expected success state after submission.',
            expectedOutcome: 'The expected success text or state was not found in the Scout report and must be observed at execution time.',
          }),
        },
      ];

    case 'search':
      return [
        {
          intent: 'locate_search_control',
          action: 'identify',
          actionable: 'fill',
          role: 'search_field',
          isRequired: true,
          describe: (ctx) => ({
            description: 'Locate the search input where the search term would be entered.',
            expectedOutcome: ctx.hasAnyCandidate ? 'A search input is identified.' : 'No search input was found on the page.',
          }),
        },
        {
          intent: 'identify_search_submission',
          action: 'identify',
          actionable: 'click',
          requiredText: SUBMIT_ACTION_TEXTS,
          role: 'search_control',
          isRequired: true,
          describe: (ctx) =>
            ctx.hasAnyCandidate
              ? { description: 'Identify the control that submits the search.', expectedOutcome: 'A search submission control is identified.' }
              : describeMissing(ctx, 'search control'),
        },
        {
          intent: 'define_search_results',
          action: 'assert',
          describe: () => ({
            description: 'Define the expected results state after searching.',
            expectedOutcome: 'The expected results state was not found in the Scout report and must be observed at execution time.',
          }),
        },
      ];

    case 'contact':
      return [
        {
          intent: 'locate_contact_form',
          action: 'identify',
          role: 'text_field',
          isRequired: true,
          describe: (ctx) => ({
            description: 'Locate the contact form and its identity fields.',
            expectedOutcome: ctx.hasAnyCandidate ? 'A contact form with identifiable fields is present.' : 'No contact form fields were found.',
          }),
        },
        {
          intent: 'identify_message_field',
          action: 'identify',
          actionable: 'fill',
          role: 'message_field',
          isRequired: true,
          describe: (ctx) =>
            ctx.hasAnyCandidate
              ? { description: 'Identify the message textarea. No message content is invented.', expectedOutcome: 'A message field is identified.' }
              : describeMissing(ctx, 'message field'),
        },
        {
          intent: 'identify_contact_submission',
          action: 'identify',
          actionable: 'click',
          requiredText: SUBMIT_ACTION_TEXTS,
          role: 'contact_control',
          isRequired: true,
          describe: (ctx) =>
            ctx.hasAnyCandidate
              ? { description: 'Identify the control that sends the contact message.', expectedOutcome: 'A contact submission control is identified.' }
              : describeMissing(ctx, 'contact control'),
        },
        {
          intent: 'define_contact_success',
          action: 'assert',
          describe: () => ({
            description: 'Define the expected confirmation after sending a message.',
            expectedOutcome: 'The expected confirmation text was not found in the Scout report and must be observed at execution time.',
          }),
        },
      ];

    case 'upload':
      return [
        {
          intent: 'locate_file_input',
          action: 'identify',
          role: 'file_field',
          isRequired: true,
          describe: (ctx) => ({
            description: 'Locate the file input that would receive an upload.',
            expectedOutcome: ctx.hasAnyCandidate ? 'A file input is identified.' : 'No file input was found; the page may not accept uploads.',
          }),
        },
        {
          intent: 'identify_upload_control',
          action: 'identify',
          role: 'upload_control',
          isRequired: true,
          describe: (ctx) =>
            ctx.hasAnyCandidate
              ? { description: 'Identify the control that submits the upload.', expectedOutcome: 'An upload submission control is identified.' }
              : describeMissing(ctx, 'upload control'),
        },
        {
          intent: 'define_upload_success',
          action: 'assert',
          describe: () => ({
            description: 'Define the expected state after an upload completes.',
            expectedOutcome: 'The expected confirmation state was not found in the Scout report and must be observed at execution time.',
          }),
        },
      ];

    case 'navigation':
    default:
      return [
        {
          intent: 'identify_navigation_target',
          action: 'identify',
          role: 'link',
          isRequired: true,
          describe: (ctx) => ({
            description: 'Identify the links available for reaching the goal.',
            expectedOutcome: ctx.hasAnyCandidate ? 'Navigation links are identified.' : 'No links were found on the page.',
          }),
        },
        {
          intent: 'define_navigation_destination',
          action: 'assert',
          describe: () => ({
            description: 'Define the expected destination after navigation.',
            expectedOutcome: 'The expected destination was not found in the Scout report and must be observed at execution time.',
          }),
        },
      ];
  }
}

/** A step template plus whatever the plan needs to build its final assertion. */
interface StepBuildOptions {
  scoutPath: string;
  /** The Scout report, read only to derive a machine-readable expectation. */
  scout: ScoutReport;
  /** The journey type, so the generator can apply type-specific rules. */
  journeyType: JourneyType;
}

/**
 * Derive a machine-readable expectation for the terminal assertion step.
 *
 * Returns `null` for every journey type Build 2 cannot derive an observable
 * postcondition for - which today means all of them, unless the journey's own
 * click target is a same-origin link or form action. In that one case the
 * expectation is the destination the control *already declares*, restated, not
 * an inference about where the page should lead.
 */
function deriveFinalAssertion(
  options: StepBuildOptions,
  steps: readonly JourneyStep[],
): { assertion: StructuredAssertion; rationale: string } | null {
  // Payment-adjacent journeys get no derived expectation. "Buy" on a
  // checkout page may lead to a charge, and asserting *that* succeeded is
  // exactly the confident, unevidenced claim this refuses to make. A declared
  // cart destination is still safe: it says where the control goes, not that
  // anything was paid for.
  const isPaymentJourney =
    options.journeyType === 'checkout' || options.journeyType === 'purchase' || options.journeyType === 'ticket_purchase';

  // The expectation must describe where the journey *actually ends up*. So the
  // source has to be a control the plan navigates with - a link, or a form
  // whose action is a real destination. A link the plan merely observes while
  // clicking something else describes a journey the plan is not taking, and
  // asserting it would fail on every correct run.
  const navigable = new Set<string>();
  for (const step of steps) {
    if (step.action !== 'click' && step.action !== 'submit') continue;
    if (step.action === 'submit' && isPaymentJourney) continue;
    for (const id of step.targetElementIds) navigable.add(id);
  }

  const linkIds = new Set(
    options.scout.interactiveElements
      .filter((element) => element.type === 'link' && typeof element.href === 'string')
      .map((element) => `element-${String(element.index + 1).padStart(3, '0')}`),
  );

  for (const step of [...steps].reverse()) {
    for (const id of step.targetElementIds) {
      if (!navigable.has(id) || !linkIds.has(id)) continue;
      const element = options.scout.interactiveElements.find(
        (candidate) => `element-${String(candidate.index + 1).padStart(3, '0')}` === id,
      );
      const href = element?.href;
      if (typeof href !== 'string' || href.trim() === '') continue;

      const generation = generatePostActionAssertion(options.scout, { href, elementId: id, field: 'href' });
      if (generation.kind === 'generated') {
        return { assertion: generation.candidate.assertion, rationale: generation.candidate.rationale };
      }
    }
  }

  return null;
}

/**
 * Derive the postcondition for a submit step, from the form the step's own
 * target belongs to.
 *
 * Returns `null` when the form declares nothing checkable, which is the normal
 * case and is not an error - the prose fallback stands.
 */
function deriveSubmitPostcondition(scout: ScoutReport, targetElementIds: readonly string[]): Postcondition[] {
  for (const elementId of targetElementIds) {
    const located = formForElement(scout, elementId);
    if (located === null) continue;

    const generation = deriveFormPostcondition(located.form, located.formId, scout.target.inputUrl);
    // One target form is enough: a submit step acts on one form, and taking the
    // first match keeps the choice deterministic.
    return generation.kind === 'generated' ? [generation.postcondition] : [];
  }
  return [];
}

/** Build the ordered, `executable: false` steps for a journey. */
function buildSteps(
  journeyType: JourneyType,
  templates: readonly StepTemplate[],
  matches: Map<ElementRole, RoleMatch>,
  scoutPath: string,
  scout: ScoutReport,
): {
  steps: JourneyStep[];
  inertReasons: { intent: string; reason: string; detail: string }[];
  assertionRationale: string | null;
  /** Placeholder assertions a postcondition made redundant. */
  removedAssertions: string[];
  /** Why any surviving placeholder was kept. */
  retainedAssertions: string[];
} {
  const inertReasons: { intent: string; reason: string; detail: string }[] = [];

  const steps: JourneyStep[] = templates.map((template, position): JourneyStep => {    const match = template.role ? (matches.get(template.role) ?? null) : null;
    const best = match ? bestCandidate(match) : null;

    // Decide whether this step can carry a real action. A template without an
    // `actionable` action is structural and never acts.
    const decision = template.actionable
      ? decideAction({
          match,
          observationAction: template.action,
          actionAction: template.actionable,
          requiredText: template.requiredText,
        })
      : { action: template.action, actionable: false, blockedBecause: null as { reason: string; detail: string } | null };

    if (decision.blockedBecause) {
      inertReasons.push({ intent: template.intent, ...decision.blockedBecause });
    }

    const { description, expectedOutcome } = template.describe({
      journeyType,
      match,
      hasAnyCandidate: Boolean(best),
      inertBecause: decision.blockedBecause?.reason ?? null,
    });

    const confidence = match
      ? confidenceForMatch(match, { isRequired: template.isRequired === true })
      : 0.5; // A structural step (e.g. "define success") has no element evidence.

    // Candidates contribute at most a handful of locators, so the list stays
    // reviewable and Build 3 is not handed an unbounded set of guesses.
    const locatorCandidates: string[] = [];
    for (const candidate of (match?.candidates ?? []).slice(0, 3)) {
      const locator = candidate.locator;
      if (locator && !locatorCandidates.includes(locator)) locatorCandidates.push(locator);
    }

    const targetElementIds = match?.candidates.slice(0, 3).map((candidate) => candidate.elementId) ?? [];

    // Build 6.3: a submit action carries the destination its own form declared.
    // Attached here, to the action that causes it, so the executor can check it
    // immediately afterwards rather than after unrelated steps.
    const postconditions = decision.action === 'submit' ? deriveSubmitPostcondition(scout, targetElementIds) : undefined;
    return {
      id: `step-${String(position + 1).padStart(3, '0')}`,
      order: position + 1,
      intent: template.intent,
      action: decision.action,
      description,
      targetElementIds,
      locatorCandidates,
      expectedOutcome,
      // Build 6.2: a machine-readable expectation is attached below, once the
      // whole plan exists. Its absence means the prose fallback stands.
      // Build 6.3: postconditions are attached only to a submit action that
      // declared one. The key is spread in conditionally so a plan with none
      // looks exactly as it did before, rather than carrying a null field.
      ...(postconditions !== undefined && postconditions.length > 0 ? { postconditions } : {}),
      confidence: Math.round(confidence * 100) / 100,
      // Build 2 never executes. Build 3 may transform these descriptions.
      executable: false,
      source: {
        report: scoutPath,
        elementIds: targetElementIds,
      },
    };
  });

  // The expectation is derived once the whole plan exists, because it depends on
  // the control the plan is actually going to act on.
  const derived = deriveFinalAssertion({ scoutPath, scout, journeyType }, steps);
  const assertionStepIndex = steps.findIndex((step) => step.action === 'assert');
  if (derived !== null && assertionStepIndex >= 0) {
    const target = steps[assertionStepIndex];
    if (target) {
      steps[assertionStepIndex] = {
        ...target,
        assertion: derived.assertion,
        expectedOutcome: `The declared destination is reached: ${describeAssertion(derived.assertion)}.`,
        confidence: Math.max(target.confidence, 0.7),
        source: { report: scoutPath, elementIds: [derived.assertion.source.elementId ?? ''].filter(Boolean) },
      };
    }
  }

  // Build 6.4: a postcondition that covers a terminal placeholder makes that
  // placeholder redundant. Removing it is what lets a generated journey reach
  // full-plan verification instead of holding at `partial` forever.
  const { remove: redundantAssertions, retained: retainedAssertions } = planAssertionCleanup(steps);
  const removeSet = new Set(redundantAssertions);

  const cleaned: JourneyStep[] = [];
  for (const step of steps) {
    if (removeSet.has(step.id)) continue;
    // The surviving action states exactly what its postcondition checked, so a
    // step never claims a business outcome its URL check cannot support.
    cleaned.push({ ...step, expectedOutcome: rewordExpectedOutcome(step) });
  }

  // Order is renumbered so the plan has no gap left by a removed step.
  for (let index = 0; index < cleaned.length; index++) {
    const step = cleaned[index];
    if (step === undefined) continue;
    cleaned[index] = { ...step, order: index + 1 };
  }

  return {
    steps: cleaned,
    inertReasons,
    assertionRationale: derived?.rationale ?? null,
    removedAssertions: redundantAssertions,
    retainedAssertions: retainedAssertions.map((entry) => entry.reason),
  };
}

/** A short, factual description of an assertion, for prose that accompanies it. */
function describeAssertion(assertion: StructuredAssertion): string {
  switch (assertion.type) {
    case 'url-path':
      return `the path is ${assertion.expectedPath}`;
    case 'url-origin':
      return `the origin is ${assertion.expectedOrigin}`;
    case 'text-contains':
      return `the page contains "${assertion.expectedText}"`;
    default:
      return `the ${assertion.type.replace('-', ' ')} target is present`;
  }
}

/** Deterministic, local, heuristic planner - the Build 2 default. */
export class HeuristicJourneyPlanner implements JourneyPlanner {
  plan(input: JourneyPlannerInput): JourneyPlan {
    const goal = input.goal;
    const normalizedGoal = normalizeGoal(goal);
    const classification = classifyGoal(normalizedGoal);
    const journeyType = classification.journeyType;

    const elements = extractElements(input.scout);
    const goalTokens = new Set(tokenize(normalizedGoal));
    const roles: readonly RoleSpec[] = rolesForJourney(journeyType);
    const matches = matchRoles(elements, roles, goalTokens);

    const { steps, inertReasons, assertionRationale, removedAssertions, retainedAssertions } = buildSteps(
      journeyType,
      templatesFor(journeyType),
      matches,
      input.scoutPath,
      input.scout,
    );

    const { warnings, missingInformation, assumptions } = deriveDiagnostics({
      journeyType,
      classification,
      matches,
      roles,
      steps,
      elements,
      normalizedGoal,
      inertReasons,
      assertionRationale,
      removedAssertions,
      retainedAssertions,
    });

    return {
      schemaVersion: JOURNEY_SCHEMA_VERSION,
      goal,
      normalizedGoal,
      journeyType,
      target: {
        url: input.scout.target.inputUrl,
        finalUrl: input.scout.target.finalUrl ?? null,
        title: input.scout.target.title ?? '',
      },
      steps,
      assumptions,
      warnings,
      missingInformation,
      planner: {
        mode: 'heuristic',
        version: TOOL_VERSION,
      },
    };
  }
}

/** Everything the diagnostics pass needs. */
interface DiagnosticInput {
  journeyType: JourneyType;
  classification: ReturnType<typeof classifyGoal>;
  matches: Map<ElementRole, RoleMatch>;
  roles: readonly RoleSpec[];
  steps: readonly JourneyStep[];
  elements: ReturnType<typeof extractElements>;
  normalizedGoal: string;
  /** Why a matched step stayed observational instead of becoming an action. */
  inertReasons: readonly { intent: string; reason: string; detail: string }[];
  /** Why a structured assertion was generated, when one was. */
  assertionRationale: string | null;
  /** Placeholder assertions a postcondition made redundant. */
  removedAssertions: readonly string[];
  /** Why any surviving placeholder was kept. */
  retainedAssertions: readonly string[];
}

/** Deduplicate while preserving first-seen order, for stable serialisation. */
function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * Derive assumptions, warnings and missing-information from what matched.
 *
 * This is where the planner refuses to guess: every unresolved prerequisite
 * becomes an explicit entry rather than a silent omission.
 */
function deriveDiagnostics(input: DiagnosticInput): {
  assumptions: string[];
  warnings: string[];
  missingInformation: string[];
} {
  const { journeyType, classification, matches, roles, steps, elements, inertReasons, assertionRationale, removedAssertions, retainedAssertions } =
    input;
  const assumptions: string[] = [];
  const warnings: string[] = [];
  const missingInformation: string[] = [];

  // --- steps that stayed observational despite a match ---------------------
  for (const inert of inertReasons) {
    warnings.push(`Step "${inert.intent}" stays observational (${inert.reason}): ${inert.detail}`);
  }

  // --- goal-level ambiguity ------------------------------------------------
  if (classification.ambiguous) {
    const others = classification.matches.filter((match) => match !== journeyType);
    warnings.push(
      `The goal matched more than one journey category (${classification.matches.join(', ')}). ` +
        `It was classified as "${journeyType}" by keyword priority; consider stating the goal more specifically.`,
    );
    if (others.length > 0) {
      assumptions.push(`Ambiguous goal resolved to "${journeyType}" over ${others.map((o) => `"${o}"`).join(', ')}.`);
    }
  }
  if (classification.unmatched) {
    warnings.push(
      'The goal matched no known journey category, so a generic plan was produced. ' +
        'Re-run with a more specific goal, for example "try to complete checkout".',
    );
  }

  // --- per-role diagnostics ------------------------------------------------
  for (const role of roles) {
    const match = matches.get(role.role);
    if (!match) continue;

    const label = ROLE_LABELS[role.role] ?? role.role;

    // Hidden and disabled matches are reported even when a usable candidate was
    // found. A control that exists but cannot be interacted with is a real
    // signal - a hidden "Checkout" button can mean the page is mid-flow.
    if (match.hidden.length > 0) {
      warnings.push(
        `A ${label} was found but is hidden in the Scout report (${match.hidden
          .slice(0, 3)
          .map((candidate) => candidate.elementId)
          .join(', ')}), so it cannot be planned as a user-facing control.`,
      );
    }
    if (match.disabled.length > 0) {
      warnings.push(
        `A ${label} was found but is disabled in the Scout report (${match.disabled
          .slice(0, 3)
          .map((candidate) => candidate.elementId)
          .join(', ')}), so it cannot be planned as an available control.`,
      );
    }

    if (match.ambiguous) {
      const tied = match.candidates.filter((candidate) => candidate.score === match.candidates[0]?.score);
      warnings.push(
        `Multiple ${label} elements matched the goal equally well (${tied.map((candidate) => candidate.elementId).join(', ')}). ` +
          'The plan references all candidates; a human or a later build must disambiguate.',
      );
    }
  }

  // --- journey prerequisites ----------------------------------------------
  if (requiresCredentials(journeyType)) {
    missingInformation.push('Test credentials are required before this journey can be executed.');
  }
  if (requiresPayment(journeyType)) {
    missingInformation.push('A safe test payment method is required before this journey can be executed.');
    warnings.push('This journey reaches a payment step. No payment data is captured, and no claim is made that payment is safe or available.');
  }
  if (journeyType === 'checkout' || journeyType === 'purchase' || journeyType === 'ticket_purchase') {
    missingInformation.push('The intended product, event, or ticket was not specified in the goal.');
  }

  // --- page-state limitations ---------------------------------------------
  if (elements.length === 0) {
    warnings.push('The Scout report contains no interactive elements, so no controls could be matched.');
  }
  if (!input.normalizedGoal) {
    warnings.push('The goal was empty, so the plan is based only on the page structure.');
  }

  // Every journey ends in an "expected outcome" step the Scout data cannot
  // confirm. Say so once, rather than implying the outcome is known.
  const outcomeStep = steps[steps.length - 1];
  if (outcomeStep && outcomeStep.action === 'assert') {
    missingInformation.push('The application state after the final step is unknown from the Scout report.');
  }

  // --- low overall confidence ---------------------------------------------
  const planConfidence = overallConfidence(
    steps.map((step) => ({ confidence: step.confidence, isRequired: step.targetElementIds.length > 0 })),
  );
  if (isLowConfidence(planConfidence)) {
    warnings.push(
      `Overall plan confidence is low (${confidenceBand(planConfidence)}, ${planConfidence.toFixed(2)}). ` +
        'Re-scout a more specific page, or supply a more specific goal, before relying on this plan.',
    );
  }

  // --- assumptions about what was matched ----------------------------------
  const matchedRoles = [...matches.values()].filter((match) => match.candidates.length > 0);
  if (matchedRoles.length > 0) {
    assumptions.push(
      `Matched ${matchedRoles.length} of ${roles.length} relevant control role(s) from the Scout report using label, name, type, and visible-text heuristics.`,
    );
  }
  assumptions.push('Element visibility and enabled state are taken from the Scout report as captured, not re-verified.');
  assumptions.push('Step actions are descriptive only; Build 2 does not execute any step.');

  if (assertionRationale !== null) {
    assumptions.push(`Structured assertion derived from Scout evidence: ${assertionRationale}`);
  }

  // Build 6.4: say plainly what happened to the terminal expectation, so a
  // reader can tell a removed placeholder from an overlooked one.
  if (removedAssertions.length > 0) {
    assumptions.push(
      'Removed a generic terminal assertion because a structured postcondition on the same journey already measures that outcome.',
    );
  }
  for (const reason of retainedAssertions) {
    assumptions.push(`Kept the terminal expectation: ${reason}`);
  }

  return {
    assumptions: dedupe(assumptions),
    warnings: dedupe(warnings),
    missingInformation: dedupe(missingInformation),
  };
}

/** The planner used by default by the CLI and by tests. */
export const defaultJourneyPlanner: JourneyPlanner = new HeuristicJourneyPlanner();

/** Convenience wrapper: plan from a goal and a validated Scout report. */
export function planJourney(
  goal: string,
  scout: ScoutReport,
  scoutPath: string,
  planner: JourneyPlanner = defaultJourneyPlanner,
): JourneyPlan {
  return planner.plan({ goal, scout, scoutPath });
}
