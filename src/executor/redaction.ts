/**
 * Redaction.
 *
 * The executor handles real test data - passwords, tokens, payment details -
 * and must keep it out of every artifact it writes. Two mechanisms work
 * together:
 *
 *  1. **Never record the value.** A step records only that a value was supplied
 *     and that it was redacted. This is the primary guarantee: there is nothing
 *     to leak because the value is never copied into the report.
 *  2. **Scrub any page-derived text.** Console messages, page errors and error
 *     strings come from the target and can echo a value the executor just
 *     typed. Those are scrubbed against the known secrets before storage.
 *
 * Pure and Playwright-free, so it is unit-testable in isolation.
 */

/** Placeholder written wherever a value would otherwise appear. */
export const REDACTED = 'REDACTED';

/** Query keys already handled by Build 1's URL redaction. */
const SENSITIVE_QUERY_KEY =
  /(?:password|passwd|token|secret|api[_-]?key|apikey|auth|session|signature|credential|otp|cvv|cvc)/i;

/**
 * Keys treated as sensitive in test data, for reporting and scrubbing.
 *
 * Covers both `api_key` and camelCase `apiKey` spellings, since a caller
 * writing test data will not reliably pick one.
 */
const SENSITIVE_TEST_DATA_KEY =
  /(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|auth|credential|otp|pin|cvv|cvc|card|ssn|security)/i;

/** How many characters of context to keep around a scrubbed region. */
const SCRUB_CONTEXT = 24;

/** Build a scrubber for a known set of secret strings. */
export interface Scrubber {
  /** Remove every occurrence of a known secret from a string. */
  scrub: (input: string) => string;
  /** How many distinct secrets the scrubber knows about. */
  readonly secretCount: number;
}

/**
 * Create a scrubber that replaces known secrets in free text.
 *
 * Secrets shorter than 4 characters are ignored: replacing a 1-2 character
 * string would corrupt unrelated text without protecting anything meaningful.
 */
export function createScrubber(secrets: readonly string[]): Scrubber {
  const known = [...new Set(secrets.filter((secret) => secret.length >= 4))].sort(
    (a, b) => b.length - a.length,
  );

  return {
    secretCount: known.length,
    scrub(input: string): string {
      if (known.length === 0) return input;
      let output = input;
      for (const secret of known) {
        // Case-insensitive, and tolerant of the quoting/escaping a page script
        // might apply around an interpolated value.
        const pattern = new RegExp(
          `${escapeRegExp(secret)}|${escapeRegExp(encodeURIComponent(secret))}`,
          'gi',
        );
        output = output.replace(pattern, REDACTED);
      }
      return output;
    },
  };
}

/** A scrubber that changes nothing, for runs with no test data. */
export const NO_SECRETS: Scrubber = { secretCount: 0, scrub: (input: string) => input };

/** Escape a string for literal use inside a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Redact a URL for the execution report.
 *
 * Build 1's `redactUrl` already handles embedded credentials and sensitive
 * query values. This adds a defensive redaction pass for a key pattern the
 * executor treats as sensitive, so a URL echoed by a page cannot carry a
 * payment or session secret.
 */
export function redactExecutionUrl(url: string | null | undefined, scrub: Scrubber = NO_SECRETS): string | null {
  if (url === null || url === undefined) return null;
  const scrubbed = scrub.scrub(url);

  const queryIndex = scrubbed.indexOf('?');
  if (queryIndex < 0) return scrubbed;

  const base = scrubbed.slice(0, queryIndex);
  const rest = scrubbed.slice(queryIndex + 1);
  const fragmentIndex = rest.indexOf('#');
  const query = fragmentIndex >= 0 ? rest.slice(0, fragmentIndex) : rest;
  const fragment = fragmentIndex >= 0 ? rest.slice(fragmentIndex) : '';

  const redactedQuery = query
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq < 0) return pair;
      const key = pair.slice(0, eq);
      return SENSITIVE_QUERY_KEY.test(decodeURIComponent(key)) ? `${key}=${REDACTED}` : pair;
    })
    .join('&');

  return `${base}?${redactedQuery}${fragment}`;
}

/** True when a test-data key names something sensitive. */
export function isSensitiveTestDataKey(key: string): boolean {
  return SENSITIVE_TEST_DATA_KEY.test(key);
}

/**
 * Describe a value without revealing it.
 *
 * The report may state the value's length and shape, which is enough to
 * diagnose a wrong test-data entry without disclosing the secret itself.
 */
export interface ValueSummary {
  provided: boolean;
  valueRedacted: boolean;
  length: number | null;
}

/** Summarise a value for the report, never including the value. */
export function summarizeValue(value: string | undefined | null): ValueSummary {
  if (value === undefined || value === null) {
    return { provided: false, valueRedacted: true, length: null };
  }
  return { provided: true, valueRedacted: true, length: value.length };
}

/**
 * Truncate and scrub an error message before it is stored.
 *
 * Messages can embed anything, including a value the executor just typed into
 * a field the page then rejected.
 */
export function redactMessage(message: string, scrub: Scrubber = NO_SECRETS, maxLength = 400): string {
  const collapsed = message.replace(/\s+/g, ' ').trim();
  const scrubbed = scrub.scrub(collapsed);
  return scrubbed.length > maxLength ? `${scrubbed.slice(0, maxLength)}...` : scrubbed;
}

/**
 * Collect the secret values from a test-data object, for scrubbing.
 * Only values at sensitive keys are treated as secrets.
 */
export function collectSecrets(testData: Readonly<Record<string, string>> | undefined): string[] {
  if (!testData) return [];
  return Object.entries(testData)
    .filter(([key, value]) => isSensitiveTestDataKey(key) && typeof value === 'string')
    .map(([, value]) => value);
}

export { SCRUB_CONTEXT };
