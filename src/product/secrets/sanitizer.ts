/**
 * Secret Sanitizer & Boundary Verification — Build 11: Hosted MVP Foundation.
 *
 * Verifies that product entities and audit events contain safe metadata only,
 * rejecting raw secrets, tokens, cookies, or password fields.
 */

const FORBIDDEN_SECRET_KEYS = [
  'password',
  'passwd',
  'secret',
  'token',
  'bearer',
  'apikey',
  'api_key',
  'cookie',
  'private_key',
  'privatekey',
  'access_token',
  'refreshtoken',
] as const;

export interface SecretScanResult {
  readonly containsSecrets: boolean;
  readonly violatingKeys: readonly string[];
}

/**
 * Recursively scans an object for forbidden secret key names.
 */
export function scanForSecrets(obj: unknown, path = ''): SecretScanResult {
  const violatingKeys: string[] = [];

  if (obj === null || typeof obj !== 'object') {
    return { containsSecrets: false, violatingKeys };
  }

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const child = scanForSecrets(obj[i], `${path}[${i}]`);
      if (child.containsSecrets) {
        violatingKeys.push(...child.violatingKeys);
      }
    }
    return {
      containsSecrets: violatingKeys.length > 0,
      violatingKeys,
    };
  }

  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const currentPath = path ? `${path}.${key}` : key;
    const lowerKey = key.toLowerCase().replace(/[-_]/g, '');

    for (const forbidden of FORBIDDEN_SECRET_KEYS) {
      if (lowerKey.includes(forbidden.replace(/[-_]/g, ''))) {
        violatingKeys.push(currentPath);
        break;
      }
    }

    if (value && typeof value === 'object') {
      const child = scanForSecrets(value, currentPath);
      if (child.containsSecrets) {
        violatingKeys.push(...child.violatingKeys);
      }
    }
  }

  return {
    containsSecrets: violatingKeys.length > 0,
    violatingKeys,
  };
}

/** Asserts that an entity or payload contains zero secrets. */
export function assertNoSecrets(obj: unknown, entityLabel = 'Entity'): void {
  const scan = scanForSecrets(obj);
  if (scan.containsSecrets) {
    throw new Error(
      `${entityLabel} violates secret boundary! Found prohibited secret keys: ${scan.violatingKeys.join(', ')}.`,
    );
  }
}
