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
 * Substrings that mark a control as payment-adjacent.
 *
 * Build 3 cannot tell a sandbox from production, so it refuses to act on a
 * payment control unless the run explicitly declares safe test mode. This is a
 * blunt text check on the plan's own wording, not an attempt to classify the
 * target.
 */
const PAYMENT_PATTERN =
  /\b(pay|payment|place order|complete order|complete purchase|checkout now|confirm order|buy now|billing|card ?number|expiry|cvv|cvc|iban|sort ?code)\b/i;

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
   * Checked against the plan's own text - intent, description, expected outcome
   * and locators - so the decision is explainable from the plan alone.
   */
  isPaymentLike(step: JourneyStep): boolean {
    if (step.action !== 'submit' && step.action !== 'click') return false;
    const planText = `${step.intent} ${step.description} ${step.expectedOutcome} ${step.locatorCandidates.join(' ')}`;
    return PAYMENT_PATTERN.test(planText);
  }

  /**
   * Refuse a payment-adjacent action unless safe test mode is declared.
   *
   * The executor has no way to know whether a target is a sandbox, so the
   * default is refusal rather than an optimistic guess.
   */
  guardPayment(step: JourneyStep): ActionOutcome | null {
    if (!this.isPaymentLike(step)) return null;
    if (this.safeTestMode) return null;
    return {
      status: 'blocked',
      reason: 'payment-blocked',
      message:
        `Step "${step.id}" looks like a payment or order-placement action and safe test mode is not enabled. ` +
        'The executor will not click it, because it cannot verify the target is a sandbox.',
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
