/**
 * Console and page-error capture.
 *
 * Console text can echo anything a page logs, including a value a script
 * interpolated, so every message is collapsed and length-capped before it is
 * stored. No logging of form values is performed here beyond whatever the
 * target page itself emitted, and nothing is logged by CrashLab itself.
 */

import type { ConsoleMessage, Page } from 'playwright';
import type { ConsoleEntry, ConsoleMessageType, ConsoleSummary, PageErrorEntry } from './types.js';
import { redactUrl } from '../util/url.js';
import { cleanTextCapped } from '../util/text.js';

/** Longest console message retained. */
const MAX_CONSOLE_TEXT = 1000;

/** Longest stack trace retained per page error. */
const MAX_STACK = 1000;

/** Hard cap on retained messages, so a log loop cannot flood the report. */
export const DEFAULT_MAX_MESSAGES = 200;

/** Playwright console types we pass through verbatim. */
const KNOWN_TYPES = new Set<string>(['error', 'warning', 'info', 'log', 'debug']);

/** Map Playwright's console type onto the report taxonomy. */
export function normalizeConsoleType(type: string): ConsoleMessageType {
  return KNOWN_TYPES.has(type) ? (type as ConsoleMessageType) : 'other';
}

export class TelemetryRecorder {
  private readonly messages: ConsoleEntry[] = [];
  private readonly pageErrors: PageErrorEntry[] = [];
  private readonly maxMessages: number;
  private page: Page | null = null;
  private attached = false;

  constructor(options: { maxMessages?: number } = {}) {
    this.maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
  }

  attach(page: Page): void {
    if (this.attached) return;
    this.page = page;
    this.attached = true;

    page.on('console', (message: ConsoleMessage) => this.push(message));
    page.on('pageerror', (error: Error) => this.pushError(error));
  }

  private push(message: ConsoleMessage): void {
    if (this.messages.length >= this.maxMessages) return;
    const location = (() => {
      try {
        return message.location();
      } catch {
        return { url: '', lineNumber: 0 };
      }
    })();

    this.messages.push({
      type: normalizeConsoleType(message.type()),
      text: cleanTextCapped(message.text(), MAX_CONSOLE_TEXT) ?? '',
      method: message.type(),
      url: location.url ? redactUrl(location.url) : null,
      line: typeof location.lineNumber === 'number' && location.lineNumber > 0 ? location.lineNumber : null,
      timestamp: new Date().toISOString(),
    });
  }

  private pushError(error: Error): void {
    this.pageErrors.push({
      message: cleanTextCapped(error.message, MAX_CONSOLE_TEXT) ?? 'unknown page error',
      stack: cleanTextCapped(error.stack, MAX_STACK),
      timestamp: new Date().toISOString(),
    });
  }

  toMessages(): ConsoleEntry[] {
    return [...this.messages];
  }

  toPageErrors(): PageErrorEntry[] {
    return [...this.pageErrors];
  }

  detach(): void {
    void this.page;
    this.page = null;
  }
}

/** Aggregate console entries. Pure - unit-testable without a browser. */
export function summarizeConsole(messages: ConsoleEntry[]): ConsoleSummary {
  const byType: Record<string, number> = {};
  for (const message of messages) {
    byType[message.type] = (byType[message.type] ?? 0) + 1;
  }
  return { total: messages.length, byType };
}
