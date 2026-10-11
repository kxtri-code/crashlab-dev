/**
 * HTML Escaping and Sanitization Helpers (Build 9.2).
 *
 * Ensures all data rendered into the browser interface is rigorously sanitized
 * against XSS injection, even if candidate messages, URLs, or notes contain
 * malicious payloads.
 */

/**
 * Escapes characters for safe inclusion in HTML body text.
 */
export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  const str = String(value);
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Escapes characters for safe inclusion inside HTML attribute values.
 */
export function escapeAttr(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  const str = String(value);
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\r/g, '&#13;')
    .replace(/\n/g, '&#10;');
}

/**
 * Sanitizes URLs to prevent javascript:, data:, or other dangerous schemes.
 * Allows safe protocols: http:, https:, mailto:, and relative/hash links.
 */
export function sanitizeUiUrl(value: unknown): string {
  if (!value || typeof value !== 'string') {
    return '#';
  }
  const trimmed = value.trim();
  // Safe relative paths or hashes
  if (
    trimmed.startsWith('#') ||
    trimmed.startsWith('/') ||
    trimmed.startsWith('./') ||
    trimmed.startsWith('?#/page')
  ) {
    return escapeAttr(trimmed);
  }

  try {
    const parsed = new URL(trimmed, 'http://127.0.0.1');
    const protocol = parsed.protocol.toLowerCase();
    if (protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:') {
      return escapeAttr(trimmed);
    }
    return '#unsafe-url';
  } catch {
    return '#unsafe-url';
  }
}

/**
 * Converts arbitrary text into a safe HTML element ID / CSS class token.
 */
export function safeId(value: unknown): string {
  if (!value) return 'id-none';
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Formats timestamps into a clean, human-readable ISO string.
 */
export function formatTimestamp(isoString: string | null | undefined): string {
  if (!isoString) return 'Never / Not recorded';
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return escapeHtml(isoString);
    return d.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
  } catch {
    return escapeHtml(isoString);
  }
}
