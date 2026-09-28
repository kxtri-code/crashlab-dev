import { describe, expect, it } from 'vitest';
import {
  REDACTED,
  canonicalizeUrl,
  isThirdParty,
  normalizeInputUrl,
  parseBoolean,
  parseInteger,
  parseViewport,
  redactUrl,
  toOrigin,
  toPath,
  truncate,
} from '../../src/util/url.js';

describe('redactUrl', () => {
  it('removes embedded credentials', () => {
    expect(redactUrl('https://user:hunter2@example.com/a')).toBe(`https://${REDACTED}@example.com/a`);
  });

  it('redacts sensitive query values and leaves others intact', () => {
    expect(redactUrl('https://x.test/api?token=abc&page=2')).toBe(`https://x.test/api?token=${REDACTED}&page=2`);
    expect(redactUrl('https://x.test/api?api_key=abc&ok=1')).toBe(`https://x.test/api?api_key=${REDACTED}&ok=1`);
  });

  it('leaves an innocuous query untouched', () => {
    const url = 'https://x.test/search?q=shoes&sort=price';
    expect(redactUrl(url)).toBe(url);
  });

  it('bounds pathologically long URLs', () => {
    const long = `https://x.test/${'a'.repeat(5000)}`;
    const result = redactUrl(long);
    expect(result.length).toBeLessThan(2100);
    expect(result.endsWith('...')).toBe(true);
  });
});

describe('canonicalizeUrl', () => {
  it('resolves a relative href against the base', () => {
    expect(canonicalizeUrl('/about', 'https://x.test/checkout')).toBe('https://x.test/about');
  });

  it('resolves hash and javascript hrefs to null', () => {
    expect(canonicalizeUrl('#', 'https://x.test/')).toBeNull();
    expect(canonicalizeUrl('javascript:void(0)', 'https://x.test/')).toBeNull();
    expect(canonicalizeUrl('', 'https://x.test/')).toBeNull();
  });

  it('redacts sensitive values on resolved URLs', () => {
    expect(canonicalizeUrl('/reset?token=secret', 'https://x.test/')).toBe(`https://x.test/reset?token=${REDACTED}`);
  });
});

describe('toPath / toOrigin', () => {
  it('keeps the query in the path', () => {
    expect(toPath('https://x.test/a/b?c=1')).toBe('/a/b?c=1');
  });

  it('falls back gracefully for a non-absolute URL', () => {
    expect(toPath('/relative/path')).toBe('/relative/path');
  });

  it('returns null origin for an unparseable URL', () => {
    expect(toOrigin('not a url')).toBeNull();
  });
});

describe('isThirdParty', () => {
  it('detects a cross-origin request', () => {
    expect(isThirdParty('https://cdn.other.test/a.js', 'https://app.test/')).toBe(true);
  });

  it('treats the same origin as first party', () => {
    expect(isThirdParty('https://app.test/a.js', 'https://app.test/')).toBe(false);
  });

  it('is false when either side is unparseable', () => {
    expect(isThirdParty('https://cdn.test/a.js', null)).toBe(false);
  });
});

describe('normalizeInputUrl', () => {
  it('adds https for a bare host', () => {
    expect(normalizeInputUrl('example.com')).toBe('https://example.com');
  });

  it('uses http for localhost so the fixture server is reachable', () => {
    expect(normalizeInputUrl('localhost:8080/x')).toBe('http://localhost:8080/x');
    expect(normalizeInputUrl('127.0.0.1:3000')).toBe('http://127.0.0.1:3000');
  });

  it('leaves an explicit scheme alone', () => {
    expect(normalizeInputUrl('http://x.test/')).toBe('http://x.test/');
  });
});

describe('config parsers', () => {
  it('parses viewports and rejects nonsense', () => {
    expect(parseViewport('1440x900', { width: 1, height: 1 })).toEqual({ width: 1440, height: 900 });
    expect(parseViewport('nope', { width: 800, height: 600 })).toEqual({ width: 800, height: 600 });
    expect(parseViewport(undefined, { width: 800, height: 600 })).toEqual({ width: 800, height: 600 });
  });

  it('parses booleans with a fallback', () => {
    expect(parseBoolean('false', true)).toBe(false);
    expect(parseBoolean('0', true)).toBe(false);
    expect(parseBoolean('yes', false)).toBe(true);
    expect(parseBoolean('maybe', true)).toBe(true);
  });

  it('parses integers and honours bounds', () => {
    expect(parseInteger('5000', 1000)).toBe(5000);
    expect(parseInteger('abc', 1000)).toBe(1000);
    expect(parseInteger('0', 1000, 1)).toBe(1000);
  });
});

describe('truncate', () => {
  it('passes short strings through and caps long ones', () => {
    expect(truncate('short', 10)).toBe('short');
    expect(truncate('abcdefghijkl', 5)).toBe('abcde');
    expect(truncate(null, 5)).toBeNull();
  });
});
