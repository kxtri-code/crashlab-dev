/**
 * Unit Tests for Review UI CLI Options & Parsing (Build 9.2).
 */

import { describe, it, expect } from 'vitest';
import { parseReviewUiArgs } from '../../src/cli/reviewUiCommand.js';

describe('Review UI: CLI Argument Parsing', () => {
  it('parses defaults when no arguments supplied', () => {
    const res = parseReviewUiArgs([]);
    expect(res.valid).toBe(true);
    expect(res.error).toBeNull();
    expect(res.apiUrl).toBe('http://127.0.0.1:3210');
    expect(res.host).toBe('127.0.0.1');
    expect(res.port).toBe(3211);
    expect(res.noOpen).toBe(false);
  });

  it('parses custom flags correctly', () => {
    const res = parseReviewUiArgs([
      '--api-url',
      'http://127.0.0.1:8080',
      '--host',
      '127.0.0.1',
      '--port',
      '4000',
      '--no-open',
    ]);
    expect(res.valid).toBe(true);
    expect(res.apiUrl).toBe('http://127.0.0.1:8080');
    expect(res.host).toBe('127.0.0.1');
    expect(res.port).toBe(4000);
    expect(res.noOpen).toBe(true);
  });

  it('rejects unknown flags', () => {
    const res = parseReviewUiArgs(['--unrecognized', 'value']);
    expect(res.valid).toBe(false);
    expect(res.error).toContain('Unknown option');
  });

  it('rejects invalid or malformed api-url', () => {
    const res = parseReviewUiArgs(['--api-url', 'not-a-valid-url']);
    expect(res.valid).toBe(false);
    expect(res.error).toContain('--api-url must be a valid URL');
  });

  it('rejects empty api-url', () => {
    const res = parseReviewUiArgs(['--api-url', '']);
    expect(res.valid).toBe(false);
    expect(res.error).toContain('--api-url requires a non-empty URL string');
  });

  it('rejects non-integer port', () => {
    const res = parseReviewUiArgs(['--port', 'abc']);
    expect(res.valid).toBe(false);
    expect(res.error).toContain('--port must be an integer');
  });

  it('rejects out of range port', () => {
    const res = parseReviewUiArgs(['--port', '999999']);
    expect(res.valid).toBe(false);
  });
});
