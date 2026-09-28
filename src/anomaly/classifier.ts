/**
 * Deterministic signal classification and ordering.
 *
 * The rules in `rules.ts` return unordered signals. This module assigns stable
 * ids, deduplicates identical observations, and orders the result so the same
 * inputs always produce byte-identical output.
 *
 * Ordering, in priority sequence:
 *   1. step order (a step-less signal sorts before a step-attributed one)
 *   2. evidence event index
 *   3. rule priority - a stable table, not the order rules happened to run in
 *   4. rule id, alphabetically
 *   5. a normalized event key, as a final tiebreak
 *
 * Dedup policy: **one signal per distinct (rule, step, event, key)**, with an
 * occurrence count. The same event appearing twice yields one signal reading
 * "observed 2 times", not two identical rows. That keeps a noisy page from
 * filling the report with indistinguishable lines.
 */

import type { Anomaly, RuleId } from './types.js';
import type { RawSignal, RuleContext } from './rules.js';
import { collectSignals } from './rules.js';
import { sanitizeUrl } from './redaction.js';

/**
 * Stable rule priority.
 *
 * Explicit rather than derived from array order, so adding a rule cannot
 * silently reshuffle the output of an existing one.
 */
const RULE_PRIORITY: Record<RuleId, number> = {
  PAGE_ERROR: 10,
  HTTP_5XX: 20,
  NETWORK_REQUEST_FAILED: 25,
  STEP_TIMEOUT: 30,
  EXECUTION_ACTION_FAILED: 40,
  TARGET_MISSING_AFTER_ACTION: 45,
  TARGET_DISABLED_AFTER_ACTION: 46,
  UNEXPECTED_ORIGIN: 50,
  UNEXPECTED_REDIRECT: 51,
  HTTP_4XX: 60,
  CONSOLE_ERROR: 70,
  DUPLICATE_REQUEST: 80,
  CONSOLE_WARNING: 90,
};

/** A stable string form of a signal's identifying facts, for dedup and ordering. */
function normalizedKey(signal: RawSignal): string {
  return [
    signal.ruleId,
    signal.stepId ?? '',
    signal.eventIndex === null ? '' : String(signal.eventIndex),
    JSON.stringify(signal.details),
  ].join('|');
}

/** Compare two signals by the documented ordering. */
function compareSignals(a: RawSignal, b: RawSignal): number {
  const orderA = a.stepOrder === null ? -1 : a.stepOrder;
  const orderB = b.stepOrder === null ? -1 : b.stepOrder;
  if (orderA !== orderB) return orderA - orderB;

  const eventA = a.eventIndex === null ? -1 : a.eventIndex;
  const eventB = b.eventIndex === null ? -1 : b.eventIndex;
  if (eventA !== eventB) return eventA - eventB;

  const priorityA = RULE_PRIORITY[a.ruleId] ?? 999;
  const priorityB = RULE_PRIORITY[b.ruleId] ?? 999;
  if (priorityA !== priorityB) return priorityA - priorityB;

  if (a.ruleId !== b.ruleId) return a.ruleId.localeCompare(b.ruleId);

  return normalizedKey(a).localeCompare(normalizedKey(b));
}

/** Classify, deduplicate and order the signals from every rule. */
export function classifySignals(context: RuleContext): Anomaly[] {
  const collected = collectSignals(context);

  // Sort first, so the occurrence count of a repeated signal is attached in a
  // deterministic order and the representative event is always the earliest.
  const sorted = [...collected].sort(compareSignals);

  const merged = new Map<string, { signal: RawSignal; occurrences: number }>();
  for (const signal of sorted) {
    const key = normalizedKey(signal);
    const existing = merged.get(key);
    if (existing) {
      existing.occurrences += 1;
      continue;
    }
    merged.set(key, { signal, occurrences: 1 });
  }

  return [...merged.values()].map((entry, index) => {
    const { signal, occurrences } = entry;
    return {
      id: `anomaly-${String(index + 1).padStart(3, '0')}`,
      ruleId: signal.ruleId,
      kind: signal.kind,
      signalLevel: signal.signalLevel,
      status: 'observed' as const,
      message: signal.message,
      stepId: signal.stepId,
      stepOrder: signal.stepOrder,
      source: {
        executionReport: context.executionPath,
        evidenceType: signal.evidenceType,
        eventIndex: signal.eventIndex,
      },
      details: signal.details,
      possiblyExpected: signal.possiblyExpected,
      // Build 4 never confirms. Reproduction and confirmation are Build 5.
      confirmed: false as const,
      occurrences,
    };
  });
}

/** Re-exported for tests that need to reason about a URL safely. */
export { sanitizeUrl };
