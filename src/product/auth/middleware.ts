/**
 * Product API Request Authentication Middleware — Build 12B.1: Real Authentication Boundary.
 *
 * Inspects incoming HTTP requests, enforces authentication boundaries,
 * and extracts validated IdentityContext.
 *
 * Rules:
 * - Production mode (PRODUCT_AUTH_MODE=production) strictly requires `Authorization: Bearer <token>`.
 * - Production mode NEVER trusts client-supplied `X-User-Id` headers.
 * - Development mode (PRODUCT_AUTH_MODE=development) allows local test convenience via `X-User-Id`
 *   or defaultUserId when no Bearer token is provided.
 * - If a Bearer token is provided in any mode, it must be valid and unexpired.
 * - All responses carry a generated `requestId`.
 * - Tokens, headers, and secrets are never logged.
 */

import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { IdentityContext, AuthConfig } from './identity.js';
import { verifyDevToken } from './devToken.js';
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

/**
 * Extracts and validates the identity context from an incoming HTTP request.
 */
export function authenticateRequest(
  req: IncomingMessage,
  options: AuthenticateRequestOptions,
): AuthResult {
  const clientReqId = req.headers['x-request-id'];
  const requestId =
    typeof clientReqId === 'string' &&
    clientReqId.trim().length > 0 &&
    /^[a-zA-Z0-9_\-\.]+$/.test(clientReqId.trim())
      ? clientReqId.trim()
      : options.idGenerator?.generateId('req') ?? `req_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const authHeader = req.headers['authorization'];

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
  if (options.authConfig.authMode === 'development') {
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
        message: 'Authentication required. In development mode, provide "Authorization: Bearer <token>" or "X-User-Id" header.',
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
      message: 'Authentication required. Provide "Authorization: Bearer <token>". Client-supplied identity headers are not accepted.',
    },
  };
}
