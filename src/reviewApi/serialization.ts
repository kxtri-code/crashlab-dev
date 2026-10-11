/**
 * Deterministic JSON serialization (Build 9.1).
 *
 * Guarantees byte-identical JSON outputs by recursively sorting object keys
 * and using consistent 2-space indentation.
 */

function sortKeysDeep(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }

  const obj = value as Record<string, unknown>;
  const sortedObj: Record<string, unknown> = {};
  const keys = Object.keys(obj).sort();

  for (const key of keys) {
    sortedObj[key] = sortKeysDeep(obj[key]);
  }

  return sortedObj;
}

/**
 * Deterministically serialize any object to a formatted JSON string.
 * All dictionary keys are sorted lexicographically at every level.
 */
export function canonicalJsonStringify(data: unknown): string {
  const sorted = sortKeysDeep(data);
  return JSON.stringify(sorted, null, 2);
}
