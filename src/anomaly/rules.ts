/**
 * Deterministic anomaly rules.
 *
 * Each rule is a pure function of the validated execution report and journey
 * plan, returning zero or more signals. Rules never read files, never open a
 * browser, and never make a network call.
 *
 * Two principles shape everything here:
 *
 * 1. **A signal is not a verdict.** Every rule reports what was observed and
 *    why it may or may not be expected. None of them decides a bug exists.
 *
 * 2. **Absence of evidence is not evidence of absence.** A `skipped` step, a
 *    safety `blocked` step, and a missing observation all produce *no* signal.
 *    A tool that reported those as anomalies would drown a real one in noise,
 *    so the engine is deliberately silent about them.
 */

import type { ExecutionReport, StepExecutionResult } from '../executor/types.js';
import type { JourneyPlan } from '../journey/types.js';
import { RULE_IDS } from './types.js';
import type { Anomaly, AnomalyKind, AnomalySource, EvidenceType, RuleId, SignalLevel } from './types.js';
import {
  redactMessage,
  redactStack,
  sanitizeFailure,
  sanitizePath,
  sanitizeUrl,
} from './redaction.js';
import { toOrigin } from '../util/url.js';
import { orderedSteps } from './validator.js';

/** A signal before ids and ordering are assigned. */
export interface RawSignal {
  ruleId: RuleId;
  kind: AnomalyKind;
  signalLevel: SignalLevel;
  message: string;
  stepId: string | null;
  stepOrder: number | null;
  evidenceType: EvidenceType;
  eventIndex: number | null;
  details: Record<string, unknown>;
  possiblyExpected: boolean;
}

/** Everything the rules may read. */
export interface RuleContext {
  execution: ExecutionReport;
  journey: JourneyPlan;
  executionPath: string;
  /** Emit `CONSOLE_WARNING` signals. Off by default. */
  includeConsoleWarnings: boolean;
}

/**
 * Step failures that are a *refusal*, not an application problem.
 *
 * A step that CrashLab declined to act on - for safety, for missing data, or
 * because there was nothing to act on - says nothing about the application
 * under test. Treating these as anomalies is exactly the false positive this
 * engine must avoid.
 *
 * `element-hidden` and `element-disabled` are deliberately **absent**. They
 * also appear in a blocked step, but unlike the reasons above they can equally
 * arise on a `failed` step, where the application changed under an action
 * CrashLab had already committed to. That is a genuine application signal, so
 * the UI-state rules are allowed to see them and to decide.
 */
const REFUSAL_REASONS = new Set([
  'no-locator-provided',
  'missing-test-data',
  'payment-blocked',
  'unsupported-assertion',
  'locator-ambiguous',
  'locator-unsupported',
  'no-navigation-target',
  'unsafe-test-file',
  'external-origin-blocked',
]);

/** Statuses that mean the step never acted on the application. */
const INERT_STATUSES = new Set(['skipped']);

/** HTTP statuses that are frequently legitimate, depending on context. */
const COMMONLY_EXPECTED_STATUSES = new Set([400, 401, 402, 403, 404, 405, 409, 410, 422, 429]);

/** Resource types whose repetition is normal (analytics, polling, beacons). */
const REPEATABLE_RESOURCE_TYPES = new Set(['image', 'font', 'stylesheet', 'media', 'other', 'manifest']);

/** Error reasons that indicate a missing or unusable target after an attempt. */
const MISSING_TARGET_REASONS = new Set(['locator-not-found']);
const DISABLED_TARGET_REASONS = new Set(['element-disabled', 'element-hidden']);

// --- network rules --------------------------------------------------------

/**
 * HTTP 4xx and 5xx responses.
 *
 * 4xx is often legitimate (a 401 on a protected resource, a 404 for a probe),
 * so it is retained as a signal and marked possibly-expected. 5xx is a server
 * fault and is reported at error level, still without calling it a defect.
 */
function httpResponseRules(context: RuleContext): RawSignal[] {
  const events = context.execution.rawEvidence?.networkEvents ?? [];
  const signals: RawSignal[] = [];

  for (const [index, event] of events.entries()) {
    const status = typeof event.status === 'number' ? event.status : null;
    if (status === null) continue;

    if (status >= 400 && status <= 499) {
      signals.push({
        ruleId: RULE_IDS.http4xx,
        kind: 'http-error',
        signalLevel: 'warning',
        message: `HTTP ${status} response observed during execution.`,
        stepId: null,
        stepOrder: null,
        evidenceType: 'network',
        eventIndex: index,
        details: {
          method: event.method ?? null,
          statusCode: status,
          resourceType: event.resourceType ?? null,
          url: sanitizeUrl(event.url),
          path: sanitizePath(event.path),
          thirdParty: event.thirdParty === true,
        },
        possiblyExpected: COMMONLY_EXPECTED_STATUSES.has(status),
      });
      continue;
    }

    if (status >= 500 && status <= 599) {
      signals.push({
        ruleId: RULE_IDS.http5xx,
        kind: 'http-error',
        signalLevel: 'error',
        message: `HTTP ${status} response observed during execution.`,
        stepId: null,
        stepOrder: null,
        evidenceType: 'network',
        eventIndex: index,
        details: {
          method: event.method ?? null,
          statusCode: status,
          resourceType: event.resourceType ?? null,
          url: sanitizeUrl(event.url),
          path: sanitizePath(event.path),
          thirdParty: event.thirdParty === true,
        },
        possiblyExpected: false,
      });
    }
  }

  return signals;
}

/**
 * Requests that produced no response at all.
 *
 * Distinct from an HTTP error: there is no status to report, so the signal
 * carries the transport-level failure reason instead.
 */
function networkFailureRules(context: RuleContext): RawSignal[] {
  const events = context.execution.rawEvidence?.networkEvents ?? [];
  const signals: RawSignal[] = [];

  for (const [index, event] of events.entries()) {
    if (event.failure === null || event.failure === undefined) continue;
    if (typeof event.status === 'number') continue; // a response arrived; HTTP rules own it

    signals.push({
      ruleId: RULE_IDS.networkRequestFailed,
      kind: 'network-failure',
      signalLevel: 'error',
      message: 'Network request failed without a response during execution.',
      stepId: null,
      stepOrder: null,
      evidenceType: 'network',
      eventIndex: index,
      details: {
        method: event.method ?? null,
        url: sanitizeUrl(event.url),
        path: sanitizePath(event.path),
        resourceType: event.resourceType ?? null,
        failure: sanitizeFailure(event.failure),
      },
      possiblyExpected: false,
    });
  }

  return signals;
}

/**
 * Repeated identical requests.
 *
 * Deterministic by key: method + sanitized URL + resource type. Consoles,
 * analytics beacons and font loads repeat legitimately, so those are marked
 * possibly-expected rather than dropped - the engineer still gets to see them.
 */
function duplicateRequestRules(context: RuleContext): RawSignal[] {
  const events = context.execution.rawEvidence?.networkEvents ?? [];
  const groups = new Map<string, number[]>();

  for (const [index, event] of events.entries()) {
    const key = `${event.method ?? 'GET'}|${sanitizeUrl(event.url)}|${event.resourceType ?? 'unknown'}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(index);
    else groups.set(key, [index]);
  }

  const signals: RawSignal[] = [];
  for (const [key, rawIndexes] of groups) {
    if (rawIndexes.length < 2) continue;

    // Build 12G.2: Exclude only the known self-generated initial-load-plus-fallback-navigation pair.
    // If the group contains a harness-initial-load and a harness-fallback-navigation,
    // that specific pair was generated entirely by the test runner harness repeating the initial URL
    // via the fallback navigation step.
    const indexes: number[] = [...rawIndexes];
    const initialLoadIndex = indexes.find((i) => events[i]?.provenance === 'harness-initial-load');
    const fallbackNavIndex = indexes.find((i) => events[i]?.provenance === 'harness-fallback-navigation');

    if (initialLoadIndex !== undefined && fallbackNavIndex !== undefined) {
      // Exclude the known self-generated fallback navigation from duplicating the initial load
      const fallbackPos = indexes.indexOf(fallbackNavIndex);
      if (fallbackPos !== -1) {
        indexes.splice(fallbackPos, 1);
      }
    }

    if (indexes.length < 2) continue;

    const first = events[indexes[0]!];
    const resourceType = first?.resourceType ?? null;
    const [method = null, url = '', type = null] = key.split('|');

    signals.push({
      ruleId: RULE_IDS.duplicateRequest,
      kind: 'duplicate-request',
      signalLevel: 'info',
      message: `Repeated identical request observed ${indexes.length} times.`,
      stepId: null,
      stepOrder: null,
      evidenceType: 'network',
      eventIndex: indexes[0] ?? null,
      details: {
        duplicateKey: key,
        method,
        url,
        resourceType: type,
        count: indexes.length,
        eventIndexes: indexes,
        // A repeated asset or analytics load is normal; a repeated API call
        // deserves a look.
        possiblyExpectedByResourceType: resourceType !== null && REPEATABLE_RESOURCE_TYPES.has(resourceType),
      },
      possiblyExpected: resourceType !== null && REPEATABLE_RESOURCE_TYPES.has(resourceType),
    });
  }

  return signals;
}

// --- console and page error rules ----------------------------------------

/** Console errors, and optionally warnings. */
function consoleRules(context: RuleContext): RawSignal[] {
  const events = context.execution.rawEvidence?.consoleEvents ?? [];
  const signals: RawSignal[] = [];

  for (const [index, event] of events.entries()) {
    const type = typeof event.type === 'string' ? event.type.toLowerCase() : 'other';

    if (type === 'error') {
      signals.push({
        ruleId: RULE_IDS.consoleError,
        kind: 'console',
        signalLevel: 'warning',
        message: 'JavaScript console error observed during execution.',
        stepId: null,
        stepOrder: null,
        evidenceType: 'console',
        eventIndex: index,
        details: {
          consoleType: type,
          text: redactMessage(event.text),
          url: event.url ? sanitizeUrl(event.url) : null,
          line: typeof event.line === 'number' ? event.line : null,
        },
        // A page logging its own error is extremely common and not by itself a
        // defect, so this is retained for review rather than raised.
        possiblyExpected: true,
      });
      continue;
    }

    if (type === 'warning' && context.includeConsoleWarnings) {
      signals.push({
        ruleId: RULE_IDS.consoleWarning,
        kind: 'console',
        signalLevel: 'info',
        message: 'JavaScript console warning observed during execution.',
        stepId: null,
        stepOrder: null,
        evidenceType: 'console',
        eventIndex: index,
        details: {
          consoleType: type,
          text: redactMessage(event.text),
          url: event.url ? sanitizeUrl(event.url) : null,
          line: typeof event.line === 'number' ? event.line : null,
        },
        possiblyExpected: true,
      });
    }
  }

  return signals;
}

/** Uncaught page errors. */
function pageErrorRules(context: RuleContext): RawSignal[] {
  const events = context.execution.rawEvidence?.pageErrors ?? [];
  return events.map((error, index) => ({
    ruleId: RULE_IDS.pageError,
    kind: 'page-error' as const,
    signalLevel: 'error' as const,
    message: 'Uncaught page error observed during execution.',
    stepId: null,
    stepOrder: null,
    evidenceType: 'pageError' as const,
    eventIndex: index,
    details: {
      // A stack can carry a value the page echoed, so only the first line is
      // kept, and it is scrubbed.
      errorMessage: redactMessage(error.message),
      stackSummary: redactStack(error.stack),
    },
    possiblyExpected: false,
  }));
}

// --- step-based rules -----------------------------------------------------

/**
 * Timeouts.
 *
 * The execution report records a `StepError.reason` from a fixed vocabulary, so
 * a timeout is signalled by that reason. Prose is deliberately *not* scanned
 * for the word: a message that merely mentions a timeout is not evidence of
 * one, and matching it would let a step satisfy two rules at once.
 */
function timeoutRules(context: RuleContext): RawSignal[] {
  const signals: RawSignal[] = [];

  for (const step of orderedSteps(context.execution)) {
    if (step.error?.reason !== 'timed-out') continue;

    signals.push({
      ruleId: RULE_IDS.stepTimeout,
      kind: 'timeout',
      signalLevel: 'error',
      message: `Step ${step.id} reported a timeout condition.`,
      stepId: step.id,
      stepOrder: typeof step.order === 'number' ? step.order : null,
      evidenceType: 'step',
      eventIndex: null,
      details: {
        action: step.action ?? null,
        intent: step.intent ?? null,
        durationMs: typeof step.durationMs === 'number' ? step.durationMs : null,
        url: sanitizeUrl(step.urlAfter ?? step.urlBefore),
        reportedReason: 'timed-out',
      },
      possiblyExpected: false,
    });
  }

  return signals;
}

/**
 * Navigation that left the authorized origin.
 *
 * Only raised on a *step-attributed* origin change, and only when the change
 * is not explained by a step CrashLab itself refused. A login redirect to an
 * identity provider is normal, so a change that the executor already blocked
 * is not double-reported: that refusal is a policy outcome, not a finding.
 */
function originRules(context: RuleContext): RawSignal[] {
  const signals: RawSignal[] = [];
  const authorizedOrigin = toOrigin(context.execution.target?.url ?? context.journey.target?.url);
  if (authorizedOrigin === null) return signals;

  for (const step of orderedSteps(context.execution)) {
    // A step CrashLab refused produced no navigation, so there is nothing to
    // classify.
    if (INERT_STATUSES.has(step.status)) continue;
    if (step.error?.reason === 'external-origin-blocked') continue;

    const before = step.urlBefore;
    const after = step.urlAfter;
    if (typeof before !== 'string' || typeof after !== 'string') continue;
    if (before === after) continue;

    const beforeOrigin = toOrigin(before);
    const afterOrigin = toOrigin(after);
    if (beforeOrigin === null || afterOrigin === null) continue;
    if (afterOrigin === beforeOrigin) continue;

    const leftAuthorizedTarget = afterOrigin !== authorizedOrigin;
    if (!leftAuthorizedTarget) continue;

    signals.push({
      ruleId: RULE_IDS.unexpectedOrigin,
      kind: 'navigation',
      signalLevel: 'warning',
      message: `Step ${step.id} navigated to an origin different from the authorized target origin.`,
      stepId: step.id,
      stepOrder: typeof step.order === 'number' ? step.order : null,
      evidenceType: 'step',
      eventIndex: null,
      details: {
        authorizedOrigin,
        originBefore: beforeOrigin,
        originAfter: afterOrigin,
        urlBefore: sanitizeUrl(before),
        urlAfter: sanitizeUrl(after),
        // A redirect to a login or payment provider is a routine part of many
        // flows, so this is flagged for review rather than treated as an error.
        possiblyExpectedAsProviderRedirect: true,
      },
      possiblyExpected: true,
    });
  }

  return signals;
}

/**
 * UI state that was not usable when an action was attempted.
 *
 * Strictly limited to steps that actually acted. A `skipped` step never touched
 * the page, and a `blocked` step was refused before acting, so neither can say
 * anything about the application's UI.
 */
function uiStateRules(context: RuleContext): RawSignal[] {
  const signals: RawSignal[] = [];

  for (const step of orderedSteps(context.execution)) {
    if (INERT_STATUSES.has(step.status)) continue;
    if (step.status === 'passed') continue;
    // A blocked step is a refusal, whatever the reason. The application was
    // never acted on, so it cannot have produced a UI-state signal.
    if (step.status === 'blocked') continue;

    const reason = step.error?.reason;
    if (reason === undefined) continue;

    const isMissing = MISSING_TARGET_REASONS.has(reason);
    const isUnusable = DISABLED_TARGET_REASONS.has(reason);
    if (!isMissing && !isUnusable) continue;

    signals.push({
      ruleId: isMissing ? RULE_IDS.targetMissingAfterAction : RULE_IDS.targetDisabledAfterAction,
      kind: 'ui-state',
      signalLevel: 'error',
      message: isMissing
        ? 'Target was not available when the action was attempted.'
        : 'Target was present but not usable when the action was attempted.',
      stepId: step.id,
      stepOrder: typeof step.order === 'number' ? step.order : null,
      evidenceType: 'step',
      eventIndex: null,
      details: {
        action: step.action ?? null,
        intent: step.intent ?? null,
        selectedLocator: step.selectedLocator ?? null,
        targetElementIds: Array.isArray(step.targetElementIds) ? [...step.targetElementIds] : [],
        url: sanitizeUrl(step.urlBefore),
        reportedReason: sanitizeFailure(reason),
      },
      possiblyExpected: false,
    });
  }

  return signals;
}

/**
 * Actions that were attempted and did not complete.
 *
 * Excludes every refusal, missing data, and safely-stopped step. What remains
 * is a step where CrashLab acted and the application did not cooperate.
 */
function stepFailureRules(context: RuleContext): RawSignal[] {
  const signals: RawSignal[] = [];

  for (const step of orderedSteps(context.execution)) {
    if (step.status !== 'failed') continue;
    if (step.error === null) continue;

    const reason = step.error.reason;
    // A refused or uninstrumented failure is not an application signal.
    if (REFUSAL_REASONS.has(reason)) continue;
    // Each failure reason belongs to exactly one rule, so a step is never
    // counted twice. Timeouts and unusable targets are owned above.
    if (reason === 'timed-out') continue;
    if (MISSING_TARGET_REASONS.has(reason) || DISABLED_TARGET_REASONS.has(reason)) continue;
    signals.push({
      ruleId: RULE_IDS.executionActionFailed,
      kind: 'step-failure',
      signalLevel: 'error',
      message: `Step ${step.id} (${step.action}) did not complete successfully.`,
      stepId: step.id,
      stepOrder: typeof step.order === 'number' ? step.order : null,
      evidenceType: 'step',
      eventIndex: null,
      details: {
        action: step.action ?? null,
        intent: step.intent ?? null,
        selectedLocator: step.selectedLocator ?? null,
        durationMs: typeof step.durationMs === 'number' ? step.durationMs : null,
        url: sanitizeUrl(step.urlAfter ?? step.urlBefore),
        reportedReason: sanitizeFailure(reason),
        reportedMessage: redactMessage(step.error.message, 'no message recorded'),
      },
      possiblyExpected: false,
    });
  }

  return signals;
}

/** Every rule, in the order signals are collected. */
const ALL_RULES: readonly ((context: RuleContext) => RawSignal[])[] = [
  httpResponseRules,
  networkFailureRules,
  duplicateRequestRules,
  consoleRules,
  pageErrorRules,
  timeoutRules,
  originRules,
  uiStateRules,
  stepFailureRules,
];

/** Run every rule and return the raw signals. */
export function collectSignals(context: RuleContext): RawSignal[] {
  return ALL_RULES.flatMap((rule) => rule(context));
}

/** A step lookup, so a signal can be attributed when the evidence allows. */
export function stepIndexById(execution: ExecutionReport): Map<string, StepExecutionResult> {
  return new Map(orderedSteps(execution).map((step) => [step.id, step]));
}
