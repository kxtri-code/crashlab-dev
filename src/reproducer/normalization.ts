/**
 * Signal normalization for matching.
 *
 * Two runs of the same journey will not produce byte-identical evidence: ports
 * differ, ids differ, timestamps differ, and a page may echo a session value.
 * Matching therefore compares *normalized* keys, not raw text.
 *
 * The rule is to remove what varies between runs and keep what identifies the
 * signal. Removing too little produces false "not reproduced" results;
 * removing too much produces false "reproduced" ones, which is the more
 * damaging error because it manufactures a candidate defect out of two
 * unrelated events. So the normalization here is deliberately narrow.
 */

import type { Anomaly } from '../anomaly/types.js';
import { sanitizeUrl } from '../anomaly/redaction.js';

/**
 * Run-to-run noise patterns, stored as *sources* rather than live regexes.
 *
 * A module-level `/g` regex carries `lastIndex` between calls, so reusing one
 * across repeated `replace` calls silently skips matches. That is the same
 * defect found in the Build 4 redactor, and matching is the one place it would
 * do real damage: a signal that failed to normalize would be reported as
 * "not reproduced" purely because a regex cursor had drifted. Each use
 * compiles a fresh regex instead.
 */
const NOISE_SOURCES = {
  dynamicId: String.raw`\b(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|\b[0-9a-f]{8}-[0-9a-f]{4}\b)\b`,
  timestamp: String.raw`(?:\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?|\b1[0-9]{12}\b)`,
  sourcePosition: String.raw`(?::\d{2,}){1,2}\b`,
} as const;

/** Apply one noise pattern, compiling fresh so no cursor is ever carried. */
function strip(value: string, source: string, replacement: string): string {
  return value.replace(new RegExp(source, 'gi'), replacement);
}

/** Collapse whitespace and lowercase, the baseline for every key. */
function base(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Strip run-to-run noise from a URL, keeping the path and query shape. */
export function normalizeUrl(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') return '';
  let text = sanitizeUrl(value);
  // A port changes between runs on an ephemeral local server.
  text = text.replace(/:\d{2,5}(?=\/|$)/, ':<port>');
  text = strip(text, NOISE_SOURCES.dynamicId, '<id>');
  text = strip(text, NOISE_SOURCES.timestamp, '<time>');
  return text.trim();
}

/** Normalize a free-text message for comparison. */
export function normalizeMessage(value: unknown, maxLength = 120): string {
  if (typeof value !== 'string') return '';
  return strip(strip(strip(base(value), NOISE_SOURCES.dynamicId, '<id>'), NOISE_SOURCES.timestamp, '<time>'), NOISE_SOURCES.sourcePosition, '').slice(
    0,
    maxLength,
  );
}

/** Read a detail field from an anomaly, tolerating its loose type. */
function detail(anomaly: Anomaly, key: string): string {
  const value = anomaly.details?.[key];
  return value === null || value === undefined ? '' : String(value);
}

/**
 * Build the stable matching key for a signal.
 *
 * The key is rule-specific: an HTTP 500 must match an HTTP 500 on the same
 * method, URL and resource type, while a console error matches on its message.
 * A meaningful distinction - 404 versus 500, GET versus POST, console error
 * versus page error - is always preserved, because collapsing those would let
 * two unrelated events count as one reproduction.
 *
 * @returns the key, or `null` when the signal has no comparable evidence.
 */
export function matchingKeyFor(anomaly: Anomaly): string | null {
  const rule = anomaly.ruleId;
  const stepId = anomaly.stepId ?? '';

  switch (rule) {
    case 'HTTP_5XX':
    case 'HTTP_4XX': {
      const status = detail(anomaly, 'statusCode');
      if (!status) return null;
      return [rule, status, base(detail(anomaly, 'method')), normalizeUrl(detail(anomaly, 'url')), base(detail(anomaly, 'resourceType'))].join('|');
    }

    case 'NETWORK_REQUEST_FAILED': {
      const url = normalizeUrl(detail(anomaly, 'url'));
      if (!url) return null;
      return [rule, base(detail(anomaly, 'method')), url, base(detail(anomaly, 'resourceType'))].join('|');
    }

    case 'DUPLICATE_REQUEST': {
      const url = normalizeUrl(detail(anomaly, 'url'));
      if (!url) return null;
      return [rule, base(detail(anomaly, 'method')), url, base(detail(anomaly, 'resourceType'))].join('|');
    }

    case 'CONSOLE_ERROR':
    case 'CONSOLE_WARNING': {
      const text = normalizeMessage(detail(anomaly, 'text'));
      if (!text) return null;
      return [rule, text].join('|');
    }

    case 'PAGE_ERROR': {
      // Only the message, never the stack: a stack carries machine-specific
      // paths and may echo a value, and comparing it would both leak and miss.
      const message = normalizeMessage(detail(anomaly, 'errorMessage'));
      if (!message) return null;
      return [rule, message].join('|');
    }

    case 'STEP_TIMEOUT': {
      return [rule, stepId, base(detail(anomaly, 'action')), base(detail(anomaly, 'reportedReason'))].join('|');
    }

    case 'UNEXPECTED_ORIGIN':
    case 'UNEXPECTED_REDIRECT': {
      const after = normalizeUrl(detail(anomaly, 'urlAfter'));
      if (!after) return null;
      return [rule, stepId, after].join('|');
    }

    case 'TARGET_MISSING_AFTER_ACTION':
    case 'TARGET_DISABLED_AFTER_ACTION':
    case 'EXECUTION_ACTION_FAILED': {
      // Step-scoped, so a step id is required: without it these would match
      // against any failure anywhere in the run.
      if (!stepId) return null;
      return [rule, stepId, base(detail(anomaly, 'action')), base(detail(anomaly, 'reportedReason'))].join('|');
    }

    default:
      return null;
  }
}

/** Whether two signals refer to the same evidence. */
export function signalsMatch(original: Anomaly, candidate: Anomaly): boolean {
  if (original.ruleId !== candidate.ruleId) return false;
  const originalKey = matchingKeyFor(original);
  if (originalKey === null) return false;
  return originalKey === matchingKeyFor(candidate);
}
