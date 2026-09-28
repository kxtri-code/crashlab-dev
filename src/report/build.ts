/**
 * Report assembly and the terminal summary.
 *
 * Both are pure functions of already-captured data, so they can be unit-tested
 * without launching a browser. `summarizeReport` in particular is the single
 * place that decides what the terminal shows, so the numbers on screen can
 * never disagree with the JSON on disk.
 */

import type {
  ConsoleEntry,
  DetectedPageType,
  InteractiveElement,
  InteractiveElementType,
  NetworkEntry,
  PageErrorEntry,
  PageNavigationTimings,
  PageTypeSignal,
  ResolvedRunConfig,
  ScoutForm,
  ScoutReport,
  ScoutRunError,
  ScoutWarning,
} from '../scout/types.js';
import { summarizeNetwork } from '../scout/network.js';
import { summarizeConsole } from '../scout/telemetry.js';
import { BROWSER_NAME, REPORT_SCHEMA_VERSION, TOOL_NAME, TOOL_VERSION } from '../version.js';

/** Element types counted in `elementCounts`, in display order. */
const COUNTED_TYPES: InteractiveElementType[] = [
  'button',
  'link',
  'input',
  'select',
  'textarea',
  'checkbox',
  'radio',
  'other',
];

/** Everything the assembler needs that it does not itself compute. */
export interface BuildReportInput {
  inputUrl: string;
  finalUrl: string | null;
  title: string;
  redirected: boolean | null;
  secureContext: boolean | null;
  userAgent: string;
  viewport: { width: number; height: number };
  durationMs: number;
  navigationTimings: PageNavigationTimings;
  config: ResolvedRunConfig;
  detectedPageType: DetectedPageType;
  pageTypeConfidence: number;
  pageTypeReason: string;
  pageTypeCandidates: PageTypeSignal[];
  visibleTextSample: string;
  visibleTextLength: number;
  readyState: string | null;
  htmlLang: string | null;
  canonicalUrl: string | null;
  metaDescription: string | null;
  elements: InteractiveElement[];
  forms: ScoutForm[];
  network: NetworkEntry[];
  console: ConsoleEntry[];
  errors: PageErrorEntry[];
  scoutErrors: ScoutErrorEntry[];
  warnings: ScoutWarning[];
  createdAt?: string;
}

/** Alias so callers do not need to import the type separately. */
export type ScoutErrorEntry = ScoutRunError;

/** Count elements by type, always emitting every known key with a 0 floor. */
export function countElements(elements: InteractiveElement[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const type of COUNTED_TYPES) counts[type] = 0;
  for (const element of elements) {
    const type = (COUNTED_TYPES.includes(element.type) ? element.type : 'other') as InteractiveElementType;
    counts[type] = (counts[type] ?? 0) + 1;
  }
  return counts;
}

/** Assemble the full report. Pure. */
export function buildReport(input: BuildReportInput): ScoutReport {
  const network = input.network.map((entry) => ({ ...entry }));
  const console_ = input.console.map((entry) => ({ ...entry }));
  const errors = input.errors.map((entry) => ({ ...entry }));

  return {
    meta: {
      tool: TOOL_NAME,
      version: TOOL_VERSION,
      schemaVersion: REPORT_SCHEMA_VERSION,
      createdAt: input.createdAt ?? new Date().toISOString(),
      durationMs: input.durationMs,
      browser: BROWSER_NAME,
      userAgent: input.userAgent,
      viewport: input.viewport,
      navigationTimings: input.navigationTimings,
      config: input.config,
    },
    target: {
      inputUrl: input.inputUrl,
      finalUrl: input.finalUrl,
      title: input.title,
      redirected: input.redirected,
      secureContext: input.secureContext,
    },
    page: {
      detectedPageType: input.detectedPageType,
      pageTypeConfidence: input.pageTypeConfidence,
      pageTypeReason: input.pageTypeReason,
      pageTypeCandidates: input.pageTypeCandidates,
      visibleTextSample: input.visibleTextSample,
      visibleTextLength: input.visibleTextLength,
      readyState: input.readyState,
      htmlLang: input.htmlLang,
      canonicalUrl: input.canonicalUrl,
      metaDescription: input.metaDescription,
    },
    interactiveElements: input.elements.map((element) => ({ ...element })),
    forms: input.forms.map((form) => ({ ...form })),
    network,
    networkSummary: summarizeNetwork(network),
    console: console_,
    consoleSummary: summarizeConsole(console_),
    errors,
    scoutErrors: input.scoutErrors.map((error) => ({ ...error })),
    warnings: input.warnings.map((warning) => ({ ...warning })),
    elementCounts: countElements(input.elements),
  };
}

/** Line-aligned `Label: value` helper for the terminal summary. */
function row(label: string, value: string, width = 12): string {
  return `  ${label.padEnd(width)} ${value}`;
}

/**
 * Render the terminal summary. Pure - no I/O, no ANSI codes, so it is directly
 * assertable in tests.
 */
export function summarizeReport(report: ScoutReport): string {
  const { meta, target, page, networkSummary, consoleSummary, elementCounts } = report;
  const lines: string[] = [];

  lines.push(`${TOOL_NAME.toUpperCase()} v${meta.version}`);
  lines.push('');
  lines.push(row('Target:', target.inputUrl));
  lines.push(row('Final URL:', target.finalUrl ?? '(none)'));
  lines.push(row('Page title:', target.title || '(untitled)'));
  if (page.detectedPageType !== 'unknown') {
    lines.push(row('Page type:', `${page.detectedPageType} (${Math.round(page.pageTypeConfidence * 100)}% confidence)`));
  }
  lines.push('');

  lines.push('INTERACTIVE ELEMENTS');
  lines.push(`  Buttons:        ${elementCounts.button ?? 0}`);
  lines.push(`  Links:          ${elementCounts.link ?? 0}`);
  lines.push(`  Inputs:         ${(elementCounts.input ?? 0) + (elementCounts.textarea ?? 0) + (elementCounts.select ?? 0)}`);
  lines.push(`  Checkboxes:     ${(elementCounts.checkbox ?? 0) + (elementCounts.radio ?? 0)}`);
  lines.push(`  Forms:          ${report.forms.length}`);
  const hidden = report.interactiveElements.filter((element) => !element.visible).length;
  if (hidden > 0) lines.push(`  Hidden:         ${hidden}`);
  lines.push('');

  lines.push('NETWORK');
  lines.push(`  Requests captured: ${networkSummary.totalRequests}`);
  lines.push(`  HTTP errors:       ${networkSummary.errorResponses}`);
  lines.push(`  Failed requests:   ${networkSummary.failedRequests}`);
  lines.push(`  Third party:       ${networkSummary.thirdPartyRequests}`);
  lines.push('');

  lines.push('CONSOLE');
  lines.push(`  Warnings:       ${consoleSummary.byType.warning ?? 0}`);
  lines.push(`  Errors:         ${consoleSummary.byType.error ?? 0}`);
  lines.push(`  Other messages: ${(consoleSummary.total ?? 0) - (consoleSummary.byType.warning ?? 0) - (consoleSummary.byType.error ?? 0)}`);
  lines.push(`  Page errors:    ${report.errors.length}`);
  lines.push('');

  const blocking = report.scoutErrors.length > 0;
  if (report.warnings.length > 0) {
    lines.push(`NOTES: ${report.warnings.length} warning(s)`);
    for (const warning of report.warnings) lines.push(`  - [${warning.stage}] ${warning.message}`);
    lines.push('');
  }
  if (blocking) {
    lines.push(`SCOUT ERRORS: ${report.scoutErrors.length}`);
    for (const error of report.scoutErrors) lines.push(`  - [${error.stage}] ${error.message}`);
    lines.push('');
  }

  lines.push(blocking ? 'Scout finished with errors.' : 'Scout complete.');

  return lines.join('\n');
}
