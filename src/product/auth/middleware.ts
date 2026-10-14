/**
 * Product API Request Authentication Middleware — Build 12D.1: Production Authentication.
 *
 * Inspects incoming HTTP requests, enforces authentication boundaries,
 * and extracts validated IdentityContext.
 *
 * Rules:
 * - Production mode (PRODUCT_AUTH_MODE=production) strictly requires `Authorization: Bearer <token>`.
 * - Production mode strictly validates signed JWTs against JWKS public keys.
 * - Production mode NEVER accepts arbitrary `X-User-Id` headers.
 * - Production mode NEVER accepts development tokens (HMAC HS256 / iss: crashlab-local).
 * - Production mode fails closed when JWT / JWKS configuration is incomplete.
 * - Development mode (PRODUCT_AUTH_MODE=development) allows local test convenience via
 *   `createDevToken` Bearer tokens, or `X-User-Id` header fallback when no token is present.
 * - All responses carry a generated `requestId`.
 * - Tokens, headers, and secrets are never logged.
 */

import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { IdentityContext, AuthConfig } from './identity.js';
import { verifyDevToken } from './devToken.js';
import { JwtVerifier } from './jwtVerifier.js';
import type { IdGenerator } from '../util/id.js';

export interface AuthenticateRequestOptions {
  readonly authConfig: AuthConfig;
  readonly defaultUserId?: string; // Only respected in development mode
  readonly idGenerator?: IdGenerator;
  readonly nowMs?: () => number;
}

export interface AuthResult {
  readonly success: boolean;
  readonly requestId: string;
  readonly identity?: IdentityContext;
  readonly statusCode?: number;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
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

/**
 * Checks whether a token structure indicates a development token.
 * Dev tokens use HS256 algorithm and/or iss: 'crashlab-local'.
 */
function isDevelopmentToken(token: string): boolean {
  const parts = token.trim().split('.');
  if (parts.length !== 3) return false;
  const [headerB64, payloadB64] = parts;
  if (!headerB64 || !payloadB64) return false;

  const headerJson = base64UrlDecode(headerB64);
  const payloadJson = base64UrlDecode(payloadB64);
  if (!headerJson || !payloadJson) return false;

  try {
    const header = JSON.parse(headerJson);
    const payload = JSON.parse(payloadJson);
    return header.alg === 'HS256' || payload.iss === 'crashlab-local';
  } catch {
    return false;
  }
}

/**
 * Extracts and validates the identity context from an incoming HTTP request.
 * Returns AuthResult or Promise<AuthResult>.
 */
export async function authenticateRequest(
  req: IncomingMessage,
  options: AuthenticateRequestOptions,
): Promise<AuthResult> {
  const clientReqId = req.headers['x-request-id'];
  const requestId =
    typeof clientReqId === 'string' &&
    clientReqId.trim().length > 0 &&
    /^[a-zA-Z0-9_\-\.]+$/.test(clientReqId.trim())
      ? clientReqId.trim()
      : options.idGenerator?.generateId('req') ??
        `req_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

  const authHeader = req.headers['authorization'];
  const authMode = options.authConfig.authMode;

  // 1. Process explicit Authorization header if provided
  if (typeof authHeader === 'string' && authHeader.trim() !== '') {
    const trimmedHeader = authHeader.trim();
    if (!trimmedHeader.toLowerCase().startsWith('bearer ')) {
      return {
        success: false,
        requestId,
        statusCode: 401,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Unsupported authorization scheme. Use "Authorization: Bearer <token>".',
        },
      };
    }

    const token = trimmedHeader.slice(7).trim();
    if (!token) {
      return {
        success: false,
        requestId,
        statusCode: 401,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Missing bearer token in Authorization header.',
        },
      };
    }

    // --- Production Authentication (JWT / OIDC) ------------------------------
    if (authMode === 'production') {
      // Reject development tokens in production mode
      if (isDevelopmentToken(token)) {
        return {
          success: false,
          requestId,
          statusCode: 401,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Development tokens are not accepted in production authentication mode.',
          },
        };
      }

      const verifier = options.authConfig.jwtVerifier;
      if (!verifier) {
        return {
          success: false,
          requestId,
          statusCode: 401,
          error: {
            code: 'UNAUTHORIZED',
            message:
              'Production authentication configuration is incomplete. Missing SUPABASE_URL or SUPABASE_JWT_ISSUER.',
          },
        };
      }

      return (async (): Promise<AuthResult> => {
        const verified = await verifier.verify(token);
        if (!verified.valid || !verified.claims) {
          return {
            success: false,
            requestId,
            statusCode: 401,
            error: {
              code: 'UNAUTHORIZED',
              message: `Authentication failed: ${verified.error ?? 'Invalid token.'}`,
            },
          };
        }

        const identity: IdentityContext = {
          userId: verified.claims.sub,
          authMethod: 'bearer_jwt',
          requestId,
          email: typeof verified.claims.email === 'string' ? verified.claims.email : undefined,
        };

        return {
          success: true,
          requestId,
          identity,
        };
      })();
    }

    // --- Development Authentication (HMAC Dev Tokens) ------------------------
    const now = options.nowMs?.() ?? Date.now();
    const verified = verifyDevToken(token, options.authConfig.authSecret, now);

    if (!verified.valid || !verified.userId) {
      return {
        success: false,
        requestId,
        statusCode: 401,
        error: {
          code: 'UNAUTHORIZED',
          message: `Authentication failed: ${verified.error ?? 'Invalid token.'}`,
        },
      };
    }

    const identity: IdentityContext = {
      userId: verified.userId,
      authMethod: 'bearer_token',
      requestId,
    };

    return {
      success: true,
      requestId,
      identity,
    };
  }

  // 2. No Authorization header: check authentication mode
  if (authMode === 'development') {
    // Development mode permits X-User-Id header or configured defaultUserId
    const headerUserId = req.headers['x-user-id'];
    if (typeof headerUserId === 'string' && headerUserId.trim() !== '') {
      const identity: IdentityContext = {
        userId: headerUserId.trim(),
        authMethod: 'development_header',
        requestId,
      };
      return {
        success: true,
        requestId,
        identity,
      };
    }

    if (options.defaultUserId && options.defaultUserId.trim() !== '') {
      const identity: IdentityContext = {
        userId: options.defaultUserId.trim(),
        authMethod: 'development_header',
        requestId,
      };
      return {
        success: true,
        requestId,
        identity,
      };
    }

    return {
      success: false,
      requestId,
      statusCode: 401,
      error: {
        code: 'UNAUTHORIZED',
        message:
          'Authentication required. In development mode, provide "Authorization: Bearer <token>" or "X-User-Id" header.',
      },
    };
  }

  // Production mode: client-supplied X-User-Id is strictly untrusted and rejected
  return {
    success: false,
    requestId,
    statusCode: 401,
    error: {
      code: 'UNAUTHORIZED',
      message:
        'Authentication required. Provide "Authorization: Bearer <token>". Client-supplied identity headers are not accepted.',
    },
  };
}
