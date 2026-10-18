/**
 * Evidence capture.
 *
 * Reuses Build 1's `TelemetryRecorder` and `NetworkRecorder` rather than
 * duplicating the Playwright event plumbing, then projects their output into
 * the executor's evidence shapes with redaction applied.
 *
 * Everything captured here is a *fact about the run*, never an interpretation.
 * Whether any of it is anomalous is Build 4's question, not this file's.
 */

import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Page } from 'playwright';
import { NetworkRecorder, markThirdParty } from '../scout/network.js';
import { TelemetryRecorder } from '../scout/telemetry.js';
import type {
  EvidenceConsoleEvent,
  EvidenceNetworkEvent,
  EvidencePageError,
  NetworkEventProvenance,
  StepEvidence,
} from './types.js';
import type { Scrubber } from './redaction.js';
import { redactExecutionUrl, redactMessage } from './redaction.js';

/** Most console messages retained per step. */
const MAX_CONSOLE_PER_STEP = 50;
/** Most page errors retained per step. */
const MAX_PAGE_ERRORS_PER_STEP = 20;
/** Most network events retained per step. */
const MAX_NETWORK_PER_STEP = 60;
/** Most screenshots taken across a whole run. */
export const MAX_SCREENSHOTS = 40;

/** Why a screenshot was not taken. */
export type ScreenshotOmissionReason = 'screenshots-disabled' | 'screenshot-limit-reached' | 'capture-failed' | 'sensitive-data-entered';

/** The result of a screenshot request. */
export interface ScreenshotResult {
  /** Filename relative to the evidence directory, or null when omitted. */
  path: string | null;
  omitted: boolean;
  omittedReason: ScreenshotOmissionReason | null;
}

/**
 * Tracks whether sensitive data has entered the page.
 *
 * Once it has, screenshots stop. This is the safest available behaviour:
 * Playwright's mask covers elements you name, but a page can echo a value
 * anywhere - a confirmation banner, a URL, a hidden input - and a screenshot is
 * a bitmap that JSON redaction cannot reach. Omitting is honest; masking would
 * imply a guarantee that cannot be made.
 */
export class ScreenshotPolicy {
  private entered = false;
  private count = 0;
  private readonly enabled: boolean;

  constructor(init: { enabled: boolean } = { enabled: true }) {
    this.enabled = init.enabled;
  }

  /** True once any test data has been filled, selected, uploaded or clicked. */
  get sensitive(): boolean {
    return this.entered;
  }

  /** Mark the page as carrying sensitive data from here on. */
  markSensitive(): void {
    this.entered = true;
  }

  /**
   * Decide whether a screenshot may be taken, and account for it.
   *
   * Omission is the default once sensitive data has entered the page: an
   * element-mask could cover a known field, but a page can echo a value into a
   * banner, a URL or a hidden input, and no guarantee can be made about a
   * bitmap the way one can be made about a JSON string.
   */
  allow(): { allowed: boolean; reason: ScreenshotOmissionReason | null } {
    if (!this.enabled) return { allowed: false, reason: 'screenshots-disabled' };
    if (this.entered) return { allowed: false, reason: 'sensitive-data-entered' };
    if (this.count >= MAX_SCREENSHOTS) return { allowed: false, reason: 'screenshot-limit-reached' };
    this.count += 1;
    return { allowed: true, reason: null };
  }
}


/** Running total of evidence, plus per-step windows. */
export class EvidenceRecorder {
  private readonly telemetry = new TelemetryRecorder({ maxMessages: 500 });
  private readonly network = new NetworkRecorder({ maxEntries: 500 });
  private readonly scrub: Scrubber;

  private finalUrl: string | null = null;
  private dialogObserved = false;

  private cursorConsole = 0;
  private cursorPageErrors = 0;
  private cursorNetwork = 0;

  constructor(scrub: Scrubber) {
    this.scrub = scrub;
  }

  /** Attach to a page. Must be called before navigation to catch everything. */
  attach(page: Page): void {
    this.telemetry.attach(page);
    this.network.attach(page);
    page.on('dialog', () => {
      this.dialogObserved = true;
    });
  }

  /** Tell the network recorder which URL is the final one, for third-party flags. */
  setFinalUrl(url: string | null): void {
    this.finalUrl = url;
  }

  /** Build 12G.2: Set provenance on the underlying network recorder. */
  setNetworkProvenance(provenance: NetworkEventProvenance): void {
    this.network.setProvenance(provenance);
  }

  /** Consume any events still in flight. */
  settle(): void {
    this.network.settle();
  }

  /** Console events since the last call, redacted. */
  takeConsole(): EvidenceConsoleEvent[] {
    const all = this.telemetry.toMessages();
    const slice = all.slice(this.cursorConsole, this.cursorConsole + MAX_CONSOLE_PER_STEP);
    this.cursorConsole += slice.length;
    return slice.map((entry) => ({
      type: entry.type,
      text: redactMessage(entry.text, this.scrub),
      url: redactExecutionUrl(entry.url, this.scrub),
      line: entry.line,
    }));
  }

  /** Page errors since the last call, redacted. */
  takePageErrors(): EvidencePageError[] {
    const all = this.telemetry.toPageErrors();
    const slice = all.slice(this.cursorPageErrors, this.cursorPageErrors + MAX_PAGE_ERRORS_PER_STEP);
    this.cursorPageErrors += slice.length;
    return slice.map((entry) => ({
      message: redactMessage(entry.message, this.scrub),
      stack: entry.stack ? redactMessage(entry.stack, this.scrub, 600) : null,
    }));
  }

  /** Network events since the last call, redacted. */
  takeNetwork(): EvidenceNetworkEvent[] {
    const all = markThirdParty(this.network.toEntries(), this.finalUrl);
    const slice = all.slice(this.cursorNetwork, this.cursorNetwork + MAX_NETWORK_PER_STEP);
    this.cursorNetwork += slice.length;
    return slice.map((entry) => ({
      method: entry.method,
      url: redactExecutionUrl(entry.url, this.scrub) ?? '',
      path: entry.path,
      status: entry.status,
      resourceType: entry.resourceType,
      durationMs: entry.durationMs,
      thirdParty: entry.thirdParty,
      failure: entry.failure,
      provenance: entry.provenance ?? 'target-triggered',
    }));
  }

  /** True when a native dialog opened at any point in the run. */
  sawDialog(): boolean {
    return this.dialogObserved;
  }

  /** All console events for the whole run, redacted. */
  allConsole(): EvidenceConsoleEvent[] {
    return this.telemetry
      .toMessages()
      .map((entry) => ({
        type: entry.type,
        text: redactMessage(entry.text, this.scrub),
        url: redactExecutionUrl(entry.url, this.scrub),
        line: entry.line,
      }));
  }

  /** All page errors for the whole run, redacted. */
  allPageErrors(): EvidencePageError[] {
    return this.telemetry.toPageErrors().map((entry) => ({
      message: redactMessage(entry.message, this.scrub),
      stack: entry.stack ? redactMessage(entry.stack, this.scrub, 600) : null,
    }));
  }

  /** All network events for the whole run, redacted. */
  allNetwork(): EvidenceNetworkEvent[] {
    return markThirdParty(this.network.toEntries(), this.finalUrl).map((entry) => ({
      method: entry.method,
      url: redactExecutionUrl(entry.url, this.scrub) ?? '',
      path: entry.path,
      status: entry.status,
      resourceType: entry.resourceType,
      durationMs: entry.durationMs,
      thirdParty: entry.thirdParty,
      failure: entry.failure,
      provenance: entry.provenance ?? 'target-triggered',
    }));
  }

  /**
   * Capture a screenshot, subject to the policy and a hard per-run cap.
   *
   * @returns the path relative to the evidence directory, or an omission with a
   * recorded reason. Never throws: a missing screenshot is missing evidence,
   * not a run failure.
   */
  async screenshot(page: Page, name: string, evidenceDir: string, policy: ScreenshotPolicy): Promise<ScreenshotResult> {
    const decision = policy.allow();
    if (!decision.allowed) {
      return { path: null, omitted: true, omittedReason: decision.reason };
    }

    const absolute = join(evidenceDir, `${name}.png`);
    try {
      await mkdir(dirname(absolute), { recursive: true });
      await page.screenshot({ path: absolute, fullPage: false, animations: 'disabled' });
      return { path: `${name}.png`, omitted: false, omittedReason: null };
    } catch {
      return { path: null, omitted: true, omittedReason: 'capture-failed' };
    }
  }

  /** Build an evidence block for one step, draining the per-step windows. */
  async stepEvidence(
    page: Page,
    name: string,
    evidenceDir: string,
    policy: ScreenshotPolicy,
    urlBefore: string | null,
    urlAfter: string | null,
  ): Promise<StepEvidence> {
    const consoleEvents = this.takeConsole();
    const pageErrors = this.takePageErrors();
    const networkEvents = this.takeNetwork();
    const shot = await this.screenshot(page, name, evidenceDir, policy);

    return {
      screenshot: shot.path,
      screenshotOmitted: shot.omitted,
      screenshotOmittedReason: shot.omittedReason,
      consoleEvents,
      pageErrors,
      networkEvents,
      dialogObserved: this.sawDialog(),
      pageChanged: urlBefore !== urlAfter,
    };
  }
}

/** Create a recorder bound to a scrubber. */
export function createEvidenceRecorder(scrub: Scrubber): EvidenceRecorder {
  return new EvidenceRecorder(scrub);
}
