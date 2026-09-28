/**
 * Anomaly report assembly, persistence and terminal summary.
 *
 * The report is the only artifact Build 4 writes. It never touches
 * `journey.json` or `execution.json`.
 *
 * The summary deliberately reports "signals observed", never "bugs found". A
 * signal is evidence that something unusual happened; whether it is a defect
 * is not this build's question.
 */

import { writeReport } from '../report/write.js';
import type { Anomaly, AnomalyAnalysisInput, AnomalyAnalysisOptions, AnomalySummary, Interpretation } from './types.js';
import { ANOMALY_SCHEMA_VERSION, RULE_IDS } from './types.js';
import { classifySignals } from './classifier.js';
import { toEnvironmentReference } from '../provenance/reportMetadata.js';
import type { EnvironmentReference } from '../provenance/types.js';
import { TOOL_VERSION } from '../version.js';

/** Default anomaly report path. */
export const DEFAULT_ANOMALY_OUTPUT_PATH = 'reports/anomalies.json';

/** The standing disclaimer, embedded in the artifact itself. */
export const INTERPRETATION_NOTE =
  'These are deterministic signals observed in recorded evidence, not confirmed defects. ' +
  'Confirmation requires reproduction, which is outside this build.';

/** Count signals per category. Pure, so it is directly assertable. */
export function summarizeAnomalies(anomalies: readonly Anomaly[]): AnomalySummary {
  const count = (rule: string): number => anomalies.filter((anomaly) => anomaly.ruleId === rule).length;

  return {
    totalSignals: anomalies.length,
    httpErrors: count(RULE_IDS.http4xx) + count(RULE_IDS.http5xx),
    networkFailures: count(RULE_IDS.networkRequestFailed),
    consoleErrors: count(RULE_IDS.consoleError),
    pageErrors: count(RULE_IDS.pageError),
    timeouts: count(RULE_IDS.stepTimeout),
    navigationSignals: count(RULE_IDS.unexpectedOrigin) + count(RULE_IDS.unexpectedRedirect),
    uiStateSignals: count(RULE_IDS.targetMissingAfterAction) + count(RULE_IDS.targetDisabledAfterAction),
    duplicateRequestSignals: count(RULE_IDS.duplicateRequest),
    stepFailureSignals: count(RULE_IDS.executionActionFailed),
    ruleIds: [...new Set(anomalies.map((anomaly) => anomaly.ruleId))].sort(),
  };
}

/** Warnings about the quality of the analysis itself, not about the target. */
function analysisWarnings(input: AnomalyAnalysisInput): string[] {
  const warnings: string[] = [];
  const raw = input.execution.rawEvidence;

  // Build 5.1: provenance is a first-class output, and its absence is stated
  // rather than papered over. A legacy execution report has no environment.
  if (input.execution.environment === null || input.execution.environment === undefined) {
    warnings.push('Environment provenance is unavailable for this execution report.');
  }

  if (!raw || typeof raw !== 'object') {
    warnings.push('The execution report contains no rawEvidence block; no evidence-based rules could run.');
    return warnings;
  }

  for (const key of ['consoleEvents', 'pageErrors', 'networkEvents'] as const) {
    const list = raw[key];
    if (list === undefined) {
      warnings.push(`rawEvidence.${key} is absent; rules covering it could not run and no signal was invented.`);
    } else if (!Array.isArray(list)) {
      warnings.push(`rawEvidence.${key} is malformed; rules covering it were skipped.`);
    }
  }

  // An aborted run has no evidence for its later steps, so silence there is an
  // artefact of where the run stopped, not evidence that nothing was wrong.
  if (input.execution.status === 'aborted') {
    warnings.push(
      'Execution was aborted, so evidence for later steps does not exist. ' +
        'Absence of a signal is not evidence of absence.',
    );
  }

  return warnings;
}

/** Assemble the full report. Pure. */
export function buildAnomalyReport(
  input: AnomalyAnalysisInput,
  options: AnomalyAnalysisOptions = {},
): {
  schemaVersion: string;
  executionReport: string;
  journeyReport: string;
  executionStatus: string;
  goal: string;
  journeyType: string;
  summary: AnomalySummary;
  anomalies: Anomaly[];
  warnings: string[];
  analyzer: { mode: 'deterministic'; version: string };
  environment: EnvironmentReference;
  interpretation: Interpretation;
} {
  const anomalies = classifySignals({
    execution: input.execution,
    journey: input.journey,
    executionPath: input.executionPath,
    includeConsoleWarnings: options.includeConsoleWarnings === true,
  });

  const interpretation: Interpretation = {
    // Build 4 never confirms a bug.
    confirmedBug: false,
    requiresInvestigation: anomalies.length > 0,
    note: INTERPRETATION_NOTE,
  };

  return {
    schemaVersion: ANOMALY_SCHEMA_VERSION,
    executionReport: input.executionPath,
    journeyReport: input.journeyPath,
    executionStatus: input.execution.status,
    goal: input.execution.goal,
    journeyType: input.execution.journeyType,
    summary: summarizeAnomalies(anomalies),
    anomalies,
    warnings: analysisWarnings(input),
    analyzer: { mode: 'deterministic', version: TOOL_VERSION },
    // Build 5.1: a reference to the environment that produced these signals,
    // so a reader can tell which execution this classification came from.
    environment: toEnvironmentReference(input.execution.environment),
    interpretation,
  };
}

/** The report type, for callers that want to name it. */
export type AnomalyReport = ReturnType<typeof buildAnomalyReport>;

/** Write the anomaly report as JSON. Returns the absolute path written. */
export function writeAnomalyReport(
  report: AnomalyReport,
  outputPath: string = DEFAULT_ANOMALY_OUTPUT_PATH,
  cwd: string = process.cwd(),
): Promise<string> {
  return writeReport(report, outputPath, cwd);
}

/** Line-aligned `Label: value` helper, matching the other summaries. */
function row(label: string, value: string, width = 14): string {
  return `  ${label.padEnd(width)} ${value}`;
}

/**
 * Render the terminal summary. Pure and deterministic.
 *
 * The wording is the point: signals are observed, bugs are not counted,
 * because nothing here has confirmed one.
 */
export function summarizeAnomalyReport(report: AnomalyReport): string {
  const { summary } = report;
  const lines: string[] = [];

  lines.push(`CRASHLAB SCOUT - ANOMALY ENGINE v${report.analyzer.version}`);
  lines.push('');
  lines.push(row('Analyzed:', report.executionReport));
  lines.push(row('Journey:', report.journeyReport));
  lines.push(row('Execution:', report.executionStatus));
  lines.push('');

  lines.push('SIGNALS OBSERVED');
  lines.push(`  Total:            ${summary.totalSignals}`);
  lines.push(`  HTTP errors:      ${summary.httpErrors}`);
  lines.push(`  Network failures: ${summary.networkFailures}`);
  lines.push(`  Console errors:   ${summary.consoleErrors}`);
  lines.push(`  Page errors:      ${summary.pageErrors}`);
  lines.push(`  Timeouts:         ${summary.timeouts}`);
  lines.push(`  Navigation:       ${summary.navigationSignals}`);
  lines.push(`  UI state:         ${summary.uiStateSignals}`);
  lines.push(`  Duplicate reqs:   ${summary.duplicateRequestSignals}`);
  lines.push(`  Step failures:    ${summary.stepFailureSignals}`);
  lines.push('');

  if (summary.ruleIds.length > 0) {
    lines.push(`RULES FIRED (${summary.ruleIds.length})`);
    for (const ruleId of summary.ruleIds) lines.push(`  - ${ruleId}`);
    lines.push('');
  }

  for (const anomaly of report.anomalies) {
    const step = anomaly.stepId === null ? '' : ` [${anomaly.stepId}]`;
    const expected = anomaly.possiblyExpected ? ' (may be expected)' : '';
    lines.push(`  ${anomaly.id}  ${anomaly.signalLevel.padEnd(7)} ${anomaly.ruleId}${step}${expected}`);
    lines.push(`        ${anomaly.message}`);
  }
  if (report.anomalies.length > 0) lines.push('');

  if (report.warnings.length > 0) {
    lines.push(`NOTES (${report.warnings.length})`);
    for (const warning of report.warnings) lines.push(`  - ${warning}`);
    lines.push('');
  }

  lines.push(`Confirmed bugs: ${report.interpretation.confirmedBug ? 'yes' : '0'}`);
  lines.push('Signals are observations about this run, not confirmed defects.');
  lines.push('Anomaly classification is complete; reproduction and confirmation belong to Build 5.');

  return lines.join('\n');
}
