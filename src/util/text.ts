/**
 * Pure text helpers shared by the mapper and the report builders.
 */

/** Collapse whitespace and trim, returning `null` for empty results. */
export function cleanText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).replace(/\s+/g, ' ').trim();
  return cleaned.length > 0 ? cleaned : null;
}

/** `cleanText` plus a hard length cap. */
export function cleanTextCapped(value: string | null | undefined, max: number): string | null {
  const cleaned = cleanText(value);
  if (cleaned === null) return null;
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}
