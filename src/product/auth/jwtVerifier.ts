/**
 * Production JWT / OIDC Verification Boundary — Build 12D.1: Production Authentication.
 *
 * Implements a provider-neutral, Supabase-compatible JWT verifier using:
 * - Public-key JWKS endpoint verification (RS256, ES256)
 * - Safe bounded in-memory JWKS caching with TTL
 * - Automatic key rotation handling (refreshes on unknown key ID)
 * - Strict claims validation (signature, issuer, audience, exp, nbf, sub)
 * - Zero third-party dependencies (Node.js standard built-in `node:crypto`)
 * - Secret confidentiality: tokens, keys, and signatures are never logged or leaked in errors.
 */

import {
  createPublicKey,
  verify as cryptoVerify,
  type KeyObject,
  type JsonWebKey,
} from 'node:crypto';

export interface JwkKey {
  readonly kty: string;
  readonly kid?: string;
  readonly use?: string;
  readonly alg?: string;
  readonly n?: string;
  readonly e?: string;
  readonly crv?: string;
  readonly x?: string;
  readonly y?: string;
  readonly [key: string]: unknown;
}

export interface JwksResponse {
  readonly keys: readonly JwkKey[];
}

export type JwksFetchFunction = (url: string) => Promise<JwksResponse>;

export interface JwksClientOptions {
  readonly jwksUrl: string;
  readonly cacheTtlMs?: number; // Defaults to 10 minutes (600,000ms)
  readonly refreshCooldownMs?: number; // Minimum interval between network refreshes (default 1,000ms)
  readonly fetchFn?: JwksFetchFunction;
  readonly nowMs?: () => number;
}

interface CachedKey {
  readonly key: KeyObject;
  readonly jwk: JwkKey;
  readonly expiresAt: number;
}

export class JwksClient {
  private readonly jwksUrl: string;
  private readonly cacheTtlMs: number;
  private readonly refreshCooldownMs: number;
  private readonly fetchFn: JwksFetchFunction;
  private readonly now: () => number;
  private readonly cache = new Map<string, CachedKey>();
  private lastFetchTime = 0;
  private fetchPromise: Promise<void> | null = null;

  constructor(options: JwksClientOptions) {
    if (!options.jwksUrl || typeof options.jwksUrl !== 'string') {
      throw new Error('JWKS URL must be a non-empty string.');
    }
    this.jwksUrl = options.jwksUrl;
    this.cacheTtlMs = Math.max(1000, options.cacheTtlMs ?? 600_000);
    this.refreshCooldownMs = Math.max(0, options.refreshCooldownMs ?? 1000);
    this.now = options.nowMs ?? (() => Date.now());

    this.fetchFn =
      options.fetchFn ??
      (async (url: string): Promise<JwksResponse> => {
        const response = await fetch(url, {
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) {
          throw new Error(`Failed to fetch JWKS from ${url}: HTTP ${response.status}`);
        }
        return (await response.json()) as JwksResponse;
      });
  }

  get url(): string {
    return this.jwksUrl;
  }

  getCacheSize(): number {
    return this.cache.size;
  }

  isCached(kid: string): boolean {
    const entry = this.cache.get(kid);
    if (!entry) return false;
    return entry.expiresAt > this.now();
  }

  clearCache(): void {
    this.cache.clear();
    this.lastFetchTime = 0;
  }

  private async refreshKeys(): Promise<void> {
    const currentTime = this.now();
    if (currentTime - this.lastFetchTime < this.refreshCooldownMs && this.cache.size > 0) {
      // Respect refresh cooldown to avoid endpoint flooding
      return;
    }

    if (this.fetchPromise) {
      return this.fetchPromise;
    }

    this.fetchPromise = (async () => {
      try {
        const data = await this.fetchFn(this.jwksUrl);
        if (!data || !Array.isArray(data.keys)) {
          throw new Error('Invalid JWKS response format: missing "keys" array.');
        }

        const expiresAt = this.now() + this.cacheTtlMs;
        for (const jwk of data.keys) {
          if (!jwk || typeof jwk !== 'object' || !jwk.kty) {
            continue;
          }
          const kid = jwk.kid ?? 'default';
          try {
            const keyObject = createPublicKey({
              key: jwk as JsonWebKey,
              format: 'jwk',
            });
            this.cache.set(kid, {
              key: keyObject,
              jwk,
              expiresAt,
            });
          } catch {
            // Skip unparseable JWK without breaking others
          }
        }
        this.lastFetchTime = this.now();
      } finally {
        this.fetchPromise = null;
      }
    })();

    return this.fetchPromise;
  }

  async getKey(kid?: string): Promise<{ key: KeyObject; jwk: JwkKey }> {
    const targetKid = kid ?? 'default';
    const cached = this.cache.get(targetKid);
    const currentTime = this.now();

    if (cached && cached.expiresAt > currentTime) {
      return { key: cached.key, jwk: cached.jwk };
    }

    // Refresh keys from JWKS endpoint (cache miss or expired)
    await this.refreshKeys();

    const refreshed = this.cache.get(targetKid);
    if (refreshed && refreshed.expiresAt > this.now()) {
      return { key: refreshed.key, jwk: refreshed.jwk };
    }

    // If no kid was requested and exactly one key exists, use it
    if (!kid && this.cache.size === 1) {
      const firstEntry = this.cache.values().next().value;
      if (firstEntry && firstEntry.expiresAt > this.now()) {
        return { key: firstEntry.key, jwk: firstEntry.jwk };
      }
    }

    throw new Error(`Public key with kid "${targetKid}" not found in JWKS.`);
  }
}

export interface JwtHeader {
  readonly alg: string;
  readonly typ?: string;
  readonly kid?: string;
}

export interface JwtClaims {
  readonly sub: string;
  readonly iss: string;
  readonly aud: string | readonly string[];
  readonly exp: number;
  readonly nbf?: number;
  readonly iat?: number;
  readonly email?: string;
  readonly role?: string;
  readonly [key: string]: unknown;
}

export type JwtErrorCode =
  | 'MALFORMED_TOKEN'
  | 'UNSUPPORTED_ALGORITHM'
  | 'UNKNOWN_KEY'
  | 'INVALID_SIGNATURE'
  | 'INVALID_ISSUER'
  | 'INVALID_AUDIENCE'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_NOT_YET_VALID'
  | 'MISSING_SUBJECT';

export interface VerifyJwtResult {
  readonly valid: boolean;
  readonly claims?: JwtClaims;
  readonly header?: JwtHeader;
  readonly error?: string;
  readonly errorCode?: JwtErrorCode;
}

export interface JwtVerifierOptions {
  readonly jwksClient: JwksClient;
  readonly expectedIssuer: string;
  readonly expectedAudience: string;
  readonly clockToleranceSeconds?: number; // Defaults to 0
  readonly nowMs?: () => number;
}

function base64UrlDecode(str: string): string | null {
  try {
    let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4 !== 0) {
      base64 += '=';
    }
    return Buffer.from(base64, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

export class JwtVerifier {
  private readonly jwksClient: JwksClient;
  private readonly expectedIssuer: string;
  private readonly expectedAudience: string;
  private readonly clockToleranceSeconds: number;
  private readonly now: () => number;

  constructor(options: JwtVerifierOptions) {
    if (!options.expectedIssuer || typeof options.expectedIssuer !== 'string') {
      throw new Error('Expected issuer must be a non-empty string.');
    }
    if (!options.expectedAudience || typeof options.expectedAudience !== 'string') {
      throw new Error('Expected audience must be a non-empty string.');
    }
    this.jwksClient = options.jwksClient;
    this.expectedIssuer = options.expectedIssuer.replace(/\/+$/, '');
    this.expectedAudience = options.expectedAudience;
    this.clockToleranceSeconds = options.clockToleranceSeconds ?? 0;
    this.now = options.nowMs ?? (() => Date.now());
  }

  get issuer(): string {
    return this.expectedIssuer;
  }

  get audience(): string {
    return this.expectedAudience;
  }

  get client(): JwksClient {
    return this.jwksClient;
  }

  decodeUnverified(token: string): { header: JwtHeader; payload: JwtClaims } | null {
    if (typeof token !== 'string') return null;
    const parts = token.trim().split('.');
    if (parts.length !== 3) return null;

    const [headerB64, payloadB64] = parts;
    if (!headerB64 || !payloadB64) return null;

    const headerJson = base64UrlDecode(headerB64);
    const payloadJson = base64UrlDecode(payloadB64);
    if (!headerJson || !payloadJson) return null;

    try {
      const header = JSON.parse(headerJson) as JwtHeader;
      const payload = JSON.parse(payloadJson) as JwtClaims;
      return { header, payload };
    } catch {
      return null;
    }
  }

  async verify(token: unknown): Promise<VerifyJwtResult> {
    if (typeof token !== 'string' || token.trim() === '') {
      return {
        valid: false,
        error: 'Token is missing or empty.',
        errorCode: 'MALFORMED_TOKEN',
      };
    }

    const trimmed = token.trim();
    const parts = trimmed.split('.');
    if (parts.length !== 3) {
      return {
        valid: false,
        error: 'Malformed token structure: expected exactly 3 segments.',
        errorCode: 'MALFORMED_TOKEN',
      };
    }

    const [headerB64, payloadB64, signatureB64] = parts;
    if (!headerB64 || !payloadB64 || !signatureB64) {
      return {
        valid: false,
        error: 'Malformed token: contains empty segment.',
        errorCode: 'MALFORMED_TOKEN',
      };
    }

    // 1. Decode header
    const headerStr = base64UrlDecode(headerB64);
    if (!headerStr) {
      return {
        valid: false,
        error: 'Malformed token header: invalid base64url encoding.',
        errorCode: 'MALFORMED_TOKEN',
      };
    }

    let header: JwtHeader;
    try {
      header = JSON.parse(headerStr);
    } catch {
      return {
        valid: false,
        error: 'Malformed token header: invalid JSON.',
        errorCode: 'MALFORMED_TOKEN',
      };
    }

    if (header.typ && header.typ.toUpperCase() !== 'JWT') {
      return {
        valid: false,
        error: `Unsupported token type "${header.typ}": expected "JWT".`,
        errorCode: 'MALFORMED_TOKEN',
      };
    }

    const alg = header.alg;
    if (alg !== 'RS256' && alg !== 'ES256') {
      return {
        valid: false,
        error: `Unsupported signing algorithm "${alg}": only RS256 and ES256 are permitted for production tokens.`,
        errorCode: 'UNSUPPORTED_ALGORITHM',
      };
    }

    // 2. Fetch public key from JWKS
    let keyObject: KeyObject;
    try {
      const result = await this.jwksClient.getKey(header.kid);
      keyObject = result.key;
    } catch (err) {
      return {
        valid: false,
        error: `Key lookup failed: ${(err as Error).message}`,
        errorCode: 'UNKNOWN_KEY',
      };
    }

    // 3. Cryptographically verify signature
    const signedData = Buffer.from(`${headerB64}.${payloadB64}`, 'utf8');
    const signature = Buffer.from(signatureB64, 'base64url');

    let signatureValid = false;
    try {
      if (alg === 'RS256') {
        signatureValid = cryptoVerify('RSA-SHA256', signedData, keyObject, signature);
      } else if (alg === 'ES256') {
        signatureValid = cryptoVerify(
          'SHA256',
          signedData,
          { key: keyObject, dsaEncoding: 'ieee-p1363' },
          signature,
        );
      }
    } catch {
      signatureValid = false;
    }

    if (!signatureValid) {
      return {
        valid: false,
        error: 'Invalid token signature.',
        errorCode: 'INVALID_SIGNATURE',
      };
    }

    // 4. Decode payload
    const payloadStr = base64UrlDecode(payloadB64);
    if (!payloadStr) {
      return {
        valid: false,
        error: 'Malformed token payload: invalid base64url encoding.',
        errorCode: 'MALFORMED_TOKEN',
      };
    }

    let payload: JwtClaims;
    try {
      payload = JSON.parse(payloadStr);
    } catch {
      return {
        valid: false,
        error: 'Malformed token payload: invalid JSON.',
        errorCode: 'MALFORMED_TOKEN',
      };
    }

    // 5. Validate subject
    if (typeof payload.sub !== 'string' || payload.sub.trim() === '') {
      return {
        valid: false,
        error: 'Token missing required "sub" (subject) claim.',
        errorCode: 'MISSING_SUBJECT',
      };
    }

    // 6. Validate issuer
    const tokenIssuer = typeof payload.iss === 'string' ? payload.iss.replace(/\/+$/, '') : '';
    if (tokenIssuer !== this.expectedIssuer) {
      return {
        valid: false,
        error: 'Token issuer does not match configured issuer.',
        errorCode: 'INVALID_ISSUER',
      };
    }

    // 7. Validate audience
    let audienceMatched = false;
    if (typeof payload.aud === 'string') {
      audienceMatched = payload.aud === this.expectedAudience;
    } else if (Array.isArray(payload.aud)) {
      audienceMatched = payload.aud.includes(this.expectedAudience);
    }

    if (!audienceMatched) {
      return {
        valid: false,
        error: 'Token audience does not match configured audience.',
        errorCode: 'INVALID_AUDIENCE',
      };
    }

    // 8. Validate expiration
    const nowSec = Math.floor(this.now() / 1000);
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
      return {
        valid: false,
        error: 'Token missing valid "exp" timestamp.',
        errorCode: 'MALFORMED_TOKEN',
      };
    }

    if (payload.exp + this.clockToleranceSeconds <= nowSec) {
      return {
        valid: false,
        error: 'Token has expired.',
        errorCode: 'TOKEN_EXPIRED',
      };
    }

    // 9. Validate not-before (nbf)
    if (payload.nbf !== undefined) {
      if (typeof payload.nbf !== 'number' || !Number.isFinite(payload.nbf)) {
        return {
          valid: false,
          error: 'Token contains invalid "nbf" timestamp.',
          errorCode: 'MALFORMED_TOKEN',
        };
      }
      if (payload.nbf - this.clockToleranceSeconds > nowSec) {
        return {
          valid: false,
          error: 'Token is not yet valid (nbf violation).',
          errorCode: 'TOKEN_NOT_YET_VALID',
        };
      }
    }

    return {
      valid: true,
      claims: Object.freeze(payload),
      header: Object.freeze(header),
    };
  }
}
