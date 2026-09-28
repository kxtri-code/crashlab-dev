/**
 * Network capture.
 *
 * Records metadata only: method, URL, status, resource type, duration and a
 * short failure reason. Request and response *bodies* are never read, and no
 * headers are stored, so a report cannot contain a session token or a
 * password. URLs are redacted before they are retained.
 */

import type { Page, Request } from 'playwright';
import type { NetworkEntry, NetworkIssueKind, NetworkStatusCount, NetworkSummary } from './types.js';
import { isThirdParty, redactUrl, toPath } from '../util/url.js';

/** A captured exchange before the page-relative context is known. */
interface PendingEntry {
  method: string;
  url: string;
  resourceType: string | null;
  startedAt: number;
  status: number | null;
  durationMs: number | null;
  failure: string | null;
  issue: NetworkIssueKind | null;
}

/** Requests slower than this are flagged, and 0 disables the check. */
export const DEFAULT_SLOW_REQUEST_MS = 5000;

/** Hard cap on retained entries, so a chatty page cannot produce a huge report. */
export const DEFAULT_MAX_ENTRIES = 500;

export interface NetworkRecorderOptions {
  maxEntries?: number;
  slowRequestMs?: number;
}

interface ErrorResponseBody {
  url: string;
  status: number;
  statusText: string;
}

/**
 * Subscribes to Playwright network events and hands back a recorder.
 *
 * Attach with `attachNetworkRecorder(page)` *before* navigation, or the initial
 * document request will be missed.
 */
export class NetworkRecorder {
  private readonly entries: NetworkEntry[] = [];
  private readonly pending = new Map<Request, PendingEntry>();
  private readonly errorBodies: ErrorResponseBody[] = [];

  private readonly maxEntries: number;
  private readonly slowRequestMs: number;
  private finalUrl: string | null = null;

  private page: Page | null = null;
  private attached = false;

  constructor(options: NetworkRecorderOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.slowRequestMs = options.slowRequestMs ?? DEFAULT_SLOW_REQUEST_MS;
  }

  /** Subscribe to a page's network events. Safe to call once per page. */
  attach(page: Page): void {
    if (this.attached) return;
    this.page = page;
    this.attached = true;

    page.on('request', (request) => {
      this.pending.set(request, {
        method: request.method(),
        url: redactUrl(request.url()),
        resourceType: request.resourceType(),
        startedAt: Date.now(),
        status: null,
        durationMs: null,
        failure: null,
        issue: null,
      });
    });

    page.on('response', async (response) => {
      const pending = this.pending.get(response.request());
      const status = response.status();
      // A response can arrive without a preceding `request` event, so fall back
      // to a fresh descriptor rather than dropping the exchange.
      const completed: PendingEntry = pending ?? {
        method: response.request().method(),
        url: redactUrl(response.url()),
        resourceType: response.request().resourceType(),
        startedAt: Date.now(),
        status: null,
        durationMs: null,
        failure: null,
        issue: null,
      };

      completed.status = status;
      completed.durationMs = Date.now() - completed.startedAt;
      if (status >= 400) completed.issue = 'http-error';

      if (this.pending.has(response.request())) this.pending.delete(response.request());
      this.push(completed);

      if (status >= 400) {
        this.errorBodies.push({
          url: redactUrl(response.url()),
          status,
          // Status text is server-supplied; strip anything that looks like markup.
          statusText: response.statusText().replace(/[^\w\s\-.,()[\]/&'":;!*?%$#@+]/g, '').slice(0, 120),
        });
      }

      // Drain the async body read so Node does not retain the buffer.
      void response.body().catch(() => undefined);
    });

    page.on('requestfailed', (request) => {
      const pending = this.pending.get(request);
      const failure = (() => {
        try {
          return request.failure()?.errorText ?? 'request failed';
        } catch {
          return 'request failed';
        }
      })();

      const completed: PendingEntry = pending ?? {
        method: request.method(),
        url: redactUrl(request.url()),
        resourceType: request.resourceType(),
        startedAt: Date.now(),
        status: null,
        durationMs: null,
        failure: null,
        issue: null,
      };

      completed.failure = failure.slice(0, 120);
      completed.durationMs = Date.now() - completed.startedAt;
      completed.issue = /blocked|denied|refused|blockedbyclient/i.test(failure) ? 'blocked-request' : 'failed-request';

      this.pending.delete(request);
      this.push(completed);
    });
  }

  /** Set the page's final URL so third-party classification is accurate. */
  setFinalUrl(url: string | null): void {
    this.finalUrl = url;
  }

  /**
   * Flush requests still in flight when the run ended. A request that never
   * produced a response is a finding for a QA tool, so it is recorded as a
   * failed request rather than dropped.
   */
  settle(): void {
    for (const pending of this.pending.values()) {
      pending.durationMs = Date.now() - pending.startedAt;
      pending.failure = 'no response before end of run';
      pending.issue = pending.issue ?? 'failed-request';
      this.push(pending);
    }
    this.pending.clear();
    void this.page;
  }

  private push(entry: PendingEntry): void {
    if (this.entries.length >= this.maxEntries) return;
    if (this.slowRequestMs > 0 && entry.durationMs !== null && entry.durationMs > this.slowRequestMs) {
      entry.issue = entry.issue ?? 'slow-request';
    }
    this.entries.push({
      method: entry.method,
      url: entry.url,
      path: toPath(entry.url),
      status: entry.status,
      resourceType: entry.resourceType,
      thirdParty: isThirdParty(entry.url, this.finalUrl),
      durationMs: entry.durationMs,
      failure: entry.failure,
      issue: entry.issue,
    });
  }

  /** Non-sensitive descriptions of failing responses, for the report. */
  getErrorBodies(): ErrorResponseBody[] {
    return [...this.errorBodies];
  }

  /** All captured exchanges, oldest first, as detached copies. */
  toEntries(): NetworkEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }
}

/**
 * Recompute the `thirdParty` flag for entries captured before the final URL was
 * known. Pure - unit-testable without a browser.
 */
export function markThirdParty(entries: NetworkEntry[], pageUrl: string | null): NetworkEntry[] {
  return entries.map((entry) => ({ ...entry, thirdParty: isThirdParty(entry.url, pageUrl) }));
}

/** Count entries sharing a key, omitting empty keys. */
function tally(entries: NetworkEntry[], key: (entry: NetworkEntry) => string | null): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of entries) {
    const value = key(entry);
    if (value === null || value === '') continue;
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

/** Aggregate network entries. Pure - unit-testable without a browser. */
export function summarizeNetwork(entries: NetworkEntry[]): NetworkSummary {
  const byStatus: NetworkStatusCount[] = Object.entries(tally(entries, (entry) => (entry.status === null ? null : String(entry.status))))
    .map(([status, count]) => ({ status: Number(status), count }))
    .sort((a, b) => (a.status ?? 0) - (b.status ?? 0));

  return {
    totalRequests: entries.length,
    failedRequests: entries.filter((entry) => entry.issue === 'failed-request' || entry.issue === 'blocked-request').length,
    errorResponses: entries.filter((entry) => entry.status !== null && entry.status >= 400).length,
    slowRequests: entries.filter((entry) => entry.issue === 'slow-request').length,
    thirdPartyRequests: entries.filter((entry) => entry.thirdParty).length,
    byMethod: tally(entries, (entry) => entry.method),
    byResourceType: tally(entries, (entry) => entry.resourceType),
    byStatus,
  };
}
