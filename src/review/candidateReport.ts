/**
 * Candidate report assembly and terminal summary.
 *
 * Pure, mirroring the other report builders in the project. The vocabulary is
 * chosen so the summary can never be read as a verdict: "novel signals", never
 * "bugs found".
 */

import { writeReport } from '../report/write.js';
import type { AnomalyReport } from '../anomaly/report.js';
import type { ExecutionReport } from '../executor/types.js';
import type { JourneyPlan } from '../journey/types.js';
import type { ReproductionReport } from '../reproducer/types.js';
import type { Baseline, BaselineIdentity } from '../baseline/types.js';
import { buildBaselineIdentity } from '../baseline/identity.js';
import { classifyCandidates, toCandidates } from './classifier.js';
import { checkCompatibility } from './compatibility.js';
import { REVIEW_SCHEMA_VERSION } from './types.js';
import type { CandidateReport, CandidateSummary } from './types.js';

/** Everything the review needs. */
export interface ReviewInput {
  baseline: Baseline | null;
  execution: ExecutionReport;
  anomalies: AnomalyReport;
  reproduction: ReproductionReport | null;
  journey: JourneyPlan;
  paths: { execution: string; anomalies: string; reproduction: string | null; journey: string; baseline?: string | null };
}

/** Count candidates per classification. */
export function summarizeCandidates(report: CandidateReport): CandidateSummary {
  const count = (classification: string): number =>
    report.candidates.filter((candidate) => candidate.classification === classification).length;

  return {
    totalSignals: report.candidates.length,
    novel: count('novel'),
    persistent: count('persistent'),
    resolved: count('resolved'),
    changed: count('changed'),
    unknown: count('unknown'),
    crossEnvironment: count('cross-environment'),
    differentBuild: count('different-build'),
    reproducedSignals: report.candidates.filter((candidate) => candidate.reproduced).length,
  };
}

/** Build the candidate report. Pure. */
export function buildCandidateReport(input: ReviewInput): CandidateReport {
  const identity: BaselineIdentity = buildBaselineIdentity(input.journey, input.execution);
  const compatibility = checkCompatibility(identity, input.baseline);

  const verdicts = classifyCandidates({
    anomalies: input.anomalies,
    reproduction: input.reproduction,
    baseline: input.baseline,
    compatibility,
  });

  const candidates = toCandidates(verdicts, compatibility.classification);

  const report: CandidateReport = {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    // The baseline path is echoed exactly as supplied, so the report points at
    // the file it was actually read from.
    baseline:
      input.baseline === null
        ? null
        : { baselineId: input.baseline.baselineId, report: input.paths.baseline ?? '(not recorded)' },
    current: {
      executionReport: input.paths.execution,
      anomalyReport: input.paths.anomalies,
      reproductionReport: input.paths.reproduction,
      journeyReport: input.paths.journey,
    },
    comparison: {
      classification: compatibility.classification,
      targetOrigin: identity.targetOrigin,
      journeyHash: identity.journeyHash,
      environmentFingerprint: identity.environmentFingerprint,
      differences: compatibility.differences,
      reason: compatibility.reason,
    },
    summary: {
      totalSignals: 0,
      novel: 0,
      persistent: 0,
      resolved: 0,
      changed: 0,
      unknown: 0,
      crossEnvironment: 0,
      differentBuild: 0,
      reproducedSignals: 0,
    },
    candidates,
    interpretation: {
      // Build 6 confirms nothing and assigns no severity.
      confirmedBug: false,
      automaticSeverity: false,
      candidatesRequireReview: true,
      note:
        'A novel signal means "not present in this baseline", not "defective". ' +
        'Review is a human step: nothing here confirms a bug, ranks severity, or proposes a fix.',
    },
  };

  report.summary = summarizeCandidates(report);
  return report;
}

/** Default candidate report path. */
export const DEFAULT_CANDIDATE_OUTPUT_PATH = 'reports/candidates.json';

/** Write the candidate report. Returns the absolute path written. */
export function writeCandidateReport(
  report: CandidateReport,
  outputPath: string = DEFAULT_CANDIDATE_OUTPUT_PATH,
  cwd: string = process.cwd(),
): Promise<string> {
  return writeReport(report, outputPath, cwd);
}

/** Line-aligned `Label: value` helper, matching the other summaries. */
function row(label: string, value: string | number, width = 20): string {
  return `  ${label.padEnd(width)} ${value}`;
}

/** Render the terminal summary. Never says "bugs found". */
export function summarizeCandidateReport(report: CandidateReport): string {
  const { summary, comparison } = report;
  const lines: string[] = [];

  lines.push('CRASHLAB SCOUT - CANDIDATE REVIEW v0.1.0');
  lines.push('');
  lines.push(row('Baseline:', report.baseline?.baselineId ?? '(none supplied)'));
  lines.push(row('Comparison:', comparison.classification));
  lines.push(row('Target origin:', comparison.targetOrigin ?? '(unknown)'));
  lines.push('');

  lines.push('SIGNALS');
  lines.push(row('Current signals:', summary.totalSignals));
  lines.push(row('Reproduced:', summary.reproducedSignals));
  lines.push(row('Novel:', summary.novel));
  lines.push(row('Persistent:', summary.persistent));
  lines.push(row('Resolved:', summary.resolved));
  lines.push(row('Changed:', summary.changed));
  lines.push(row('Cross-environment:', summary.crossEnvironment));
  lines.push(row('Unknown:', summary.unknown));
  lines.push('');

  for (const candidate of report.candidates) {
    lines.push(`  ${candidate.id}  ${candidate.classification.padEnd(18)} ${candidate.ruleId}  [${candidate.reviewStatus}]`);
    lines.push(`        ${candidate.message}`);
  }
  if (report.candidates.length > 0) lines.push('');

  if (comparison.reason !== null) {
    lines.push('NOTE');
    lines.push(`  ${comparison.reason}`);
    lines.push('');
  }

  lines.push(`Confirmed bugs: ${report.interpretation.confirmedBug ? 'yes' : '0'}`);
  lines.push('A novel signal is a lead for review, not a confirmed defect.');
  lines.push('Build 6 assigns no severity and proposes no fix.');

  return lines.join('\n');
}
