/**
 * Unit Tests for Review UI Escaping and Sanitization (Build 9.2).
 */

import { describe, it, expect } from 'vitest';
import {
  escapeHtml,
  escapeAttr,
  sanitizeUiUrl,
  safeId,
  formatTimestamp,
} from '../../src/reviewUi/escape.js';

describe('Review UI: HTML Escaping and Sanitization', () => {
  it('escapeHtml escapes special HTML characters', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
    );
    expect(escapeHtml("Tom & 'Jerry'")).toBe('Tom &amp; &#39;Jerry&#39;');
    expect(escapeHtml('Hello World')).toBe('Hello World');
    expect(escapeHtml('')).toBe('');
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
    expect(escapeHtml(12345)).toBe('12345');
    expect(escapeHtml(false)).toBe('false');
  });

  it('escapeAttr escapes special characters and newlines for attributes', () => {
    expect(escapeAttr('hello "world" & <tag>')).toBe(
      'hello &quot;world&quot; &amp; &lt;tag&gt;',
    );
    expect(escapeAttr("line1\r\nline2 'single'")).toBe(
      'line1&#13;&#10;line2 &#39;single&#39;',
    );
    expect(escapeAttr(null)).toBe('');
    expect(escapeAttr(undefined)).toBe('');
  });

  it('sanitizeUiUrl allows safe URLs and hashes', () => {
    expect(sanitizeUiUrl('https://example.com/test')).toBe('https://example.com/test');
    expect(sanitizeUiUrl('http://127.0.0.1:3210/api')).toBe('http://127.0.0.1:3210/api');
    expect(sanitizeUiUrl('#/candidates/cand-123')).toBe('#/candidates/cand-123');
    expect(sanitizeUiUrl('/api/summary')).toBe('/api/summary');
    expect(sanitizeUiUrl('./styles.css')).toBe('./styles.css');
  });

  it('sanitizeUiUrl blocks dangerous protocols (javascript:, data:)', () => {
    expect(sanitizeUiUrl('javascript:alert(1)')).toBe('#unsafe-url');
    expect(sanitizeUiUrl('JAVASCRIPT:alert(document.cookie)')).toBe('#unsafe-url');
    expect(sanitizeUiUrl('data:text/html,<script>alert(1)</script>')).toBe('#unsafe-url');
    expect(sanitizeUiUrl('vbscript:msgbox("test")')).toBe('#unsafe-url');
    expect(sanitizeUiUrl(null)).toBe('#');
    expect(sanitizeUiUrl('')).toBe('#');
  });

  it('safeId converts strings into safe CSS / element ID tokens', () => {
    expect(safeId('cand-0001')).toBe('cand-0001');
    expect(safeId('Rule: HTTP 500 & Crash!')).toBe('rule--http-500---crash');
    expect(safeId(null)).toBe('id-none');
    expect(safeId('')).toBe('id-none');
  });

  it('formatTimestamp formats valid ISO dates and handles invalid inputs', () => {
    expect(formatTimestamp('2026-10-11T12:00:00.000Z')).toBe('2026-10-11 12:00:00 UTC');
    expect(formatTimestamp(null)).toBe('Never / Not recorded');
    expect(formatTimestamp(undefined)).toBe('Never / Not recorded');
    expect(formatTimestamp('not-a-date')).toBe('not-a-date');
  });
});
