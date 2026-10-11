/**
 * Candidate classification.
 *
 * One current signal in, one verdict out. The rules are ordered so the *safe*
 * answer wins by default: a signal only becomes `novel` when reproduction
 * confirmed it **and** the comparison is valid, and every other situation falls
 * through to `unknown` with a stated reason.
 *
 * The one rule worth stating plainly: **a signal observed once is not a
 * candidate defect.** Without reproduction, a one-off is as likely to be a
 * transient as a fault, and promoting it would fill the review queue with noise
 * and train a reviewer to ignore it.
 *
 * Pure. No I/O, no browser, no network.
 */

import type { Anomaly } from '../anomaly/types.js';
import type { AnomalyReport } from '../anomaly/report.js';
import type { ReproductionReport } from '../reproducer/types.js';
import { matchingKeyFor } from '../reproducer/normalization.js';
import { signalKeyHash } from '../baseline/identity.js';
import type { Baseline, BaselineSignal } from '../baseline/types.js';
import type { CompatibilityResult } from './compatibility.js';
import type { Candidate, CandidateClassification, ReviewComparison, ReviewStatus } from './types.js';

/** Classification priority, so a deterministic order is guaranteed. */
const CLASSIFICATION_ORDER: Record<CandidateClassification, number> = {
  novel: 0,
  reintroduced: 1,
  changed: 2,
  persistent: 3,
  resolved: 4,
  'different-build': 5,
  'cross-environment': 6,
  unknown: 7,
};

/** Build 5 classifications that count as a confirmed reproduction. */
const REPRODUCED = new Set(['reproduced']);

/** Everything the classifier reads. */
export interface ClassificationContext {
  anomalies: AnomalyReport;
  reproduction: ReproductionReport | null;
  baseline: Baseline | null;
  compatibility: CompatibilityResult;
  /**
   * Step ids whose expectation the current execution left unverified. Sourced
   * from `execution.json`; a signal on one of these is not evidence of novelty.
   */
  unverifiedStepIds: readonly string[];
  /** Build 7: ancestor baselines from oldest to newest or newest to oldest. */
  ancestorBaselines?: readonly Baseline[];
  /** Build 7: execution status of the current run, for absence reliability. */
  executionStatus?: string;
}

/** The verdict for one signal, before ids are assigned. */
interface Verdict {
  anomaly: Anomaly;
  classification: CandidateClassification;
  reviewStatus: ReviewStatus;
  reproduced: boolean;
  baselinePresent: boolean;
  currentPresent: boolean;
  message: string;
  requiresInvestigation: boolean;
  reproductionClassification: string | null;
  stepOrder: number | null;
  relatedBaselineKey: string | null;
  baselineKeys: string[];
}

/** Map a review status to its human phrasing. */
function statusFor(classification: CandidateClassification): ReviewStatus {
  switch (classification) {
    case 'novel':
    case 'reintroduced':
    case 'changed':
      return 'needs-review';
    case 'persistent':
      return 'known-existing';
    case 'resolved':
      return 'not-present';
    default:
      return 'inconclusive';
  }
}

/**
 * Find a baseline signal that is the same signal with a different detail.
 *
 * Same rule and same target, but a safe field differs - a 404 becoming a 500, a
 * GET becoming a POST. That is a change worth reviewing, not a new signal and
 * not a persistent one.
 */
function findChangedBaselineSignal(
  currentKey: string,
  anomaly: Anomaly,
  known: readonly BaselineSignal[],
): BaselineSignal | null {
  const currentRule = currentKey.split('|')[0] ?? '';

  return (
    known.find((signal) => {
      if (signal.ruleId !== anomaly.ruleId) return false;
      if (signal.signalKey === currentKey) return false;
      // Same rule and same step: the same signal in a different state, rather
      // than two unrelated signals that happen to share a rule.
      if ((signal.stepId ?? '') !== (anomaly.stepId ?? '')) return false;
      // And it must be the same target, identified by the shared key prefix
      // (method + url + resource type for network signals).
      return signal.signalKey.split('|')[0] === currentRule && signal.signalKey !== currentKey;
    }) ?? null
  );
}

/**
 * Look for a signal in compatible ancestor baselines.
 *
 * A signal is reintroduced only when:
 *  - it was present in an ancestor baseline
 *  - it was absent from intermediate baseline(s) (including the selected baseline)
 *  - the lineage is explicit
 */
function findAncestorSignal(
  signalKey: string,
  ancestors: readonly Baseline[] | undefined,
): { baseline: Baseline; signal: BaselineSignal } | null {
  if (!ancestors || ancestors.length === 0) return null;

  for (const ancestor of ancestors) {
    const found = ancestor.knownSignals.find((s) => s.signalKey === signalKey);
    if (found) {
      return { baseline: ancestor, signal: found };
    }
  }

  return null;
}

/** Classify every current signal against the baseline. */
export function classifyCandidates(context: ClassificationContext): Verdict[] {
  const {
    anomalies,
    reproduction,
    baseline,
    compatibility,
    unverifiedStepIds: unverifiedStepIdsInput,
    ancestorBaselines,
    executionStatus,
  } = context;
  const known = baseline?.knownSignals ?? [];

  // Reproduction result per anomaly id, so a signal is only judged on evidence
  // Build 5 actually produced.
  const reproductionByAnomaly = new Map<string, { id: string; classification: string }>();
  for (const result of reproduction?.results ?? []) {
    reproductionByAnomaly.set(result.anomalyId, { id: result.id, classification: result.classification });
  }

  // Build 6.1: steps whose expectation was never evaluated. A signal attached
  // to one of these cannot support a novelty claim. Sourced from the execution
  // report the anomalies were classified from, not invented here.
  const unverifiedStepIds = new Set<string>(unverifiedStepIdsInput);

  const classifyCurrent = (): Verdict[] =>
    anomalies.anomalies.map((anomaly) => {
    const signalKey = matchingKeyFor(anomaly);
    const repro = reproductionByAnomaly.get(anomaly.id) ?? null;
    const reproduced = repro !== null && REPRODUCED.has(repro.classification);
    const stepOrder = typeof anomaly.stepOrder === 'number' ? anomaly.stepOrder : null;

    // --- no stable key: nothing to compare ------------------------------
    if (signalKey === null) {
      return verdict(anomaly, 'unknown', reproduced, false, true, {
        message:
          'The signal has no stable comparison key, so it cannot be matched against a baseline. ' +
          'The observation is preserved in the anomaly report.',
        requiresInvestigation: false,
        reproductionClassification: repro?.classification ?? null,
        stepOrder,
        relatedBaselineKey: null,
        baselineKeys: [],
      });
    }

    const match = known.find((signal) => signal.signalKey === signalKey);

    // --- no baseline, or an impossible comparison ------------------------
    if (baseline === null || !compatibility.comparable) {
      return verdict(anomaly, 'unknown', reproduced, match !== undefined, true, {
        message: unknownReason(compatibility, reproduced, repro?.classification ?? null),
        requiresInvestigation: false,
        reproductionClassification: repro?.classification ?? null,
        stepOrder,
        relatedBaselineKey: null,
        baselineKeys: match ? [match.signalKey] : [],
      });
    }

    // --- reproduction gates every "real" verdict -------------------------
    // An unreproduced, inconclusive or blocked signal is never a candidate
    // defect, however well the baseline matches.
    if (!reproduced) {
      return verdict(anomaly, 'unknown', false, match !== undefined, true, {
        message: notReproducedReason(repro?.classification ?? null, signalKey),
        requiresInvestigation: false,
        reproductionClassification: repro?.classification ?? null,
        stepOrder,
        relatedBaselineKey: null,
        baselineKeys: match ? [match.signalKey] : [],
      });
    }

    // --- different environment: not novel, not persistent -----------------
    if (compatibility.classification === 'different-environment') {
      return verdict(anomaly, 'cross-environment', true, match !== undefined, true, {
        message:
          'The signal reproduced, but in a different recorded environment than the baseline. ' +
          'It is neither novel nor persistent until the environments are reconciled.',
        requiresInvestigation: true,
        reproductionClassification: repro?.classification ?? null,
        stepOrder,
        relatedBaselineKey: null,
        baselineKeys: match ? [match.signalKey] : [],
      });
    }

    // Build 6.1: a signal from an unverified assertion is not evidence of
    // novelty. Nobody established what that step was supposed to prove, so
    // neither "new" nor "already known" is supportable.
    if (unverifiedStepIds.has(anomaly.id)) {
      return verdict(anomaly, 'unknown', true, match !== undefined, true, {
        message:
          'The signal belongs to a step whose expectation was left unverified, so it cannot be called novel or persistent. ' +
          'The observation is preserved for a human to judge.',
        requiresInvestigation: false,
        reproductionClassification: repro?.classification ?? null,
        stepOrder,
        relatedBaselineKey: null,
        baselineKeys: match ? [match.signalKey] : [],
      });
    }

    // --- same environment: the real verdicts -----------------------------
    if (match === undefined) {
      const changed = findChangedBaselineSignal(signalKey, anomaly, known);
      if (changed !== null) {
        return verdict(anomaly, 'changed', true, true, true, {
          message: describeChange(anomaly, changed),
          requiresInvestigation: true,
          reproductionClassification: repro?.classification ?? null,
          stepOrder,
          relatedBaselineKey: changed.signalKey,
          baselineKeys: [changed.signalKey],
        });
      }

      // Build 7: check for reintroduced signal in ancestor baselines
      const ancestorWithSignal = findAncestorSignal(signalKey, ancestorBaselines);
      if (ancestorWithSignal !== null) {
        return verdict(anomaly, 'reintroduced', true, false, true, {
          message:
            `A reproducible signal was present in ancestor baseline "${ancestorWithSignal.baseline.baselineId}", ` +
            `was absent from intermediate baseline "${baseline.baselineId}", and has reappeared in the current run. ` +
            'Reintroduced indicates recurrence across baseline versions.',
          requiresInvestigation: true,
          reproductionClassification: repro?.classification ?? null,
          stepOrder,
          relatedBaselineKey: ancestorWithSignal.signal.signalKey,
          baselineKeys: [ancestorWithSignal.signal.signalKey],
        });
      }

      return verdict(anomaly, 'novel', true, false, true, {
        message:
          'A reproducible signal was not present in the compatible known-good baseline. ' +
          'Novel means new relative to the baseline; it does not mean defective.',
        requiresInvestigation: true,
        reproductionClassification: repro?.classification ?? null,
        stepOrder,
        relatedBaselineKey: null,
        baselineKeys: [],
      });
    }

    return verdict(anomaly, 'persistent', true, true, true, {
      message: 'The signal is present in the known-good baseline and reproduced again. It was already expected.',
      requiresInvestigation: false,
      reproductionClassification: repro?.classification ?? null,
      stepOrder,
      relatedBaselineKey: null,
      baselineKeys: [match.signalKey],
    });
    });

  /** Signals that were in the baseline but are gone now. */
  function resolvedFromBaseline(anomaliesSeen: ReadonlySet<string>): Verdict[] {
    if (baseline === null || !compatibility.comparable) return [];
    if (compatibility.classification === 'different-environment') return [];
    const executionIncomplete =
      reproduction === null ||
      (executionStatus !== undefined && ['aborted', 'failed', 'blocked'].includes(executionStatus));

    const resolved: Verdict[] = [];
    for (const signal of known) {
      if (anomaliesSeen.has(signal.signalKey)) continue;

      if (executionIncomplete) {
        resolved.push({
          anomaly: {
            id: `baseline:${signal.anomalyId}`,
            ruleId: signal.ruleId as Anomaly['ruleId'],
            kind: signal.kind as Anomaly['kind'],
            signalLevel: signal.signalLevel as Anomaly['signalLevel'],
            status: 'observed',
            message: '',
            stepId: signal.stepId,
            stepOrder: null,
            source: { executionReport: '', evidenceType: 'network', eventIndex: null },
            details: {},
            possiblyExpected: signal.accepted,
            confirmed: false,
            occurrences: 1,
          },
          classification: 'unknown',
          reviewStatus: 'inconclusive',
          reproduced: false,
          baselinePresent: true,
          currentPresent: false,
          message:
            'A signal recorded in the known-good baseline was not observed, but the current run failed, blocked, or was aborted. ' +
            'Absence cannot be established reliably.',
          requiresInvestigation: false,
          reproductionClassification: null,
          stepOrder: null,
          relatedBaselineKey: signal.signalKey,
          baselineKeys: [signal.signalKey],
        });
        continue;
      }

      resolved.push({
        anomaly: {
          id: `baseline:${signal.anomalyId}`,
          ruleId: signal.ruleId as Anomaly['ruleId'],
          kind: signal.kind as Anomaly['kind'],
          signalLevel: signal.signalLevel as Anomaly['signalLevel'],
          status: 'observed',
          message: '',
          stepId: signal.stepId,
          stepOrder: null,
          source: { executionReport: '', evidenceType: 'network', eventIndex: null },
          details: {},
          possiblyExpected: signal.accepted,
          confirmed: false,
          occurrences: 1,
        },
        classification: 'resolved',
        reviewStatus: 'not-present',
        reproduced: false,
        baselinePresent: true,
        currentPresent: false,
        message:
          'A signal recorded in the known-good baseline is no longer present. ' +
          'Absence is only meaningful when the current run completed enough to exercise it.',
        requiresInvestigation: false,
        reproductionClassification: null,
        stepOrder: null,
        relatedBaselineKey: signal.signalKey,
        baselineKeys: [signal.signalKey],
      });
    }
    return resolved;
  }

  return [
    ...classifyCurrent(),
    ...resolvedFromBaseline(
      new Set(anomalies.anomalies.map((a) => matchingKeyFor(a)).filter((k): k is string => k !== null)),
    ),
  ].sort(compareVerdicts);
}

/** Assemble one verdict. */
function verdict(
  anomaly: Anomaly,
  classification: CandidateClassification,
  reproduced: boolean,
  baselinePresent: boolean,
  currentPresent: boolean,
  extra: {
    message: string;
    requiresInvestigation: boolean;
    reproductionClassification: string | null;
    stepOrder: number | null;
    relatedBaselineKey: string | null;
    baselineKeys: string[];
  },
): Verdict {
  return {
    anomaly,
    classification,
    reviewStatus: statusFor(classification),
    reproduced,
    baselinePresent,
    currentPresent,
    // Named explicitly, because the spread below would otherwise overwrite them.
    reproductionClassification: extra.reproductionClassification,
    stepOrder: extra.stepOrder,
    relatedBaselineKey: extra.relatedBaselineKey,
    baselineKeys: extra.baselineKeys,
    message: extra.message,
    requiresInvestigation: extra.requiresInvestigation,
  };
}

/** Deterministic ordering: classification, then step, then rule, then key. */
function compareVerdicts(a: Verdict, b: Verdict): number {
  return (
    CLASSIFICATION_ORDER[a.classification] - CLASSIFICATION_ORDER[b.classification] ||
    (a.stepOrder ?? -1) - (b.stepOrder ?? -1) ||
    a.anomaly.ruleId.localeCompare(b.anomaly.ruleId) ||
    (matchingKeyFor(a.anomaly) ?? '').localeCompare(matchingKeyFor(b.anomaly) ?? '') ||
    a.anomaly.id.localeCompare(b.anomaly.id)
  );
}

/** Why a comparison was impossible. */
function unknownReason(compatibility: CompatibilityResult, reproduced: boolean, repro: string | null): string {
  if (compatibility.reason !== null) return compatibility.reason;
  if (!reproduced && repro !== null) return notReproducedReason(repro, '');
  return 'The current run could not be compared against the baseline.';
}

/** Why a signal was not treated as a candidate. */
function notReproducedReason(repro: string | null, signalKey: string): string {
  const suffix = signalKey === '' ? '' : ' The observation is preserved in the anomaly report.';
  if (repro === 'inconclusive') {
    return `The signal reproduced in only some controlled attempts, so the outcome is inconclusive and it is not a candidate.${suffix}`;
  }
  if (repro === 'blocked') {
    return `Reproduction was blocked, so the signal could not be evaluated and is not a candidate.${suffix}`;
  }
  if (repro === 'not-reproduced') {
    return 'The signal did not recur in any controlled attempt, so it is not a candidate defect.' + suffix;
  }
  return (
    'The signal was observed but never reproduced, so it is not a candidate defect. ' +
    'A one-off observation is as likely to be transient as it is to be a fault.' + suffix
  );
}

/** Describe what changed between two related signals. */
function describeChange(anomaly: Anomaly, baseline: BaselineSignal): string {
  const changes: string[] = [];
  const currentStatus = anomaly.details?.['statusCode'];
  if (currentStatus !== undefined && currentStatus !== null && currentStatus !== baseline.statusCode) {
    changes.push(`status ${baseline.statusCode ?? 'none'} to ${String(currentStatus)}`);
  }
  const currentMethod = anomaly.details?.['method'];
  if (currentMethod !== undefined && currentMethod !== null && currentMethod !== baseline.method) {
    changes.push(`method ${baseline.method ?? 'none'} to ${String(currentMethod)}`);
  }
  if (changes.length === 0) changes.push('a safe identifying detail');

  return (
    `A related signal is present in the known-good baseline, but it changed (${changes.join('; ')}). ` +
    'A change in an expected signal is worth reviewing.'
  );
}

/** Assign stable candidate ids and project verdicts into the report shape. */
export function toCandidates(verdicts: readonly Verdict[], comparison: ReviewComparison): Candidate[] {
  return verdicts.map((entry, index) => ({
    id: `candidate-${String(index + 1).padStart(3, '0')}`,
    signalKeyHash: signalKeyHash(matchingKeyFor(entry.anomaly) ?? entry.anomaly.id),
    ruleId: entry.anomaly.ruleId,
    kind: entry.anomaly.kind,
    classification: entry.classification,
    reviewStatus: entry.reviewStatus,
    // Build 6 confirms nothing.
    confirmed: false as const,
    reproduced: entry.reproduced,
    baselinePresent: entry.baselinePresent,
    currentPresent: entry.currentPresent,
    // The run-level comparison, not a per-signal one: a signal cannot be in a
    // different environment when the run was not.
    environmentComparison: comparison,
    evidence: {
      currentAnomalyIds: entry.currentPresent ? [entry.anomaly.id] : [],
      reproductionResultIds: entry.reproductionClassification === null ? [] : [entry.anomaly.id],
      baselineSignalKeys: entry.baselineKeys,
      relatedBaselineSignalKey: entry.relatedBaselineKey,
    },
    message: entry.message,
    requiresInvestigation: entry.requiresInvestigation,
    reproductionClassification: entry.reproductionClassification,
    stepOrder: entry.stepOrder,
  }));
}
