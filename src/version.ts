/**
 * Build identity. Kept in one place so the CLI banner, the report `meta` block
 * and the npm package version can never drift apart.
 */
export const TOOL_NAME = 'CrashLab Scout';

/** Build number for this tool. Bump on every shipped change to Build 1. */
export const TOOL_VERSION = '0.1.0';

/**
 * Bump when the report *shape* changes in a way downstream consumers must
 * notice (added/removed/renamed keys, changed value types). Cosmetic additions
 * that only append optional keys do not require a bump.
 */
export const REPORT_SCHEMA_VERSION = 1;

/** Playwright engine name, recorded in the report for reproducibility. */
export const BROWSER_NAME = 'chromium';
