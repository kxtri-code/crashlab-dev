/**
 * Action dispatcher.
 *
 * Maps a plan step's descriptive `action` onto controlled Playwright behaviour.
 * Build 2 wrote these actions as labels; this is the only place they become
 * something that touches a page.
 *
 * Rules that hold for every action:
 *  - the target comes only from the plan's `locatorCandidates`
 *  - a missing or ambiguous target blocks the step; it is never worked around
 *  - no value is ever invented, and a value the executor typed is never
 *    recorded
 *  - nothing is retried
 */

import type { JourneyAction, JourneyStep } from '../journey/types.js';
import type { Locator } from 'playwright';
import { join } from 'node:path';
import { resolveStepTarget } from './locatorResolver.js';
import { classifyAssertion } from './assertionClassifier.js';
import { evaluateStructuredAssertion } from './structuredAssertionRunner.js';
import type { AssertionOutcome } from './structuredAssertionRunner.js';
import type { BlockReason, SkipReason, StepObservations } from './types.js';
import { resolveFixturePath, resolveValue } from './testData.js';
import type { ExecutionContext } from './executionContext.js';
import { redactMessage } from './redaction.js';

/** A single action handler. */
type ActionHandler = (step: JourneyStep, context: ExecutionContext) => Promise<ActionOutcome>;

/** An empty observation, for a step that resolved nothing. */
function noObservations(): null {
  return null;
}

/** Wrap a thrown error as a redacted failure outcome. */
function failure(context: ExecutionContext, step: JourneyStep, error: unknown): ActionOutcome {
  const message = redactMessage(error instanceof Error ? error.message : String(error), context.scrub);
  return { status: 'failed', reason: 'action-failed', message: `Step "${step.id}" failed: ${message}` };
}

/**
 * Read a locator's visible text for the payment guard.
 *
 * Returns null rather than throwing when the page is gone or the text is
 * unreadable: the guard treats a missing text as no evidence, not as a pass.
 */
async function safeText(locator: Locator): Promise<string | null> {
  try {
    return await locator.first().textContent({ timeout: 1000 });
  } catch {
    return null;
  }
}

/** The narrowed success branch of a locator resolution. */
type ResolvedTarget = Extract<Awaited<ReturnType<typeof resolveStepTarget>>, { ok: true }>;

/**
 * Resolve a step's target, or return the outcome that prevented it.
 *
 * A step with no locator candidates is *skipped*, not blocked: there is simply
 * nothing to act on, which is a legitimate result of a plan that matched
 * nothing. Blocking would refuse on safety grounds and, under the stop policy,
 * would abort a run that could still make progress on later steps.
 */
async function resolveOrBlock(
  step: JourneyStep,
  context: ExecutionContext,
  intent: 'observe' | 'interact',
): Promise<{ outcome: ActionOutcome } | { target: ResolvedTarget }> {
  const resolution = await resolveStepTarget(context.page, step, intent);
  if (!resolution.ok) {
    if (resolution.reason === 'no-locator-provided') {
      return {
        outcome: {
          status: 'skipped',
          reason: resolution.reason,
          skipReason: 'no-target',
          message: resolution.message,
          observations: null,
        },
      };
    }
    return {
      outcome: {
        status: 'blocked',
        reason: resolution.reason,
        message: resolution.message,
        observations: resolution.observations,
      },
    };
  }
  return { target: resolution };
}

// --- observe / identify ---------------------------------------------------

/**
 * Observe a control without touching it.
 *
 * Passing means the control was found. A hidden or disabled control still
 * passes, because reporting "present but unusable" is the useful result.
 */
const observe: ActionHandler = async (step, context) => {
  const resolved = await resolveOrBlock(step, context, 'observe');
  if ('outcome' in resolved) return resolved.outcome;

  return {
    status: 'passed',
    observations: resolved.target.observations,
    selectedLocator: resolved.target.selectedLocator,
    message: `Observed ${resolved.target.selectedLocator}: ${describeObservations(resolved.target.observations)}.`,
  };
};

/**
 * Identify the intended control and record which candidate was chosen.
 *
 * Ambiguity blocks rather than picking: choosing one of several identical
 * candidates would make the run depend on document order.
 */
const identify: ActionHandler = async (step, context) => {
  const resolved = await resolveOrBlock(step, context, 'observe');
  if ('outcome' in resolved) return resolved.outcome;

  const observations = resolved.target.observations;
  return {
    status: 'passed',
    observations,
    selectedLocator: resolved.target.selectedLocator,
    message:
      `Identified a unique target via ${resolved.target.selectedLocator} ` +
      `(${observations?.tag ?? 'unknown tag'}, ${describeObservations(observations)}).`,
  };
};

// --- click ----------------------------------------------------------------

const click: ActionHandler = async (step, context) => {
  // Resolve first so the payment guard can also read the live control's text;
  // the guard still runs before any click happens.
  const resolved = await resolveOrBlock(step, context, 'interact');
  if ('outcome' in resolved) return resolved.outcome;

  const paymentGuard = context.guardPayment(step, await safeText(resolved.target.locator));
  if (paymentGuard) return paymentGuard;

  const urlBefore = context.currentUrl();
  try {
    await resolved.target.locator.click({ timeout: context.timeoutMs, noWaitAfter: false });
  } catch (error) {
    return failure(context, step, error);
  }

  // A click can navigate, so give the page a brief settle before reading state.
  await context.page.waitForLoadState('domcontentloaded', { timeout: context.timeoutMs }).catch(() => undefined);
  const urlAfter = context.currentUrl();
  const originGuard = context.guardOrigin(urlAfter, step);
  if (originGuard) return { ...originGuard, observations: resolved.target.observations };

  return {
    status: 'passed',
    observations: resolved.target.observations,
    selectedLocator: resolved.target.selectedLocator,
    message:
      `Clicked ${resolved.target.selectedLocator}. ` +
      (urlBefore === urlAfter ? 'The URL did not change.' : `The URL changed from ${urlBefore} to ${urlAfter}.`),
  };
};

// --- fill -----------------------------------------------------------------

/**
 * Type a value into a field.
 *
 * Requires explicit test data. There is no default, no placeholder, and no
 * "fill it with something plausible" path: a missing value blocks the step.
 */
const fill: ActionHandler = async (step, context) => {
  const resolved = await resolveOrBlock(step, context, 'interact');
  if ('outcome' in resolved) return resolved.outcome;

  // A fill into a payment field is blocked as well as a payment click: typing a
  // card number is a step toward a charge even if the submit is never reached.
  const paymentGuard = context.guardPayment(step, await safeText(resolved.target.locator));
  if (paymentGuard) return paymentGuard;

  const lookup = resolveValue(context.testData, { elementIds: step.targetElementIds, intent: step.intent });
  if (!lookup.found) {
    return {
      status: 'blocked',
      reason: 'missing-test-data',
      message:
        `Step "${step.id}" needs a value for ${resolved.target.selectedLocator}, but the test data has no entry for ` +
        `any of: ${lookup.triedKeys.join(', ')}. The executor does not invent a value.`,
      observations: resolved.target.observations,
    };
  }

  try {
    await resolved.target.locator.fill(lookup.value as string, { timeout: context.timeoutMs });
  } catch (error) {
    return failure(context, step, error);
  }

  return {
    status: 'passed',
    observations: resolved.target.observations,
    selectedLocator: resolved.target.selectedLocator,
    // The value itself is never echoed, only that one was supplied.
    message: `Filled ${resolved.target.selectedLocator} using test data key "${lookup.key}". Value redacted.`,
    notes: [`dataKey=${lookup.key}`, 'valueRedacted=true'],
  };
};

// --- select ---------------------------------------------------------------

/** Choose an option by its visible label. Requires an explicit label. */
const select: ActionHandler = async (step, context) => {
  const resolved = await resolveOrBlock(step, context, 'interact');
  if ('outcome' in resolved) return resolved.outcome;

  const lookup = resolveValue(context.testData, { elementIds: step.targetElementIds, intent: step.intent });
  if (!lookup.found) {
    return {
      status: 'blocked',
      reason: 'missing-test-data',
      message:
        `Step "${step.id}" needs an option to select, but the test data has no entry for any of: ${lookup.triedKeys.join(', ')}. ` +
        'The executor will not pick the first option, because the first option is not necessarily a valid choice.',
      observations: resolved.target.observations,
    };
  }

  try {
    // A short budget: an unrecognised option label cannot become valid, so
    // waiting out the full step timeout would only delay the refusal.
    await resolved.target.locator.selectOption({ label: lookup.value as string }, { timeout: 2000 });
  } catch (error) {
    return {
      status: 'failed',
      reason: 'action-failed',
      message: redactMessage(
        `Step "${step.id}" could not select option "${lookup.key}": ${error instanceof Error ? error.message : String(error)}`,
        context.scrub,
      ),
    };
  }

  return {
    status: 'passed',
    observations: resolved.target.observations,
    selectedLocator: resolved.target.selectedLocator,
    message: `Selected an option in ${resolved.target.selectedLocator} using test data key "${lookup.key}".`,
    notes: [`dataKey=${lookup.key}`],
  };
};

// --- upload ---------------------------------------------------------------

/** Attach a local test fixture to a file input. */
const upload: ActionHandler = async (step, context) => {
  const resolved = await resolveOrBlock(step, context, 'interact');
  if ('outcome' in resolved) return resolved.outcome;

  const lookup = resolveValue(context.testData, { elementIds: step.targetElementIds, intent: step.intent });
  if (!lookup.found) {
    return {
      status: 'blocked',
      reason: 'missing-test-data',
      message:
        `Step "${step.id}" needs a file to upload, but the test data has no entry for any of: ${lookup.triedKeys.join(', ')}. ` +
        'The executor will not upload an arbitrary file.',
      observations: resolved.target.observations,
    };
  }

  // Uploads are confined to a declared fixture root, so a path in test data can
  // never point at an arbitrary file on the machine. Defaulting to the fixtures
  // directory rather than the working directory keeps the blast radius small.
  const allowedRoot = process.env.CRASHLAB_FIXTURE_ROOT?.trim() || join('tests', 'fixtures');
  let absolute: string;
  try {
    absolute = resolveFixturePath(lookup.value as string, allowedRoot);
  } catch (error) {
    return {
      status: 'blocked',
      reason: 'unsafe-test-file',
      message: redactMessage(error instanceof Error ? error.message : String(error), context.scrub),
      observations: resolved.target.observations,
    };
  }

  try {
    await resolved.target.locator.setInputFiles(absolute, { timeout: context.timeoutMs });
  } catch (error) {
    return failure(context, step, error);
  }

  return {
    status: 'passed',
    observations: resolved.target.observations,
    selectedLocator: resolved.target.selectedLocator,
    message: `Attached a file to ${resolved.target.selectedLocator} using test data key "${lookup.key}".`,
    notes: [`dataKey=${lookup.key}`],
  };
};

// --- submit ---------------------------------------------------------------

/**
 * Submit a form through its designated control.
 *
 * A submission is not a verdict: the step records what happened, and says
 * nothing about whether the outcome was correct.
 */
const submit: ActionHandler = async (step, context) => {
  const resolved = await resolveOrBlock(step, context, 'interact');
  if ('outcome' in resolved) return resolved.outcome;

  const paymentGuard = context.guardPayment(step, await safeText(resolved.target.locator));
  if (paymentGuard) return paymentGuard;

  const urlBefore = context.currentUrl();
  try {
    await resolved.target.locator.click({ timeout: context.timeoutMs });
  } catch (error) {
    return failure(context, step, error);
  }
  await context.page.waitForLoadState('domcontentloaded', { timeout: context.timeoutMs }).catch(() => undefined);

  const urlAfter = context.currentUrl();
  const originGuard = context.guardOrigin(urlAfter, step);
  if (originGuard) return { ...originGuard, observations: resolved.target.observations };

  return {
    status: 'passed',
    observations: resolved.target.observations,
    selectedLocator: resolved.target.selectedLocator,
    message:
      `Submitted via ${resolved.target.selectedLocator}. ` +
      (urlBefore === urlAfter ? 'The URL did not change after submission.' : `The URL changed from ${urlBefore} to ${urlAfter}.`),
  };
};

// --- navigate -------------------------------------------------------------

/**
 * Navigate to a URL already present in the plan.
 *
 * Free text in `expectedOutcome` is never parsed into a URL, and a step with no
 * URL in the plan is blocked rather than guessed at.
 */
const navigate: ActionHandler = async (step, context) => {
  const candidates = collectPlanUrls(step, context);
  if (candidates.length === 0) {
    return {
      status: 'blocked',
      reason: 'no-navigation-target',
      message:
        `Step "${step.id}" has no navigable URL in the plan. The executor will not derive a URL from ` +
        'free text such as the expectedOutcome description.',
    };
  }

  const urlBefore = context.currentUrl();
  const target = candidates[0] as string;
  if (!context.isSameOrigin(target)) {
    return {
      status: 'blocked',
      reason: 'external-origin-blocked',
      message: `Step "${step.id}" targets ${target}, which is outside the authorized origin ${context.origin ?? 'unknown'}.`,
    };
  }

  try {
    await context.page.goto(target, { waitUntil: 'domcontentloaded', timeout: context.timeoutMs });
  } catch (error) {
    return failure(context, step, error);
  }

  const urlAfter = context.currentUrl();
  return {
    status: 'passed',
    message: `Navigated from ${urlBefore} to ${urlAfter}.`,
  };
};

// --- assert ---------------------------------------------------------------

/**
 * Deterministic assertions only.
 *
 * The plan's `expectedOutcome` is prose written for a human, so it is never
 * interpreted. The only assertion Build 2 structures well enough to check is
 * that a target it identified is actually present. Anything else is reported
 * as unsupported rather than guessed at.
 */
/**
 * What an action handler returns.
 *
 * `skipped` is distinct from `blocked`: a step that had nothing to act on, or
 * whose expectation was not machine-readable, is a legitimate observation, not
 * a refusal, and must not stop the run.
 */
export interface ActionOutcome {
  status: 'passed' | 'failed' | 'blocked' | 'skipped';
  reason?: BlockReason;
  message?: string;
  observations?: StepObservations | null;
  /** The plan string that was actually used, when a target was resolved. */
  selectedLocator?: string | null;
  /** Why the step was skipped, when skipping is the honest outcome. */
  skipReason?: SkipReason | null;
  /** Present when the step's expectation could not be evaluated. */
  verification?: { status: 'unverified'; reason: string } | null;
  /** Build 6.2: the outcome of a structured assertion, when one was evaluated. */
  assertion?: AssertionOutcome | null;
  /** Extra detail recorded alongside the step, always redacted. */
  notes?: string[];
}

/**
 * A prose assertion is skipped and marked unverified, never blocked.
 *
 * Blocking it was Build 3's original choice, and it was wrong: a block is a
 * refusal on safety grounds and it aborted the whole run, so a journey whose
 * executable steps all succeeded was recorded as a failure. An unverified
 * expectation is neither a refusal nor a failure - nobody evaluated it.
 */
const assertStep: ActionHandler = async (step, context) => {
  // Build 6.2: a structured assertion is checked when the page allows it.
  const structured = await evaluateStructuredAssertion(context.page, step);
  if (structured !== null) {
    if (structured.result === 'unevaluable') {
      // Not checkable is not a failure. Skipped and unverified, as Build 6.1
      // treats any expectation nobody could evaluate.
      return {
        status: 'skipped',
        skipReason: 'unsupported-prose-assertion',
        message: `Step "${step.id}" could not be evaluated: ${structured.message}`,
        verification: { status: 'unverified', reason: structured.unevaluableReason ?? 'unevaluable-assertion' },
      };
    }
    if (structured.result === 'not-matched') {
      // Evaluated and not satisfied. That is a real result, but not a verdict.
      return {
        status: 'failed',
        reason: 'action-failed',
        message: `Step "${step.id}" assertion not satisfied: ${structured.message}`,
        observations: null,
        assertion: structured,
      };
    }
    return {
      status: 'passed',
      observations: null,
      message: `Step "${step.id}" assertion satisfied: ${structured.message}`,
      assertion: structured,
    };
  }

  const verdict = classifyAssertion(step);

  if (verdict.kind === 'prose-only' || verdict.kind === 'targeted-prose') {
    return {
      status: 'skipped',
      skipReason: verdict.skipReason,
      message: `Step "${step.id}" was not evaluated: ${verdict.reason}`,
      verification: { status: 'unverified', reason: verdict.reason },
    };
  }

  // A structured assertion could not be built, but the step still carries a
  // target: Build 3's deterministic presence check applies as before.
  const resolution = await resolveStepTarget(context.page, step, 'observe');
  if (!resolution.ok) {
    return {
      status: 'failed',
      reason: resolution.reason,
      message: resolution.message,
      observations: resolution.observations,
    };
  }

  return {
    status: 'passed',
    observations: resolution.observations,
    selectedLocator: resolution.selectedLocator,
    message: `Asserted that ${resolution.selectedLocator} is present.`,
  };
};

/** Human-readable summary of an observation block. */
function describeObservations(observations: { exists: boolean; visible: boolean; enabled: boolean } | null): string {
  if (!observations || !observations.exists) return 'not present';
  const parts = [observations.visible ? 'visible' : 'not visible', observations.enabled ? 'enabled' : 'disabled'];
  return parts.join(', ');
}

/** URLs the plan itself states for a navigate step. */
function collectPlanUrls(step: JourneyStep, context: ExecutionContext): string[] {
  const urls: string[] = [];
  // The journey's own target is always a legitimate navigation destination.
  if (step.targetElementIds.length === 0 && step.locatorCandidates.length === 0) {
    urls.push(context.plan.target.url);
  }
  // A navigate step may name its destination as a bare URL in a locator
  // candidate, which the planner can emit as `page.locator(...)`. Anything else
  // is ignored rather than parsed.
  for (const candidate of step.locatorCandidates) {
    if (/^https?:\/\//i.test(candidate.trim())) urls.push(candidate.trim());
  }
  return [...new Set(urls)];
}

/** Every action the executor implements. */
const HANDLERS: Record<JourneyAction, ActionHandler> = {
  observe,
  navigate,
  identify,
  click,
  fill,
  select,
  upload,
  submit,
  assert: assertStep,
};

/** True when the executor knows how to perform an action. */
export function supportsAction(action: string): action is JourneyAction {
  return action in HANDLERS;
}

/**
 * Perform one step. Never throws: a handler failure becomes a `failed` result.
 */
export async function dispatchAction(step: JourneyStep, context: ExecutionContext): Promise<ActionOutcome> {
  const handler = HANDLERS[step.action];
  if (!handler) {
    return {
      status: 'blocked',
      reason: 'locator-unsupported',
      message: `Step "${step.id}" uses unsupported action "${step.action}".`,
    };
  }
  try {
    return await handler(step, context);
  } catch (error) {
    return failure(context, step, error);
  }
}

export { noObservations };
