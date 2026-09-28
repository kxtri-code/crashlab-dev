/**
 * Scout orchestration.
 *
 * `runScout` is the only entry point Build 1 needs, and it is deliberately free
 * of CLI concerns: no `process.argv`, no `console.log`. The CLI supplies a URL
 * and a config, gets back a `ScoutReport`, and decides what to print and where
 * to write it. A future backend job or API can call this with the same shape.
 *
 * Failure policy: a scout run should never throw for a bad page. Navigation
 * failures, mapping failures and teardown failures are all recorded as warnings
 * or `scoutErrors` and a partial report is still returned, because "the page
 * was broken" is itself a finding.
 */

import type { Page } from 'playwright';
import { collectDomData, installSerializationShim } from './domRaw.js';
import type { CollectDomOptions, RawDomData } from './domRaw.js';
import { mapElements, mapForms } from './elements.js';
import { NetworkRecorder, markThirdParty } from './network.js';
import { detectPageType } from './pageType.js';
import { TelemetryRecorder } from './telemetry.js';
import { openBrowserSession } from './browser.js';
import { buildReport } from '../report/build.js';
import type { BuildReportInput } from '../report/build.js';
import type {
  NetworkEntry,
  PageNavigationTimings,
  ResolvedRunConfig,
  ScoutReport,
  ScoutRunError,
  ScoutWarning,
} from './types.js';
import { canonicalizeUrl, normalizeInputUrl, redactUrl, toOrigin } from '../util/url.js';
import { cleanTextCapped } from '../util/text.js';

/** Tags the mapper inspects. Any control role also reaches it via `[role]`. */
export const DEFAULT_DOM_SCOPE = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="textbox"]',
  '[role="searchbox"]',
  '[role="combobox"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  'summary',
];

/** Upper bound on mapped elements, so a huge page cannot produce a runaway report. */
export const DEFAULT_MAX_ELEMENTS = 2000;

/** Longest element text/label retained. */
const MAX_ELEMENT_TEXT = 300;

/** Options for a scout run. Every field has a default, so `{}` is valid. */
export interface ScoutOptions {
  /** Target page. A missing scheme is expanded (`example.com` -> `https://example.com`). */
  url: string;
  headless?: boolean;
  timeoutMs?: number;
  settleMs?: number;
  slowMoMs?: number;
  ignoreHttpsErrors?: boolean;
  viewport?: { width: number; height: number };
  /** Extra tags for the mapper to inspect. */
  domScope?: string[];
  maxElements?: number;
  /** Inject a page (e.g. a test fixture) instead of launching a browser. */
  page?: Page;
}

const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_SETTLE_MS = 1_000;

/** Turn any thrown value into a `ScoutRunError`. */
function toRunError(stage: string, error: unknown): ScoutRunError {
  const isError = error instanceof Error;
  const stack = isError && typeof error.stack === 'string' ? cleanTextCapped(error.stack, 600) : null;
  return {
    stage,
    name: isError ? error.name : 'Error',
    message: isError ? (cleanTextCapped(error.message, 500) ?? 'unknown error') : String(error).slice(0, 500),
    stack,
    timestamp: new Date().toISOString(),
  };
}

/** Await a closure, returning `null` instead of throwing (used on torn-down pages). */
async function safeAsync<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

/** Read navigation timings off the page, tolerating a missing performance API. */
async function readNavigationTimings(page: Page): Promise<PageNavigationTimings> {
  return (
    (await safeAsync(() =>
      page.evaluate(() => {
        // `getEntriesByType('navigation')` is typed as the base PerformanceEntry;
        // the navigation-specific timings only exist on the subclass.
        const navigation = window.performance?.getEntriesByType?.('navigation')?.[0] as
          | PerformanceNavigationTiming
          | undefined;
        const now = window.performance?.now?.() ?? null;
        return {
          domContentLoadedMs:
            typeof navigation?.domContentLoadedEventEnd === 'number' && navigation.domContentLoadedEventEnd > 0
              ? Math.round(navigation.domContentLoadedEventEnd)
              : null,
          loadMs:
            typeof navigation?.loadEventEnd === 'number' && navigation.loadEventEnd > 0
              ? Math.round(navigation.loadEventEnd)
              : null,
          timeSinceNavigationMs: now === null ? null : Math.round(now),
        };
      }),
    )) ?? { domContentLoadedMs: null, loadMs: null, timeSinceNavigationMs: null }
  );
}

/**
 * Run the in-page mapper.
 *
 * Deliberately does *not* swallow errors: a failure here is a scouting failure
 * the caller must be able to record, not a silent empty map.
 */
async function collectDom(page: Page, options: CollectDomOptions): Promise<RawDomData | null> {
  const result = await page.evaluate(collectDomData, options);
  return result ?? null;
}

/**
 * Scout a single page and return a report.
 *
 * Never throws for page-level problems; only an unusable `url` option is a
 * programmer error and surfaces as a thrown `Error`.
 */
export async function runScout(options: ScoutOptions): Promise<ScoutReport> {
  const inputUrl = normalizeInputUrl(options.url);
  if (!inputUrl) throw new Error('A target URL is required.');

  const headless = options.headless ?? true;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
  const slowMoMs = options.slowMoMs ?? 0;
  const ignoreHttpsErrors = options.ignoreHttpsErrors ?? false;
  const viewport = options.viewport ?? DEFAULT_VIEWPORT;
  const domScope = options.domScope ?? DEFAULT_DOM_SCOPE;
  const maxElements = options.maxElements ?? DEFAULT_MAX_ELEMENTS;

  const config: ResolvedRunConfig = {
    headless,
    timeoutMs,
    settleMs,
    slowMoMs,
    ignoreHttpsErrors,
    domScope,
  };

  const scoutErrors: ScoutRunError[] = [];
  const warnings: ScoutWarning[] = [];
  const startedAt = Date.now();

  // An injected page means an external owner is responsible for teardown.
  const session = options.page
    ? null
    : await openBrowserSession({ headless, slowMoMs, ignoreHttpsErrors, viewport });
  const page: Page = options.page ?? session!.page;

  const network = new NetworkRecorder();
  const telemetry = new TelemetryRecorder();

  try {
    network.attach(page);
    telemetry.attach(page);
    // Must precede navigation, so the mapper is runnable in the loaded page.
    await installSerializationShim(page);

    // --- navigate -------------------------------------------------------
    try {
      await page.goto(inputUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    } catch (error) {
      const navigationError = toRunError('navigate', error);
      scoutErrors.push(navigationError);
      warnings.push({
        stage: 'navigate',
        message: `Navigation did not complete cleanly: ${navigationError.message}. The report contains what was reachable.`,
      });
    }

    // Give late-rendering content a chance to appear before mapping.
    if (settleMs > 0) {
      try {
        await page.waitForTimeout(settleMs);
      } catch (error) {
        warnings.push({ stage: 'settle', message: `Settle wait failed: ${toRunError('settle', error).message}` });
      }
    }

    // --- page facts -----------------------------------------------------
    const safeInputUrl = redactUrl(inputUrl);
    const finalUrl = (await safeAsync(async () => redactUrl(page.url()))) ?? null;
    const title = cleanTextCapped((await safeAsync(async () => page.title())) ?? '', 300) ?? '';
    const userAgent = (await safeAsync(async () => page.evaluate(() => navigator.userAgent))) ?? '';
    const secureContext = await safeAsync(async () => page.evaluate(() => window.isSecureContext));
    const navigationTimings = await readNavigationTimings(page);

    // --- map ------------------------------------------------------------
    let raw: RawDomData | null = null;
    try {
      raw = await collectDom(page, { scope: domScope, maxElements, maxTextLength: MAX_ELEMENT_TEXT });
    } catch (error) {
      const mapError = toRunError('map', error);
      scoutErrors.push(mapError);
      warnings.push({ stage: 'map', message: `DOM mapping failed: ${mapError.message}. The report has no element map.` });
    }

    if (raw?.truncated) {
      warnings.push({
        stage: 'map',
        message: `Element map truncated at ${maxElements} elements; the page has more interactive elements than were captured.`,
      });
    }

    const elements = raw ? mapElements(raw.elements, finalUrl) : [];
    const forms = raw ? mapForms(raw.forms, elements, finalUrl) : [];
    const pageType = raw
      ? detectPageType(raw.signals)
      : {
          detectedPageType: 'unknown' as const,
          pageTypeConfidence: 0,
          pageTypeReason: 'page was not mapped',
          pageTypeCandidates: [],
        };

    // Requests still in flight when the run ends are a QA signal, not a gap:
    // flush them into the report before it is assembled.
    network.settle();
    const networkEntries: NetworkEntry[] = markThirdParty(network.toEntries(), finalUrl);

    // --- assemble -------------------------------------------------------
    const input: BuildReportInput = {
      inputUrl: safeInputUrl,
      finalUrl,
      title,
      redirected: toOrigin(safeInputUrl) !== null && toOrigin(finalUrl) !== null
        ? toOrigin(safeInputUrl) !== toOrigin(finalUrl)
        : null,
      secureContext,
      userAgent,
      viewport,
      durationMs: Date.now() - startedAt,
      navigationTimings,
      config,
      detectedPageType: pageType.detectedPageType,
      pageTypeConfidence: pageType.pageTypeConfidence,
      pageTypeReason: pageType.pageTypeReason,
      pageTypeCandidates: pageType.pageTypeCandidates,
      visibleTextSample: raw?.meta.visibleText ?? '',
      visibleTextLength: raw?.meta.visibleTextLength ?? 0,
      readyState: raw?.meta.readyState ?? null,
      htmlLang: raw?.meta.htmlLang ?? null,
      canonicalUrl: canonicalizeUrl(raw?.meta.canonicalUrl ?? null, finalUrl),
      metaDescription: cleanTextCapped(raw?.meta.metaDescription ?? null, 300),
      elements,
      forms,
      network: networkEntries,
      console: telemetry.toMessages(),
      errors: telemetry.toPageErrors(),
      scoutErrors,
      warnings,
    };

    return buildReport(input);
  } finally {
    // Teardown runs after the report is built, so a close failure cannot be
    // recorded in it; a browser that will not close is not a page finding.
    telemetry.detach();
    if (session) await session.close().catch(() => undefined);
  }
}
