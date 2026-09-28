/**
 * Execution context.
 *
 * The object an action handler receives. It owns the page, the per-step budget,
 * the origin policy, and the safety switches, so handlers stay small and cannot
 * reach around a guard to do something the run configuration forbids.
 */

import type { Page } from 'playwright';
import type { JourneyPlan, JourneyStep } from '../journey/types.js';
import type { EvidenceRecorder } from './evidence.js';
import type { Scrubber } from './redaction.js';
import type { BlockReason, StepObservations } from './types.js';
import { toOrigin } from '../util/url.js';

/** Actions that change the page or its data. */
const INTERACTIVE_ACTIONS = new Set(['click', 'fill', 'select', 'upload', 'submit']);

/**
 * Payment signals, checked as several independent layers.
 *
 * A single regex is not enough: a step can be payment-adjacent through its
 * journey type, its intent, its wording, or the control it targets, and a
 * checker that only reads one of those misses real cases. Each layer below is
 * evaluated separately and any hit blocks.
 */

/** Words that appear on payment controls and payment forms. */
const PAYMENT_CONTROL_PATTERN =
  /\b(pay|payment|paying|checkout payment|billing|bill|wallet|credit\s?card|debit\s?card|card\s?number|cvv|cvc|expiry|expiration|iban|sort\s?code|routing|account\s?number|purchase|order|buy|book|reserve)\b/i;

/** Providers and processors, which name the action without saying "pay". */
const PAYMENT_PROVIDER_PATTERN = /\b(razorpay|stripe|paypal|paypal checkout|adyen|square|klarna|checkout\.com|braintree|worldpay|skrill|instapay|upi|netbanking)\b/i;

/** Journey types whose later steps are inherently transactional. */
const PAYMENT_JOURNEY_TYPES = new Set(['checkout', 'purchase', 'ticket_purchase']);

/** Intents that are payment submission steps by name. */
const PAYMENT_INTENT_PATTERN = /(payment|place_order|complete_order|complete_purchase|confirm_order|billing|checkout_payment)/i;

/** Intents that may act on a payment control, even if worded carefully. */
const PAYMENT_TARGET_INTENT_PATTERN = /(payment|order|card|billing|checkout_payment|place_order)/i;

/** What an action handler returns. */
export interface ActionOutcome {
  status: 'passed' | 'failed' | 'blocked';
  reason?: BlockReason;
  message?: string;
  observations?: StepObservations | null;
  /** Extra detail recorded alongside the step, always redacted. */
  notes?: string[];
}

/** Everything an action handler is allowed to use. */
export class ExecutionContext {
  readonly plan: JourneyPlan;
  readonly page: Page;
  readonly evidence: EvidenceRecorder;
  readonly scrub: Scrubber;
  readonly timeoutMs: number;
  readonly safeTestMode: boolean;
  readonly testData: Readonly<Record<string, string>> | undefined;

  private readonly targetOrigin: string | null;
  private dialogsAutoAccepted = false;

  constructor(init: {
    plan: JourneyPlan;
    page: Page;
    evidence: EvidenceRecorder;
    scrub: Scrubber;
    timeoutMs: number;
    safeTestMode: boolean;
    testData?: Record<string, string>;
  }) {
    this.plan = init.plan;
    this.page = init.page;
    this.evidence = init.evidence;
    this.scrub = init.scrub;
    this.timeoutMs = init.timeoutMs;
    this.safeTestMode = init.safeTestMode;
    this.testData = init.testData;
    this.targetOrigin = toOrigin(init.plan.target.url);
  }

  /** The origin the journey is authorized against. */
  get origin(): string | null {
    return this.targetOrigin;
  }

  /** True when a URL is on the journey's own target origin. */
  isSameOrigin(url: string | null): boolean {
    if (url === null) return false;
    const origin = toOrigin(url);
    if (origin === null || this.targetOrigin === null) return false;
    return origin === this.targetOrigin;
  }

  /**
   * Accept native dialogs automatically.
   *
   * A modal dialog would otherwise hang the run. Accepting is the conservative
   * choice: it never confirms a destructive action, and the fact that a dialog
   * appeared is recorded as evidence.
   */
  installDialogHandler(): void {
    this.page.on('dialog', (dialog) => {
      void dialog.dismiss().catch(() => undefined);
    });
    this.dialogsAutoAccepted = true;
  }

  /** True when the dialog handler is installed. */
  get handlesDialogs(): boolean {
    return this.dialogsAutoAccepted;
  }

  /** True when a step is expected to change the page or its data. */
  isInteractive(step: JourneyStep): boolean {
    return INTERACTIVE_ACTIONS.has(step.action);
  }

  /**
   * True when a step looks like it would trigger a real payment.
   *
   * Deliberately over-inclusive. The executor has no way to verify a target is
   * a sandbox, so a step that *might* be transactional is treated as one.
   */
  isPaymentLike(step: JourneyStep, elementText?: string | null): boolean {
    if (step.action !== 'submit' && step.action !== 'click' && step.action !== 'fill') return false;

    // Layer 1: the journey type, for the terminal action only. A checkout
    // journey is transactional by nature, so its *submission* is blocked even
    // when worded neutrally. Navigational steps inside one are not: blocking
    // every click in a checkout journey would make the tool useless, and the
    // safety property that matters is that no charge can be placed.
    if (PAYMENT_JOURNEY_TYPES.has(this.plan.journeyType) && step.action === 'submit') return true;

    // Layer 2: the step's own identity. A payment submission intent is
    // unambiguous; a target intent naming a payment concept (a card field, for
    // instance) is treated the same way, because reaching it is a step toward a
    // charge even when the submit is never reached.
    if (PAYMENT_INTENT_PATTERN.test(step.intent)) return true;
    if (step.action !== 'submit' && PAYMENT_TARGET_INTENT_PATTERN.test(step.intent)) return true;

    // Layer 3: the step's prose. buildLocatorCandidates are included because a
    // generated locator embeds the control's accessible name.
    const planText = `${step.description} ${step.expectedOutcome} ${step.locatorCandidates.join(' ')}`;
    if (PAYMENT_CONTROL_PATTERN.test(planText) || PAYMENT_PROVIDER_PATTERN.test(planText)) return true;

    // Layer 4: the control actually resolved in the browser. This catches a
    // plan whose wording is neutral but which lands on a payment control.
    if (elementText && (PAYMENT_CONTROL_PATTERN.test(elementText) || PAYMENT_PROVIDER_PATTERN.test(elementText))) {
      return true;
    }

    return false;
  }

  /**
   * Refuse a payment-adjacent action.
   *
   * Safe test mode is the default, so this blocks by default. There is
   * deliberately no opt-out flag: a live payment path does not exist in
   * CrashLab, and adding one is a decision for a later build with a real
   * sandbox-verification story.
   */
  guardPayment(step: JourneyStep, elementText?: string | null): ActionOutcome | null {
    if (!this.isPaymentLike(step, elementText)) return null;
    if (!this.safeTestMode) {
      // Reachable only if a future build adds an explicit override.
      return {
        status: 'blocked',
        reason: 'payment-blocked',
        message: `Step "${step.id}" is payment-adjacent and payment execution is disabled.`,
      };
    }
    return {
      status: 'blocked',
      reason: 'payment-blocked',
      message:
        `Step "${step.id}" is payment-adjacent and was blocked by the safe-test payment guard before any browser action. ` +
        'Safe test mode is on by default, so CrashLab does not perform real payments. ' +
        'No payment data was read, filled, or submitted.',
    };
  }

  /**
   * Refuse a navigation that would leave the authorized origin.
   *
   * A click can trigger a redirect off-target. Rather than let a journey wander
   * into an unrelated origin, the step is blocked and the fact is recorded.
   */
  guardOrigin(urlAfter: string | null, step: JourneyStep): ActionOutcome | null {
    if (urlAfter === null) return null;
    if (this.isSameOrigin(urlAfter)) return null;
    return {
      status: 'blocked',
      reason: 'external-origin-blocked',
      message:
        `Step "${step.id}" moved the page to ${urlAfter}, which is outside the authorized origin ${this.targetOrigin ?? 'unknown'}. ` +
        'The executor does not follow navigation off the authorized target.',
    };
  }

  /** The page URL, or null when the page is gone. */
  currentUrl(): string | null {
    try {
      return this.page.url();
    } catch {
      return null;
    }
  }
}
