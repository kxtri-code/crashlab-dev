/**
 * Review API error definitions (Build 9.1).
 *
 * Deterministic, structured errors for the read-only HTTP API.
 * Never leaks stack traces, environment variables, or local absolute paths.
 */

import type { ApiErrorResponse } from './types.js';

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(statusCode: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Predefined factory functions for stable error responses. */
export function notFoundError(message: string, code: string = 'not-found', details?: Record<string, unknown>): ApiError {
  return new ApiError(404, code, message, details);
}

export function candidateNotFoundError(candidateId: string): ApiError {
  return new ApiError(404, 'candidate-not-found', `Candidate "${candidateId}" was not found.`, { candidateId });
}

export function baselineNotFoundError(baselineId: string): ApiError {
  return new ApiError(404, 'baseline-not-found', `Baseline "${baselineId}" was not found.`, { baselineId });
}

export function methodNotAllowedError(method?: string): ApiError {
  return new ApiError(
    405,
    'method-not-allowed',
    `Method "${method ?? 'UNKNOWN'}" not allowed. CrashLab Review API is read-only (GET, HEAD only).`,
  );
}

export function invalidQueryError(message: string, details?: Record<string, unknown>): ApiError {
  return new ApiError(400, 'invalid-query', message, details);
}

export function invalidPathError(message: string, details?: Record<string, unknown>): ApiError {
  return new ApiError(400, 'invalid-path', message, details);
}

export function invalidPaginationError(message: string, details?: Record<string, unknown>): ApiError {
  return new ApiError(400, 'invalid-pagination', message, details);
}

export function serviceUnavailableError(message: string, details?: Record<string, unknown>): ApiError {
  return new ApiError(503, 'service-unavailable', message, details);
}

export function internalServerError(message: string = 'An unexpected internal error occurred.'): ApiError {
  return new ApiError(500, 'internal-error', message);
}

/** Format any error safely into a structured ApiErrorResponse without leaking internal details. */
export function formatApiError(error: unknown): { statusCode: number; response: ApiErrorResponse } {
  if (error instanceof ApiError) {
    return {
      statusCode: error.statusCode,
      response: {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      },
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  // Redact local path markers or stack markers if any present in unexpected message
  const sanitizedMessage = message.replace(/[A-Za-z]:\\[^\s]+/g, '[redacted-path]').replace(/\/[^\s]+/g, '[redacted-path]');

  return {
    statusCode: 500,
    response: {
      error: {
        code: 'internal-error',
        message: sanitizedMessage || 'An unexpected internal error occurred.',
      },
    },
  };
}
