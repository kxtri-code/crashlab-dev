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
import type {
  BaselineHistoryEntry,
  CandidateBaselineDecision,
  CandidateReport,
  CandidateSelectionMode,
  CandidateSummary,
} from './types.js';

/** Everything the review needs. */
export interface ReviewInput {
  baseline: Baseline | null;
  execution: ExecutionReport;
  anomalies: AnomalyReport;
  reproduction: ReproductionReport | null;
  journey: JourneyPlan;
  paths: { execution: string; anomalies: string; reproduction: string | null; journey: string; baseline?: string | null };
  /** Build 7: selection mode used to choose the baseline. */
  selectionMode?: CandidateSelectionMode;
  /** Build 7: decisions made during candidate evaluation. */
  candidatesConsidered?: CandidateBaselineDecision[];
  /** Build 7: ancestor baselines in the lineage chain. */
  ancestorBaselines?: Baseline[];
}

/** Count candidates per classification. */
export function summarizeCandidates(report: CandidateReport): CandidateSummary {
  const count = (classification: string): number =>
    report.candidates.filter((candidate) => candidate.classification === classification).length;

  return {
    totalSignals: report.candidates.length,
    novel: count('novel'),
    reintroduced: count('reintroduced'),
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
    // Read from the execution report rather than inferred, so a legacy report
    // simply yields none.
    unverifiedStepIds: input.execution.verification?.unverifiedStepIds ?? [],
    ancestorBaselines: input.ancestorBaselines,
    executionStatus: input.execution.status,
  });

  const candidates = toCandidates(verdicts, compatibility.classification, identity);

  // Build 6.1: a partially verified baseline narrows every verdict below. The
  // limit is stated rather than absorbed, so "novel" is never read as
  // "novel across the whole plan" when the baseline never saw the whole plan.
  const baselineVerification: CandidateReport['baselineVerification'] =
    input.baseline === null
      ? null
      : {
          status: input.baseline.verification?.complete ? 'complete' : input.baseline.verification ? 'partial' : 'unavailable',
          coverage: input.baseline.verification?.coverage ?? 'unavailable',
          unverifiedAssertions: input.baseline.verification?.unverifiedAssertions ?? 0,
        };

  const comparisonLimitations: string[] = [];
  if (baselineVerification !== null && !baselineVerification.status.includes('complete')) {
    comparisonLimitations.push(
      `The baseline was only partially verified (${baselineVerification.unverifiedAssertions} unverified expectation(s)).`,
    );
    comparisonLimitations.push('Comparison covers executed steps only, not the full journey plan.');
  }
  if (input.execution.verification && !input.execution.verification.complete) {
    comparisonLimitations.push(
      `The current run left ${input.execution.verification.unverifiedAssertions} expectation(s) unverified.`,
    );
  }
  // Build 7: ancestor limitations
  for (const ancestor of input.ancestorBaselines ?? []) {
    if (ancestor.status === 'known-good-partial') {
      comparisonLimitations.push(`Ancestor baseline "${ancestor.baselineId}" was partially verified.`);
    }
    if (ancestor.status === 'known-good-declared') {
      comparisonLimitations.push(`Ancestor baseline "${ancestor.baselineId}" used operator-declared expectations.`);
    }
  }
  if (comparisonLimitations.length === 0) {
    comparisonLimitations.push('None: both the baseline and the current run were fully verified.');
  }

  // Build 7: history representation of lineage
  const history: BaselineHistoryEntry[] = [];
  if (input.baseline !== null) {
    history.push({
      baselineId: input.baseline.baselineId,
      name: input.baseline.name,
      targetOrigin: input.baseline.identity.targetOrigin,
      journeyHash: input.baseline.identity.journeyHash,
      applicationBuildId: input.baseline.identity.applicationBuildId,
      status: input.baseline.status,
      coverage: input.baseline.verification.coverage,
      createdAt: input.baseline.createdAt,
      parentBaselineId: input.baseline.parentBaselineId,
      relationship: 'selected',
    });
    for (const ancestor of input.ancestorBaselines ?? []) {
      history.push({
        baselineId: ancestor.baselineId,
        name: ancestor.name,
        targetOrigin: ancestor.identity.targetOrigin,
        journeyHash: ancestor.identity.journeyHash,
        applicationBuildId: ancestor.identity.applicationBuildId,
        status: ancestor.status,
        coverage: ancestor.verification.coverage,
        createdAt: ancestor.createdAt,
        parentBaselineId: ancestor.parentBaselineId,
        relationship: 'ancestor',
      });
    }
  }

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
    baselineVerification,
    comparisonLimitations,
    summary: {
      totalSignals: 0,
      novel: 0,
      reintroduced: 0,
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
    selectionMode: input.selectionMode ?? (input.baseline ? 'explicit' : 'none'),
    selectedBaselineId: input.baseline?.baselineId ?? null,
    parentBaselineId: input.baseline?.parentBaselineId ?? null,
    lineage: input.baseline?.lineage ?? null,
    candidatesConsidered: input.candidatesConsidered ?? [],
    history,
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
  lines.push(row('Baseline:', report.baseline?.baselineId ?? '(none supplied)'));
  if (report.selectionMode && report.selectionMode !== 'none') {
    lines.push(row('Selection Mode:', report.selectionMode));
  }
  if (report.parentBaselineId) {
    lines.push(row('Parent Baseline:', report.parentBaselineId));
  }
  if (report.lineage) {
    lines.push(row('Lineage Depth:', report.lineage.depth));
  }
  lines.push(row('Comparison:', comparison.classification));
  lines.push(row('Target origin:', comparison.targetOrigin ?? '(unknown)'));
  lines.push(
    row('Baseline verified:', report.baselineVerification === null ? '(no baseline)' : report.baselineVerification.coverage),
  );
  lines.push('');

  lines.push('SIGNALS');
  lines.push(row('Current signals:', summary.totalSignals));
  lines.push(row('Reproduced:', summary.reproducedSignals));
  lines.push(row('Novel:', summary.novel));
  lines.push(row('Reintroduced:', summary.reintroduced));
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

  lines.push('LIMITS OF THIS COMPARISON');
  for (const limitation of report.comparisonLimitations) {
    lines.push(`  - ${limitation}`);
  }
  lines.push('');

  lines.push(`Confirmed bugs: ${report.interpretation.confirmedBug ? 'yes' : '0'}`);
  lines.push('A novel signal is a lead for review, not a confirmed defect.');
  lines.push('Build 6 assigns no severity and proposes no fix.');

  return lines.join('\n');
}
