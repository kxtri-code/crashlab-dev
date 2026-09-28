/**
 * Reproduction report assembly and terminal summary.
 *
 * The report references the per-attempt artifacts rather than copying them. An
 * execution report contains raw evidence; inlining it would bloat the file and
 * create a second place for a sensitive value to appear.
 *
 * The summary reports *signals*, never bugs. A reproduced signal is a candidate
 * for investigation, and the artifact says so in its own `interpretation`.
 */

import { writeReport } from '../report/write.js';
import type { Anomaly } from '../anomaly/types.js';
import { TOOL_VERSION } from '../version.js';
import { partitionEligible } from './eligibility.js';
import { classifyReproduction, formatRatio } from './resultClassifier.js';
import { matchingKeyFor } from './normalization.js';
import type {
  ReproductionInput,
  ReproductionReport,
  ReproductionResult,
  ReproductionRun,
  ReproductionSummary,
} from './types.js';
import { REPRODUCTION_SCHEMA_VERSION } from './types.js';

/** Default reproduction report path. */
export const DEFAULT_REPRODUCTION_OUTPUT_PATH = 'reports/reproduction.json';

/** The standing disclaimer, embedded in the artifact itself. */
export const REPRODUCTION_NOTE =
  'A reproduced signal is evidence that the condition recurs under controlled execution. ' +
  'It is a candidate for investigation, not a confirmed defect. Confirmation requires a human ' +
  'or investigative review, which is outside this build.';

/** Count results per classification. Pure and assertable. */
export function summarizeResults(results: readonly ReproductionResult[]): ReproductionSummary {
  const count = (classification: ReproductionResult['classification']): number =>
    results.filter((result) => result.classification === classification).length;

  return {
    totalSignals: results.length,
    eligibleSignals: results.filter((result) => result.classification !== 'ineligible').length,
    reproduced: count('reproduced'),
    notReproduced: count('not-reproduced'),
    inconclusive: count('inconclusive'),
    blocked: count('blocked'),
    ineligible: count('ineligible'),
    candidatesRequiringInvestigation: count('reproduced'),
  };
}

/**
 * Compare every original signal against the attempts.
 *
 * Ineligible signals are reported without being compared, so the output
 * accounts for every signal the input contained rather than silently dropping
 * the ones that were excluded.
 */
export function buildResults(input: ReproductionInput, attempts: readonly ReproductionRun[]): ReproductionResult[] {
  const { eligible, ineligible } = partitionEligible(input.anomalies.anomalies, input.includePossiblyExpected);
  const completedAttempts = attempts.filter((run) => run.status === 'completed').length;

  const results: ReproductionResult[] = [];

  // Ineligible signals first, so the output mirrors the input's own ordering
  // and a reader can line the two reports up.
  for (const entry of ineligible) {
    const anomaly: Anomaly = entry.anomaly;
    results.push({
      id: `reproduction-${String(results.length + 1).padStart(3, '0')}`,
      anomalyId: anomaly.id,
      ruleId: anomaly.ruleId,
      classification: 'ineligible',
      confirmed: false,
      matchingAttempts: 0,
      completedAttempts,
      inconclusiveAttempts: 0,
      reproductionRatio: formatRatio(0, completedAttempts),
      matchingKey: null,
      evidence: [],
      reason: entry.reason.detail,
      ineligibleBecause: entry.reason,
      requiresInvestigation: false,
    });
  }

  for (const anomaly of eligible) {
    const outcome = classifyReproduction(anomaly, attempts);
    const runByAttempt = new Map(attempts.map((run) => [run.attempt, run]));

    results.push({
      id: `reproduction-${String(results.length + 1).padStart(3, '0')}`,
      anomalyId: anomaly.id,
      ruleId: anomaly.ruleId,
      classification: outcome.classification,
      // Build 5 confirms nothing.
      confirmed: false,
      matchingAttempts: outcome.matchingAttempts,
      completedAttempts: outcome.completedAttempts,
      inconclusiveAttempts: outcome.inconclusiveAttempts,
      reproductionRatio: formatRatio(outcome.matchingAttempts, outcome.completedAttempts),
      matchingKey: matchingKeyFor(anomaly),
      evidence: outcome.matches.map((match) => {
        const run = runByAttempt.get(match.attempt);
        return {
          attempt: match.attempt,
          executionReport: run?.executionReport ?? '(not recorded)',
          anomalyReport: run?.anomalyReport ?? '(not recorded)',
          anomalyId: match.anomalyId,
        };
      }),
      reason: outcome.reason,
      ineligibleBecause: null,
      // A reproducible signal is a lead for a human, not a verdict.
      requiresInvestigation: outcome.classification === 'reproduced',
    });
  }

  return results;
}

/** Assemble the full report. Pure. */
export function buildReproductionReport(input: ReproductionInput, attempts: readonly ReproductionRun[]): ReproductionReport {
  const results = buildResults(input, attempts);
  const completed = attempts.filter((run) => run.status === 'completed');
  const blocked = attempts.filter((run) => run.status === 'blocked');
  const failed = attempts.filter((run) => run.status === 'failed');

  return {
    schemaVersion: REPRODUCTION_SCHEMA_VERSION,
    journeyReport: input.journeyPath,
    anomalyReport: input.anomalyPath,
    executionReport: input.executionPath,
    goal: input.journey.goal,
    summary: summarizeResults(results),
    // The in-memory execution and anomaly reports are deliberately not copied
    // into this file; the paths above point at them instead.
    runs: attempts.map(({ attempt, name, executionReport, anomalyReport, status, detail }) => ({
      attempt,
      name,
      executionReport,
      anomalyReport,
      status,
      detail,
    })),
    results,
    safety: {
      authorizedConfirmationRequired: true,
      safeTestMode: true,
      livePaymentAllowed: false,
      sensitiveValuesRedacted: true,
      attemptsBlockedBySafety: blocked.length,
    },
    reproducer: {
      mode: 'controlled-deterministic',
      version: TOOL_VERSION,
      // Declared attempts under an explicit budget, not hidden retries.
      automaticRetries: false,
      attemptsRequested: input.attempts,
      attemptsCompleted: completed.length,
      attemptsBlocked: blocked.length,
      attemptsFailed: failed.length,
    },
    interpretation: {
      // Build 5 confirms nothing automatically.
      confirmedBug: false,
      reproducedSignalsAreCandidatesOnly: true,
      note: REPRODUCTION_NOTE,
    },
  };
}

/** Write the reproduction report as JSON. Returns the absolute path written. */
export function writeReproductionReport(
  report: ReproductionReport,
  outputPath: string = DEFAULT_REPRODUCTION_OUTPUT_PATH,
  cwd: string = process.cwd(),
): Promise<string> {
  return writeReport(report, outputPath, cwd);
}

/** Line-aligned `Label: value` helper, matching the other summaries. */
function row(label: string, value: string | number, width = 24): string {
  return `  ${label.padEnd(width)} ${value}`;
}

/** Render the terminal summary. Pure, and never says "bug". */
export function summarizeReproductionReport(report: ReproductionReport): string {
  const { summary, reproducer } = report;
  const lines: string[] = [];

  lines.push(`CRASHLAB SCOUT - CONTROLLED REPRODUCER v${reproducer.version}`);
  lines.push('');
  lines.push(row('Goal:', report.goal || '(empty)'));
  lines.push(row('Anomalies:', report.anomalyReport));
  lines.push(row('Journey:', report.journeyReport));
  lines.push('');

  lines.push('ATTEMPTS');
  lines.push(row('Requested:', reproducer.attemptsRequested));
  lines.push(row('Completed:', reproducer.attemptsCompleted));
  lines.push(row('Blocked:', reproducer.attemptsBlocked));
  lines.push(row('Failed:', reproducer.attemptsFailed));
  lines.push(row('Automatic retries:', reproducer.automaticRetries ? 'yes' : 'no (declared attempts only)'));
  lines.push('');

  lines.push('SIGNALS');
  lines.push(row('Total signals:', summary.totalSignals));
  lines.push(row('Eligible:', summary.eligibleSignals));
  lines.push(row('Reproduced:', summary.reproduced));
  lines.push(row('Not reproduced:', summary.notReproduced));
  lines.push(row('Inconclusive:', summary.inconclusive));
  lines.push(row('Blocked:', summary.blocked));
  lines.push(row('Ineligible:', summary.ineligible));
  lines.push(row('Candidates for review:', summary.candidatesRequiringInvestigation));
  lines.push('');

  for (const result of report.results) {
    const ratio = result.completedAttempts > 0 ? ` (${result.reproductionRatio})` : '';
    lines.push(`  ${result.id}  ${result.ruleId.padEnd(30)} ${result.classification}${ratio}`);
    lines.push(`        ${result.reason}`);
  }
  if (report.results.length > 0) lines.push('');

  lines.push(`Confirmed bugs: ${report.interpretation.confirmedBug ? 'yes' : '0'}`);
  lines.push('A reproduced signal recurs under controlled execution; it is a candidate, not a confirmed defect.');
  lines.push('Reproduction is complete. Confirmation and root-cause analysis are outside this build.');

  return lines.join('\n');
}
