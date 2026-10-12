/**
 * Deterministic Local Development Token Mechanism — Build 12B.1: Local Authentication.
 *
 * Implements HMAC-SHA256 signed bearer tokens for local development and integration tests.
 * Zero external dependencies — uses Node.js standard built-in `node:crypto`.
 *
 * Enforces:
 * - Deterministic, standard JWT-style three-part structure (header.payload.signature)
 * - Timing-safe HMAC signature verification
 * - Expiration timestamp verification
 * - Malformed token rejection
 * - Secret confidentiality (secrets and signatures are never logged or leaked in errors)
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface DevTokenPayload {
  readonly sub: string; // User ID
  readonly iat: number; // Issued-at timestamp (epoch seconds)
  readonly exp: number; // Expiration timestamp (epoch seconds)
  readonly iss: 'crashlab-local';
}

export interface CreateDevTokenOptions {
  readonly userId: string;
  readonly secret: string;
  readonly expiresInSeconds?: number; // Defaults to 3600 (1 hour)
  readonly nowMs?: number; // Epoch milliseconds for deterministic test generation
}

export interface VerifyDevTokenResult {
  readonly valid: boolean;
  readonly userId?: string;
  readonly exp?: number;
  readonly iat?: number;
  readonly error?: string;
}

function base64UrlEncode(str: string): string {
  return Buffer.from(str, 'utf8')
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
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

function computeHmacSignature(content: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(content, 'utf8')
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/**
 * Creates a signed development bearer token for testing and local API authorization.
 */
export function createDevToken(options: CreateDevTokenOptions): string {
  const userId = options.userId.trim();
  if (!userId) {
    throw new Error('User ID cannot be empty when creating a development token.');
  }
  const secret = options.secret;
  if (!secret) {
    throw new Error('Signing secret cannot be empty when creating a development token.');
  }

  const nowSec = Math.floor((options.nowMs ?? Date.now()) / 1000);
  const expiresIn = options.expiresInSeconds ?? 3600;
  const expSec = nowSec + expiresIn;

  const header = {
    alg: 'HS256',
    typ: 'JWT',
  };

  const payload: DevTokenPayload = {
    sub: userId,
    iat: nowSec,
    exp: expSec,
    iss: 'crashlab-local',
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signatureInput = `${encodedHeader}.${encodedPayload}`;
  const signature = computeHmacSignature(signatureInput, secret);

  return `${signatureInput}.${signature}`;
}

/**
 * Verifies and decodes a signed development bearer token.
 */
export function verifyDevToken(
  token: unknown,
  secret: string,
  nowMs = Date.now(),
): VerifyDevTokenResult {
  if (typeof token !== 'string' || token.trim() === '') {
    return { valid: false, error: 'Token is missing or empty.' };
  }

  const parts = token.trim().split('.');
  if (parts.length !== 3) {
    return { valid: false, error: 'Malformed token structure: expected 3 segments.' };
  }

  const [encodedHeader, encodedPayload, signature] = parts;
  if (!encodedHeader || !encodedPayload || !signature) {
    return { valid: false, error: 'Malformed token: contains empty segment.' };
  }

  // 1. Verify header
  const headerJson = base64UrlDecode(encodedHeader);
  if (!headerJson) {
    return { valid: false, error: 'Malformed token header: invalid base64url encoding.' };
  }
  try {
    const header = JSON.parse(headerJson);
    if (header.alg !== 'HS256') {
      return { valid: false, error: 'Unsupported token algorithm: expected HS256.' };
    }
  } catch {
    return { valid: false, error: 'Malformed token header: invalid JSON.' };
  }

  // 2. Verify signature using timingSafeEqual
  const signatureInput = `${encodedHeader}.${encodedPayload}`;
  const expectedSignature = computeHmacSignature(signatureInput, secret);

  const sigBuffer = Buffer.from(signature, 'utf8');
  const expectedBuffer = Buffer.from(expectedSignature, 'utf8');

  if (sigBuffer.length !== expectedBuffer.length || !timingSafeEqual(sigBuffer, expectedBuffer)) {
    return { valid: false, error: 'Invalid token signature.' };
  }

  // 3. Verify payload
  const payloadJson = base64UrlDecode(encodedPayload);
  if (!payloadJson) {
    return { valid: false, error: 'Malformed token payload: invalid base64url encoding.' };
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return { valid: false, error: 'Malformed token payload: invalid JSON.' };
  }

  if (typeof payload.sub !== 'string' || payload.sub.trim() === '') {
    return { valid: false, error: 'Token payload missing valid "sub" (user ID).' };
  }

  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
    return { valid: false, error: 'Token payload missing valid "exp" timestamp.' };
  }

  // 4. Verify expiration
  const currentSec = Math.floor(nowMs / 1000);
  if (payload.exp <= currentSec) {
    return { valid: false, error: 'Token has expired.' };
  }

  return {
    valid: true,
    userId: payload.sub.trim(),
    exp: payload.exp,
    iat: typeof payload.iat === 'number' ? payload.iat : currentSec,
  };
}
