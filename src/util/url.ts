/**
 * Pure URL helpers. No browser APIs, no I/O - unit-testable in isolation.
 *
 * These exist so a scout report can never leak a credential: everything that
 * ends up in `url` fields is passed through `redactUrl` first.
 */

/** Query keys whose values are replaced with `REDACTED`. */
const SENSITIVE_QUERY_KEY_PATTERN =
  /^(?:.*(?:password|passwd|pwd|passphrase|secret|token|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|apikey|auth|authorization|session|sessionid|sid|jwt|signature|sig|credential|key|otp|code|pin|cvv|cvc|security[_-]?code|ssn|social[_-]?security).*)$/i;

export const REDACTED = 'REDACTED';

/** Longest URL we will store in a report. */
const MAX_URL_LENGTH = 2000;

/** Longest path we will store. */
const MAX_PATH_LENGTH = 500;

/** Truncate long free text (console messages, element labels) for report safety. */
export function truncate(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value);
  return s.length > max ? s.slice(0, max) : s;
}

/** Replace credentials and sensitive query values, then bound the length. */
export function redactUrl(input: string): string {
  let url = input.trim();
  if (!url) return url;

  // Strip embedded credentials: https://user:pass@host -> https://REDACTED@host
  url = url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, `$1${REDACTED}@`);

  // Redact sensitive query values without needing to parse the URL.
  const hashIndex = url.indexOf('#');
  const fragment = hashIndex >= 0 ? url.slice(hashIndex) : '';
  const withoutFragment = hashIndex >= 0 ? url.slice(0, hashIndex) : url;

  const queryIndex = withoutFragment.indexOf('?');
  if (queryIndex >= 0) {
    const base = withoutFragment.slice(0, queryIndex);
    const query = withoutFragment.slice(queryIndex + 1);
    const redacted = query
      .split('&')
      .map((pair) => {
        const eq = pair.indexOf('=');
        if (eq < 0) return pair;
        const key = pair.slice(0, eq);
        return SENSITIVE_QUERY_KEY_PATTERN.test(decodeURIComponent(key))
          ? `${key}=${REDACTED}`
          : pair;
      })
      .join('&');
    url = `${base}?${redacted}${fragment}`;
  } else {
    url = withoutFragment + fragment;
  }

  return url.length > MAX_URL_LENGTH ? `${url.slice(0, MAX_URL_LENGTH)}...` : url;
}

/**
 * Normalise a possibly-relative href to an absolute URL, redacted.
 * Returns `null` for empty values and `null` when the base cannot be resolved.
 */
export function canonicalizeUrl(href: string | null | undefined, baseUrl?: string | null): string | null {
  if (href === null || href === undefined) return null;
  const raw = href.trim();
  if (!raw || raw === '#' || raw.toLowerCase().startsWith('javascript:')) return null;

  if (baseUrl) {
    try {
      return redactUrl(new URL(raw, baseUrl).toString());
    } catch {
      return redactUrl(raw);
    }
  }
  return redactUrl(raw);
}

/** Path (plus query, minus origin) of a URL, for grouping in reports. */
export function toPath(url: string | null | undefined): string {
  if (!url) return '';
  const redacted = redactUrl(url);
  try {
    const parsed = new URL(redacted);
    const path = `${parsed.pathname}${parsed.search}`;
    return truncate(path, MAX_PATH_LENGTH) ?? path;
  } catch {
    // Not an absolute URL - keep the query-stripped-looking remainder.
    const noQuery = redacted.split('?')[0] ?? redacted;
    return truncate(noQuery, MAX_PATH_LENGTH) ?? noQuery;
  }
}

/** Origin of a URL, or `null` when it is unparseable. */
export function toOrigin(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** True when `url` sits on a different origin than `pageUrl`. */
export function isThirdParty(url: string | null | undefined, pageUrl: string | null | undefined): boolean {
  const target = toOrigin(url);
  const page = toOrigin(pageUrl);
  if (!target || !page) return false;
  return target !== page;
}

/** Convert a value to a `http`/`https` URL string, adding `https://` if needed. */
export function normalizeInputUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  if (/^localhost(:\d+)?(\/|$)/i.test(trimmed) || /^127\.0\.0\.1(:\d+)?(\/|$)/.test(trimmed)) {
    return `http://${trimmed}`;
  }
  return `https://${trimmed}`;
}

/** Parse `WIDTHxHEIGHT`, falling back to the default when malformed. */
export function parseViewport(
  value: string | undefined,
  fallback: { width: number; height: number },
): { width: number; height: number } {
  if (!value) return fallback;
  const match = /^\s*(\d{2,5})\s*[xX,]\s*(\d{2,5})\s*$/.exec(value);
  if (!match) return fallback;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 100 || height < 100) {
    return fallback;
  }
  return { width, height };
}

/** Interpret an env/flag value as a boolean. */
export function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

/** Parse a positive integer from an env/flag value, falling back when invalid. */
export function parseInteger(value: string | undefined, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined) return fallback;
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed)) return fallback;
  const truncated = Math.trunc(parsed);
  if (truncated < min || truncated > max) return fallback;
  return truncated;
}
