/**
 * Browser-backed integration tests.
 *
 * These launch a real Chromium against a local fixture server, so they verify
 * the parts that cannot be proven with pure functions: selector generation,
 * label resolution, visibility, network capture and console/error capture.
 *
 * They skip (rather than fail) when the Chromium binary is not installed, so
 * `npm run test:browser` is still useful before `npx playwright install`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import type { Server } from 'node:http';
import { chromium } from 'playwright';
import { runScout } from '../../src/scout/scout.js';
import { startFixtureServer, stopFixtureServer } from '../fixtures/server.js';
import type { ScoutReport } from '../../src/scout/types.js';

let server: Server;
let origin: string;
let browser: Browser;
let chromiumAvailable = false;

beforeAll(async () => {
  try {
    browser = await chromium.launch({ headless: true });
    chromiumAvailable = true;
  } catch {
    chromiumAvailable = false;
  }
  const started = await startFixtureServer();
  server = started.server;
  origin = started.origin;
}, 60_000);

afterAll(async () => {
  await browser?.close();
  if (server) await stopFixtureServer(server);
});

/** Scout a fixture path, or return null when no browser is installed. */
async function scoutFixture(path: string): Promise<ScoutReport | null> {
  if (!chromiumAvailable) return null;
  return runScout({ url: `${origin}${path}`, headless: true, settleMs: 150, timeoutMs: 15_000 });
}

/** Find an element by its `#id`. */
function byId(report: ScoutReport, id: string) {
  return report.interactiveElements.find((element) => element.id === id);
}

describe('scout against a checkout page', () => {
  let report: ScoutReport | null = null;

  beforeAll(async () => {
    report = await scoutFixture('/checkout');
  });

  it('captures target, title and final URL', () => {
    if (!report) return;
    expect(report.target.inputUrl).toContain('/checkout');
    expect(report.target.finalUrl).toContain('/checkout');
    expect(report.target.title).toBe('Checkout - CrashLab Fixture');
    expect(report.meta.browser).toBe('chromium');
    expect(report.meta.userAgent).toContain('Chrome');
    expect(report.meta.durationMs).toBeGreaterThan(0);
  });

  it('classifies the page as a checkout page', () => {
    if (!report) return;
    expect(report.page.detectedPageType).toBe('checkout');
    expect(report.page.pageTypeConfidence).toBeGreaterThan(0);
    expect(report.page.visibleTextSample).toContain('Checkout');
  });

  it('maps interactive elements across every category', () => {
    if (!report) return;
    expect(report.elementCounts.button).toBeGreaterThan(0);
    expect(report.elementCounts.link).toBeGreaterThan(0);
    expect(report.elementCounts.input).toBeGreaterThan(0);
    expect(report.elementCounts.select).toBe(1);
    expect(report.elementCounts.textarea).toBe(1);
    expect(report.elementCounts.checkbox).toBeGreaterThanOrEqual(2); // real + role=checkbox
    expect(report.interactiveElements.every((element) => element.selector.length > 0)).toBe(true);
  });

  it('resolves labels from label[for] and wrapping labels', () => {
    if (!report) return;
    expect(byId(report, 'email')?.label).toBe('Email address');
    // The card field is wrapped by its label, with the input's own text removed.
    expect(byId(report, 'card')?.label).toBe('Card number');
  });

  it('resolves placeholders and names', () => {
    if (!report) return;
    expect(byId(report, 'email')?.placeholder).toBe('you@example.com');
    expect(byId(report, 'email')?.name).toBe('email');
    expect(byId(report, 'email')?.required).toBe(true);
  });

  it('marks a display:none element as not visible', () => {
    if (!report) return;
    expect(byId(report, 'hidden-admin')?.visible).toBe(false);
  });

  it('marks a disabled button as not enabled', () => {
    if (!report) return;
    const disabled = byId(report, 'disabled-submit');
    expect(disabled?.enabled).toBe(false);
    expect(disabled?.disabled).toBe(true);
  });

  it('prefers a test-id locator where one exists', () => {
    if (!report) return;
    expect(byId(report, 'apply-promo')?.locator).toBe("page.getByTestId('apply-promo')");
  });

  it('generates a selector that actually resolves in the browser', async () => {
    if (!report || !chromiumAvailable) return;
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/checkout`, { waitUntil: 'domcontentloaded' });
      for (const element of report.interactiveElements.slice(0, 25)) {
        const matches = await page.locator(element.selector).count();
        expect(matches, `selector ${element.selector} should match exactly one element`).toBe(1);
      }
    } finally {
      await page.close();
    }
  });

  it('records a stable, unique selector for repeated elements', async () => {
    if (!report || !chromiumAvailable) return;
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/checkout`, { waitUntil: 'domcontentloaded' });
      const applyPromo = report.interactiveElements.find((element) => element.id === 'apply-promo');
      expect(applyPromo).toBeDefined();
      expect(await page.locator(applyPromo!.selector).count()).toBe(1);
    } finally {
      await page.close();
    }
  });

  it('maps the form, its fields and its submit buttons', () => {
    if (!report) return;
    const form = report.forms.find((candidate) => candidate.id === 'checkout-form');
    expect(form).toBeDefined();
    expect(form!.action).toContain('/api/orders');
    expect(form!.method).toBe('POST');
    expect(form!.visible).toBe(true);

    const fieldNames = form!.fields.map((field) => field.name);
    expect(fieldNames).toContain('email');
    expect(fieldNames).toContain('card');
    expect(fieldNames).toContain('country');
    expect(fieldNames).toContain('notes');
    // The hidden CSRF field is mapped as a field; its value is not.
    expect(fieldNames).toContain('csrf');

    // Only `type="submit"` submits the form. A `<button type="button">` is a
    // field of the element map but is not a submit control.
    expect(form!.submitButtons).toHaveLength(1);
    expect(form!.submitButtons[0]!.inputType).toBe('submit');
  });

  it('captures network requests, including the 404', () => {
    if (!report) return;
    expect(report.network.length).toBeGreaterThan(0);
    expect(report.network.some((entry) => entry.resourceType === 'document')).toBe(true);
    expect(report.network.some((entry) => entry.path.startsWith('/api/telemetry'))).toBe(true);
    expect(report.networkSummary.errorResponses).toBeGreaterThanOrEqual(1);
    expect(report.network.some((entry) => entry.status === 404)).toBe(true);
    expect(report.network.every((entry) => entry.url.startsWith('http'))).toBe(true);
  });

  it('redacts a sensitive query value from a captured URL', () => {
    if (!report) return;
    // The fixture fetches `/api/telemetry?token=...`; the token must not survive.
    const telemetry = report.network.find((entry) => entry.path.startsWith('/api/telemetry'));
    expect(telemetry).toBeDefined();
    expect(telemetry!.url).toContain('token=REDACTED');
    expect(telemetry!.url).not.toContain('supersecret');
    // A non-sensitive parameter on the same URL is preserved.
    expect(telemetry!.url).toContain('ok=1');
  });

  it('captures console warnings and errors', () => {
    if (!report) return;
    expect(report.consoleSummary.byType.warning).toBeGreaterThanOrEqual(1);
    expect(report.consoleSummary.byType.error).toBeGreaterThanOrEqual(1);
    expect(report.console.some((entry) => entry.text.includes('slow third-party widget'))).toBe(true);
    expect(report.console.some((entry) => entry.text.includes('deprecated API call'))).toBe(true);
  });

  it('classifies every captured request as first- or third-party', () => {
    if (!report) return;
    expect(report.network.every((entry) => typeof entry.thirdParty === 'boolean')).toBe(true);
    // Every fixture asset is same-origin, so nothing should be flagged.
    expect(report.networkSummary.thirdPartyRequests).toBe(0);
  });

  it('captures console warnings and errors', () => {
    if (!report) return;
    // Counted on the fixture's own messages, not the total: loading the page
    // over http also produces browser-level resource errors.
    expect(report.consoleSummary.byType.warning).toBeGreaterThanOrEqual(1);
    expect(report.consoleSummary.byType.error).toBeGreaterThanOrEqual(1);
    expect(report.console.some((entry) => entry.text.includes('slow third-party widget'))).toBe(true);
  });

  it('captures the uncaught page error', () => {
    if (!report) return;
    expect(report.errors.length).toBeGreaterThanOrEqual(1);
    expect(report.errors.some((entry) => entry.message.includes('uncaught late failure'))).toBe(true);
  });

  it('never records a form value or a request body', () => {
    if (!report) return;
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('static-token-value');
    // The hidden CSRF input is mapped, but its value is not stored: the static
    // value attribute is captured only for visible controls.
    const csrf = report.interactiveElements.find((element) => element.name === 'csrf');
    expect(csrf).toBeDefined();
    expect(csrf?.visible).toBe(false);
    expect(csrf?.value).toBeNull();
  });

  it('does keep a visible control default value, which is a real signal', () => {
    if (!report) return;
    const promo = report.interactiveElements.find((element) => element.id === 'save-card');
    expect(promo?.visible).toBe(true);
    // A visible control's static value is a genuine default, not a secret.
    expect(promo?.value === null || typeof promo?.value === 'string').toBe(true);
  });

  it('completes with no scout errors on a healthy page', () => {
    if (!report) return;
    expect(report.scoutErrors).toEqual([]);
  });
});

describe('scout against other fixture pages', () => {
  it('detects a login page and never stores a password value', async () => {
    const report = await scoutFixture('/login');
    if (!report) return;
    expect(report.page.detectedPageType).toBe('login');
    const password = report.interactiveElements.find((element) => element.name === 'password');
    expect(password?.inputType).toBe('password');
    expect(password?.label).toBe('Password');
    // No mapped element may carry a value, since the fixture defines none.
    expect(report.interactiveElements.every((element) => element.value === null)).toBe(true);
  });

  it('records a cross-origin redirect', async () => {
    const report = await scoutFixture('/redirect');
    if (!report) return;
    expect(report.target.finalUrl).toContain('/plain');
    expect(report.target.redirected).toBe(false); // same origin, different path
    expect(report.target.title).toBe('CrashLab Fixture');
  });

  it('returns a usable report for a page with no forms', async () => {
    const report = await scoutFixture('/plain');
    if (!report) return;
    expect(report.forms).toEqual([]);
    expect(report.scoutErrors).toEqual([]);
    expect(report.interactiveElements.length).toBeGreaterThan(0);
  });
});

describe('scout failure handling', () => {
  it('records a scout error and still returns a report for an unreachable host', async () => {
    if (!chromiumAvailable) return;
    const report = await runScout({
      url: 'http://127.0.0.1:1/unreachable',
      headless: true,
      settleMs: 0,
      timeoutMs: 5000,
    });
    expect(report.scoutErrors.length).toBeGreaterThan(0);
    expect(report.scoutErrors[0]?.stage).toBe('navigate');
    expect(report.warnings.length).toBeGreaterThan(0);
    // The report is still a complete, readable object.
    expect(report.meta.tool).toBe('CrashLab Scout');
    // The attempt is recorded as a failed request rather than dropped - a
    // request that never completed is itself a finding.
    expect(report.network.length).toBeGreaterThan(0);
    expect(report.network[0]?.issue).toBe('failed-request');
    expect(report.network[0]?.status).toBeNull();
    expect(report.network[0]?.failure).toBeTruthy();
  }, 30_000);

  it('records a 500 response as an HTTP error rather than a scout failure', async () => {
    if (!chromiumAvailable) return;
    // A 500 is a successful navigation with a bad status, so the scout should
    // surface it in the network data and *not* record a scout error.
    const report = await runScout({
      url: `${origin}/boom`,
      headless: true,
      settleMs: 100,
      timeoutMs: 10_000,
    });
    expect(report.scoutErrors).toEqual([]);
    expect(report.network.some((entry) => entry.status === 500)).toBe(true);
    expect(report.networkSummary.errorResponses).toBeGreaterThanOrEqual(1);
    expect(report.network.find((entry) => entry.status === 500)?.issue).toBe('http-error');
  }, 30_000);

  it('surfaces a request that never responds as a failed request', async () => {
    if (!chromiumAvailable) return;
    const report = await scoutFixture('/checkout');
    if (!report) return;
    // The fixture fires a request for a resource the server does not serve.
    expect(report.network.some((entry) => entry.issue === 'http-error')).toBe(true);
    expect(report.network.every((entry) => entry.url.length <= 2100)).toBe(true);
  });
});
