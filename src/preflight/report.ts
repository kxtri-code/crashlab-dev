/**
 * Preflight Report Formatter & Writer — Build 10.2.
 *
 * Deterministic human-readable summaries and JSON artifact writer.
 * Never outputs sensitive credentials or secret values.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { PreflightReport } from './types.js';
import { TOOL_NAME, TOOL_VERSION } from '../version.js';

/** Format a human-readable terminal summary of the preflight report. */
export function formatPreflightSummary(report: PreflightReport): string {
  const lines: string[] = [];

  const statusBadge =
    report.status === 'ready'
      ? 'READY (Safe for pilot execution)'
      : report.status === 'blocked'
        ? 'BLOCKED (Prerequisites missing)'
        : 'INVALID (Configuration rejected)';

  lines.push(`${TOOL_NAME} - PILOT PREFLIGHT VALIDATOR v${TOOL_VERSION}`);
  lines.push('');
  lines.push(`  Status:               ${statusBadge}`);
  lines.push(`  Target Name:          ${report.target.name || '(unnamed)'}`);
  lines.push(`  Target Environment:   ${report.target.environment}`);
  lines.push(`  Target URL:           ${report.target.url || '(none)'}`);
  lines.push(`  Target Origin:        ${report.target.origin || '(unresolved)'}`);
  if (report.target.appBuildId) {
    lines.push(`  Application Build:    ${report.target.appBuildId}`);
  }
  lines.push(`  Allowed Origins:      ${report.allowedOrigins.join(', ') || '(none)'}`);
  lines.push(`  Approved Journeys:    ${report.journeys.length}`);
  lines.push(`  Test Data Configured: ${report.testDataConfigured ? 'yes (protected path)' : 'no'}`);
  lines.push(`  Authorization Ref:    ${report.authorizationConfigured ? 'yes (non-secret reference)' : 'no'}`);
  lines.push('');

  lines.push('SAFETY CHECKS');
  for (const check of report.safetyChecks) {
    const mark = check.passed ? '✓' : '✗';
    const detail = check.reason ? ` - ${check.reason}` : '';
    lines.push(`  ${mark} [${check.category}] ${check.name}${detail}`);
  }

  if (report.failureReasons.length > 0) {
    lines.push('');
    lines.push('REASONS PREFLIGHT FAILED:');
    for (const reason of report.failureReasons) {
      lines.push(`  - ${reason}`);
    }
  }

  lines.push('');
  lines.push(`INVARIANT: ${report.statement}`);

  return lines.join('\n');
}

/** Deterministically write JSON report to disk. */
export async function writePreflightReport(
  report: PreflightReport,
  outputPath: string,
): Promise<string> {
  const absolutePath = resolve(process.cwd(), outputPath);
  await mkdir(dirname(absolutePath), { recursive: true });
  const serialized = JSON.stringify(report, null, 2) + '\n';
  await writeFile(absolutePath, serialized, 'utf8');
  return absolutePath;
}
