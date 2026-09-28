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

/** Running total of evidence, plus per-step windows. */
export class EvidenceRecorder {
  private readonly telemetry = new TelemetryRecorder({ maxMessages: 500 });
  private readonly network = new NetworkRecorder({ maxEntries: 500 });
  private readonly scrub: Scrubber;

  private finalUrl: string | null = null;
  private screenshotCount = 0;
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
    }));
  }

  /**
   * Capture a screenshot, subject to a hard per-run cap.
   *
   * @returns the path relative to the evidence directory, or null when the cap
   * was reached or the capture failed.
   */
  async screenshot(page: Page, name: string, evidenceDir: string, enabled: boolean): Promise<string | null> {
    if (!enabled) return null;
    if (this.screenshotCount >= MAX_SCREENSHOTS) return null;

    const absolute = join(evidenceDir, `${name}.png`);
    try {
      await mkdir(dirname(absolute), { recursive: true });
      await page.screenshot({ path: absolute, fullPage: false, animations: 'disabled' });
      this.screenshotCount += 1;
      return `${name}.png`;
    } catch {
      // A failed screenshot is a missing piece of evidence, not a run failure.
      return null;
    }
  }

  /** Build an evidence block for one step, draining the per-step windows. */
  stepEvidence(
    page: Page,
    name: string,
    evidenceDir: string,
    enabled: boolean,
    urlBefore: string | null,
    urlAfter: string | null,
  ): Promise<StepEvidence> {
    return Promise.resolve({
      screenshot: null,
      consoleEvents: this.takeConsole(),
      pageErrors: this.takePageErrors(),
      networkEvents: this.takeNetwork(),
      dialogObserved: this.sawDialog(),
      pageChanged: urlBefore !== urlAfter,
    }).then(async (partial) => ({
      ...partial,
      screenshot: await this.screenshot(page, name, evidenceDir, enabled),
    }));
  }
}

/** Create a recorder bound to a scrubber. */
export function createEvidenceRecorder(scrub: Scrubber): EvidenceRecorder {
  return new EvidenceRecorder(scrub);
}
