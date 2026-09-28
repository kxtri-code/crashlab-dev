/**
 * Chromium lifecycle.
 *
 * Kept separate from `scout.ts` so a future backend job or API can reuse the
 * launch recipe without pulling in the run orchestration.
 */

import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';
import { BROWSER_NAME } from '../version.js';

/** Viewport and TLS behaviour the browser session is opened with. */
export interface BrowserSessionOptions {
  headless: boolean;
  slowMoMs: number;
  ignoreHttpsErrors: boolean;
  viewport: { width: number; height: number };
}

/** An open browser session plus the page the scout works on. */
export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  close(): Promise<void>;
}

/** Playwright error text that means "the browser binary is not installed". */
const BROWSER_MISSING_PATTERN = /Executable doesn't exist|Please run the following command to download new browsers|playwright install/i;

/**
 * Turn a raw Playwright launch error into advice the user can act on.
 * Returns `null` when the error is not a missing-browser problem.
 */
export function explainLaunchError(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  if (BROWSER_MISSING_PATTERN.test(message)) {
    return `Chromium is not installed. Run \`npx playwright install chromium\` (or \`npm run setup\`) and try again.`;
  }
  return null;
}

/** Launch Chromium and open a single page. Caller must `close()` the session. */
export async function openBrowserSession(options: BrowserSessionOptions): Promise<BrowserSession> {
  let browser: Browser;
  try {
    browser = await chromium.launch({
      headless: options.headless,
      slowMo: options.slowMoMs,
      args: options.ignoreHttpsErrors ? ['--ignore-certificate-errors'] : [],
    });
  } catch (error) {
    const explanation = explainLaunchError(error);
    throw new Error(explanation ?? `Failed to launch ${BROWSER_NAME}: ${(error as Error).message}`);
  }

  const context = await browser.newContext({
    viewport: options.viewport,
    ignoreHTTPSErrors: options.ignoreHttpsErrors,
  });
  const page = await context.newPage();

  return {
    browser,
    context,
    page,
    async close(): Promise<void> {
      await context.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
    },
  };
}
