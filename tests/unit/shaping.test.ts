import { describe, expect, it } from 'vitest';
import { markThirdParty, summarizeNetwork } from '../../src/scout/network.js';
import { normalizeConsoleType, summarizeConsole } from '../../src/scout/telemetry.js';
import { buildReport, countElements, summarizeReport } from '../../src/report/build.js';
import type { BuildReportInput } from '../../src/report/build.js';
import type { ConsoleEntry, NetworkEntry } from '../../src/scout/types.js';

/** A network entry with sensible defaults. */
function net(overrides: Partial<NetworkEntry> = {}): NetworkEntry {
  return {
    method: 'GET',
    url: 'https://x.test/a',
    path: '/a',
    status: 200,
    resourceType: 'xhr',
    thirdParty: false,
    durationMs: 10,
    failure: null,
    issue: null,
    ...overrides,
  };
}

function consoleEntry(overrides: Partial<ConsoleEntry> = {}): ConsoleEntry {
  return {
    type: 'log',
    text: 'hello',
    method: 'log',
    url: null,
    line: null,
    timestamp: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('summarizeNetwork', () => {
  it('aggregates totals, statuses, methods and resource types', () => {
    const summary = summarizeNetwork([
      net({ method: 'GET', status: 200, resourceType: 'document' }),
      net({ method: 'GET', status: 200, resourceType: 'xhr' }),
      net({ method: 'POST', status: 500, resourceType: 'xhr', issue: 'http-error' }),
      net({ method: 'GET', status: null, resourceType: 'xhr', issue: 'failed-request', failure: 'net::ERR_ABORTED' }),
      net({ url: 'https://cdn.other.test/a.js', path: '/a.js', resourceType: 'script', thirdParty: true }),
      net({ status: 200, durationMs: 9000, issue: 'slow-request', resourceType: 'image' }),
    ]);

    expect(summary.totalRequests).toBe(6);
    expect(summary.errorResponses).toBe(1);
    expect(summary.failedRequests).toBe(1);
    expect(summary.slowRequests).toBe(1);
    expect(summary.thirdPartyRequests).toBe(1);
    expect(summary.byMethod).toEqual({ GET: 5, POST: 1 });
    expect(summary.byResourceType).toEqual({ document: 1, xhr: 3, script: 1, image: 1 });
    expect(summary.byStatus).toEqual([
      { status: 200, count: 4 },
      { status: 500, count: 1 },
    ]);
  });

  it('handles an empty list without dividing by zero', () => {
    const summary = summarizeNetwork([]);
    expect(summary.totalRequests).toBe(0);
    expect(summary.byStatus).toEqual([]);
    expect(summary.byMethod).toEqual({});
  });
});

describe('markThirdParty', () => {
  it('reclassifies against the final page URL', () => {
    const marked = markThirdParty(
      [net({ url: 'https://x.test/a' }), net({ url: 'https://cdn.other.test/b.js' })],
      'https://x.test/page',
    );
    expect(marked[0]!.thirdParty).toBe(false);
    expect(marked[1]!.thirdParty).toBe(true);
  });

  it('treats an unknown page URL as nothing being third party', () => {
    expect(markThirdParty([net()], null)[0]!.thirdParty).toBe(false);
  });
});

describe('console shaping', () => {
  it('normalises unknown console types to other', () => {
    expect(normalizeConsoleType('error')).toBe('error');
    expect(normalizeConsoleType('warning')).toBe('warning');
    expect(normalizeConsoleType('somethingNew')).toBe('other');
  });

  it('tallies messages by type', () => {
    const summary = summarizeConsole([
      consoleEntry({ type: 'error' }),
      consoleEntry({ type: 'error' }),
      consoleEntry({ type: 'warning' }),
    ]);
    expect(summary.total).toBe(3);
    expect(summary.byType).toEqual({ error: 2, warning: 1 });
  });
});

/** A complete, minimal report input. */
function reportInput(overrides: Partial<BuildReportInput> = {}): BuildReportInput {
  return {
    inputUrl: 'https://x.test/',
    finalUrl: 'https://x.test/',
    title: 'Fixture',
    redirected: false,
    secureContext: true,
    userAgent: 'test-agent',
    viewport: { width: 1280, height: 800 },
    durationMs: 1234,
    navigationTimings: { domContentLoadedMs: 100, loadMs: 200, timeSinceNavigationMs: 300 },
    config: {
      headless: true,
      timeoutMs: 30000,
      settleMs: 1000,
      slowMoMs: 0,
      ignoreHttpsErrors: false,
      domScope: ['button'],
    },
    detectedPageType: 'unknown',
    pageTypeConfidence: 0,
    pageTypeReason: 'no distinguishing page signals',
    pageTypeCandidates: [],
    visibleTextSample: 'hello',
    visibleTextLength: 5,
    readyState: 'complete',
    htmlLang: 'en',
    canonicalUrl: null,
    metaDescription: null,
    elements: [],
    forms: [],
    network: [],
    console: [],
    errors: [],
    scoutErrors: [],
    warnings: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('buildReport', () => {
  it('has every documented top-level key', () => {
    const report = buildReport(reportInput());
    expect(Object.keys(report).sort()).toEqual(
      [
        'console',
        'consoleSummary',
        'elementCounts',
        'errors',
        'forms',
        'interactiveElements',
        'meta',
        'network',
        'networkSummary',
        'page',
        'scoutErrors',
        'target',
        'warnings',
      ].sort(),
    );
  });

  it('stamps meta from the build constants', () => {
    const report = buildReport(reportInput());
    expect(report.meta.tool).toBe('CrashLab Scout');
    expect(report.meta.version).toBe('0.1.0');
    expect(report.meta.schemaVersion).toBe(1);
    expect(report.meta.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(report.meta.browser).toBe('chromium');
  });

  it('is JSON-serialisable with no undefined leaking through', () => {
    const report = buildReport(reportInput());
    const roundTripped = JSON.parse(JSON.stringify(report)) as typeof report;
    expect(roundTripped).toEqual(report);
  });

  it('derives summaries from the arrays it is given', () => {
    const report = buildReport(
      reportInput({
        network: [net({ status: 503, issue: 'http-error' })],
        console: [consoleEntry({ type: 'warning' })],
      }),
    );
    expect(report.networkSummary.errorResponses).toBe(1);
    expect(report.consoleSummary.byType.warning).toBe(1);
  });

  it('copies inputs so later mutation cannot alter the report', () => {
    const network = [net()];
    const report = buildReport(reportInput({ network }));
    network[0]!.status = 999;
    expect(report.network[0]!.status).toBe(200);
  });
});

describe('countElements', () => {
  it('emits every known type key with a zero floor', () => {
    const counts = countElements([]);
    expect(counts.button).toBe(0);
    expect(counts.link).toBe(0);
    expect(Object.keys(counts)).toHaveLength(8);
  });
});

describe('summarizeReport', () => {
  it('renders a banner, target block and the counts the report holds', () => {
    const summary = summarizeReport(buildReport(reportInput()));
    expect(summary).toContain('CRASHLAB SCOUT v0.1.0');
    expect(summary).toContain('https://x.test/');
    expect(summary).toContain('Fixture');
    expect(summary).toContain('Forms:          0');
    expect(summary).toContain('Scout complete.');
  });

  it('omits the page-type line when the type is unknown', () => {
    expect(summarizeReport(buildReport(reportInput()))).not.toContain('Page type:');
  });

  it('surfaces warnings and the error footer', () => {
    const summary = summarizeReport(
      buildReport(
        reportInput({
          warnings: [{ stage: 'map', message: 'element map truncated' }],
          scoutErrors: [{ stage: 'navigate', name: 'Error', message: 'timed out', stack: null, timestamp: 't' }],
        }),
      ),
    );
    expect(summary).toContain('NOTES: 1 warning(s)');
    expect(summary).toContain('element map truncated');
    expect(summary).toContain('Scout finished with errors.');
  });
});
