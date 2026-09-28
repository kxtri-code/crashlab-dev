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
} from './types.js';
import { JOURNEY_SCHEMA_VERSION, confidenceBand } from './types.js';
import { normalizeGoal, tokenize } from './goal.js';
import { classifyGoal } from './classify.js';
import { bestCandidate, confidenceForMatch, isLowConfidence, overallConfidence } from './confidence.js';
import { matchRoles, requiresCredentials, requiresPayment, rolesForJourney } from './match.js';
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
          actionable: 'click',
          requiredText: SUBMIT_ACTION_TEXTS,
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

/** Build the ordered, `executable: false` steps for a journey. */
function buildSteps(
  journeyType: JourneyType,
  templates: readonly StepTemplate[],
  matches: Map<ElementRole, RoleMatch>,
  scoutPath: string,
): { steps: JourneyStep[]; inertReasons: { intent: string; reason: string; detail: string }[] } {
  const inertReasons: { intent: string; reason: string; detail: string }[] = [];

  const steps = templates.map((template, position) => {
    const match = template.role ? (matches.get(template.role) ?? null) : null;
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

    return {
      id: `step-${String(position + 1).padStart(3, '0')}`,
      order: position + 1,
      intent: template.intent,
      action: decision.action,
      description,
      targetElementIds,
      locatorCandidates,
      expectedOutcome,
      confidence: Math.round(confidence * 100) / 100,
      // Build 2 never executes. Build 3 may transform these descriptions.
      executable: false,
      source: {
        report: scoutPath,
        elementIds: targetElementIds,
      },
    } satisfies JourneyStep;
  });

  return { steps, inertReasons };
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

    const { steps, inertReasons } = buildSteps(journeyType, templatesFor(journeyType), matches, input.scoutPath);

    const { warnings, missingInformation, assumptions } = deriveDiagnostics({
      journeyType,
      classification,
      matches,
      roles,
      steps,
      elements,
      normalizedGoal,
      inertReasons,
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
  const { journeyType, classification, matches, roles, steps, elements, inertReasons } = input;
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
