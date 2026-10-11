/**
 * Review API input and parameter validator (Build 9.1).
 *
 * Strict validation of:
 *  - URL route segments (candidate IDs, baseline IDs)
 *  - Query parameters and filter names
 *  - Pagination bounds (limit 1..100, non-negative offset)
 *  - Host and port options
 *
 * Rejects unknown query keys, path traversal, control characters, and null bytes.
 */

import { validateCandidateId } from '../review/identity.js';
import { validateBaselineId } from '../baseline/validator.js';
import {
  invalidPathError,
  invalidQueryError,
  invalidPaginationError,
} from './errors.js';
import type { CandidateQueryFilters, BaselineQueryFilters } from './types.js';
import type { CandidateClassification, ReviewComparison } from '../review/types.js';
import type { ReviewStateStatus } from '../review/reviewStateTypes.js';
import type { BaselineStatus } from '../baseline/types.js';

export const VALID_CANDIDATE_CLASSIFICATIONS: ReadonlySet<CandidateClassification> = new Set([
  'novel',
  'reintroduced',
  'persistent',
  'resolved',
  'changed',
  'cross-environment',
  'different-build',
  'unknown',
]);

export const VALID_REVIEW_STATUSES: ReadonlySet<ReviewStateStatus | 'unreviewed'> = new Set([
  'open',
  'investigating',
  'accepted',
  'dismissed',
  'duplicate',
  'resolved',
  'unreviewed',
]);

export const VALID_REVIEW_COMPARISONS: ReadonlySet<ReviewComparison> = new Set([
  'same-environment',
  'different-environment',
  'unknown-environment',
  'different-build',
  'incompatible-journey',
  'no-baseline',
]);

export const VALID_BASELINE_STATUSES: ReadonlySet<BaselineStatus> = new Set([
  'known-good',
  'known-good-partial',
  'known-good-declared',
]);

export const ALLOWED_CANDIDATE_QUERY_KEYS: ReadonlySet<string> = new Set([
  'classification',
  'reviewStatus',
  'ruleId',
  'kind',
  'reproduced',
  'environment',
  'requiresInvestigation',
  'baselinePresent',
  'currentPresent',
  'limit',
  'offset',
]);

export const ALLOWED_BASELINE_QUERY_KEYS: ReadonlySet<string> = new Set([
  'origin',
  'journey',
  'build',
  'status',
  'coverage',
  'limit',
  'offset',
]);

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 100;

/**
 * Validate candidate ID from URL route segment.
 * Accepts canonical `cand-[0-9a-f]{16}` and positional aliases like `candidate-001`.
 */
export function validateCandidateIdRoute(id: string): string {
  if (typeof id !== 'string' || id.trim() === '') {
    throw invalidPathError('Candidate ID must not be empty.');
  }
  const trimmed = id.trim();
  if (trimmed.length > 64) {
    throw invalidPathError(`Candidate ID exceeds maximum length of 64 characters (${trimmed.length}).`);
  }
  if (/[\x00-\x1f\x7f\\/]/.test(trimmed) || trimmed.includes('..')) {
    throw invalidPathError('Candidate ID contains invalid characters, control characters, or path traversal.');
  }

  const check = validateCandidateId(trimmed);
  if (!check.valid) {
    throw invalidPathError(check.error ?? 'Invalid candidate ID.');
  }
  return trimmed;
}

/**
 * Validate baseline ID from URL route segment.
 */
export function validateBaselineIdRoute(id: string): string {
  if (typeof id !== 'string' || id.trim() === '') {
    throw invalidPathError('Baseline ID must not be empty.');
  }
  const trimmed = id.trim();
  if (trimmed.length > 64) {
    throw invalidPathError(`Baseline ID exceeds maximum length of 64 characters (${trimmed.length}).`);
  }
  if (/[\x00-\x1f\x7f\\/]/.test(trimmed) || trimmed.includes('..')) {
    throw invalidPathError('Baseline ID contains invalid characters, control characters, or path traversal.');
  }

  try {
    validateBaselineId(trimmed);
  } catch (err) {
    throw invalidPathError((err as Error).message);
  }
  return trimmed;
}

/**
 * Validate pagination parameters.
 */
export function validatePagination(
  limitParam: string | null,
  offsetParam: string | null,
): { limit: number; offset: number } {
  let limit = DEFAULT_PAGE_LIMIT;
  let offset = 0;

  if (limitParam !== null && limitParam !== undefined) {
    if (!/^\d+$/.test(limitParam)) {
      throw invalidPaginationError(`Invalid limit parameter "${limitParam}". Must be a positive integer.`);
    }
    limit = parseInt(limitParam, 10);
    if (limit < 1 || limit > MAX_PAGE_LIMIT) {
      throw invalidPaginationError(
        `Limit must be between 1 and ${MAX_PAGE_LIMIT} (received ${limit}).`,
      );
    }
  }

  if (offsetParam !== null && offsetParam !== undefined) {
    if (!/^\d+$/.test(offsetParam)) {
      throw invalidPaginationError(`Invalid offset parameter "${offsetParam}". Must be a non-negative integer.`);
    }
    offset = parseInt(offsetParam, 10);
    if (offset < 0) {
      throw invalidPaginationError(`Offset must be non-negative (received ${offset}).`);
    }
  }

  return { limit, offset };
}

/**
 * Parse and validate boolean query parameters.
 */
function parseBooleanParam(key: string, val: string | null): boolean | undefined {
  if (val === null || val === undefined) return undefined;
  const lower = val.trim().toLowerCase();
  if (lower === 'true' || lower === '1') return true;
  if (lower === 'false' || lower === '0') return false;
  throw invalidQueryError(`Parameter "${key}" must be a boolean ('true' or 'false'), received "${val}".`);
}

/**
 * Validate candidate query parameters and return structured filters.
 * Rejects any unknown query keys.
 */
export function validateCandidateFilters(params: URLSearchParams): CandidateQueryFilters {
  for (const key of params.keys()) {
    if (!ALLOWED_CANDIDATE_QUERY_KEYS.has(key)) {
      throw invalidQueryError(
        `Unknown candidate query parameter "${key}". Allowed parameters: ${[...ALLOWED_CANDIDATE_QUERY_KEYS].join(', ')}.`,
      );
    }
  }

  const { limit, offset } = validatePagination(params.get('limit'), params.get('offset'));

  const classificationRaw = params.get('classification');
  let classification: CandidateClassification | undefined;
  if (classificationRaw !== null) {
    if (!VALID_CANDIDATE_CLASSIFICATIONS.has(classificationRaw as CandidateClassification)) {
      throw invalidQueryError(
        `Invalid classification "${classificationRaw}". Allowed: ${[...VALID_CANDIDATE_CLASSIFICATIONS].join(', ')}.`,
      );
    }
    classification = classificationRaw as CandidateClassification;
  }

  const reviewStatusRaw = params.get('reviewStatus');
  let reviewStatus: (ReviewStateStatus | 'unreviewed') | undefined;
  if (reviewStatusRaw !== null) {
    if (!VALID_REVIEW_STATUSES.has(reviewStatusRaw as ReviewStateStatus | 'unreviewed')) {
      throw invalidQueryError(
        `Invalid reviewStatus "${reviewStatusRaw}". Allowed: ${[...VALID_REVIEW_STATUSES].join(', ')}.`,
      );
    }
    reviewStatus = reviewStatusRaw as ReviewStateStatus | 'unreviewed';
  }

  const environmentRaw = params.get('environment');
  let environment: ReviewComparison | undefined;
  if (environmentRaw !== null) {
    if (!VALID_REVIEW_COMPARISONS.has(environmentRaw as ReviewComparison)) {
      throw invalidQueryError(
        `Invalid environment comparison "${environmentRaw}". Allowed: ${[...VALID_REVIEW_COMPARISONS].join(', ')}.`,
      );
    }
    environment = environmentRaw as ReviewComparison;
  }

  return {
    classification,
    reviewStatus,
    ruleId: params.get('ruleId') ?? undefined,
    kind: params.get('kind') ?? undefined,
    reproduced: parseBooleanParam('reproduced', params.get('reproduced')),
    environment,
    requiresInvestigation: parseBooleanParam('requiresInvestigation', params.get('requiresInvestigation')),
    baselinePresent: parseBooleanParam('baselinePresent', params.get('baselinePresent')),
    currentPresent: parseBooleanParam('currentPresent', params.get('currentPresent')),
    limit,
    offset,
  };
}

/**
 * Validate baseline query parameters and return structured filters.
 * Rejects any unknown query keys.
 */
export function validateBaselineFilters(params: URLSearchParams): BaselineQueryFilters {
  for (const key of params.keys()) {
    if (!ALLOWED_BASELINE_QUERY_KEYS.has(key)) {
      throw invalidQueryError(
        `Unknown baseline query parameter "${key}". Allowed parameters: ${[...ALLOWED_BASELINE_QUERY_KEYS].join(', ')}.`,
      );
    }
  }

  const { limit, offset } = validatePagination(params.get('limit'), params.get('offset'));

  const statusRaw = params.get('status');
  let status: BaselineStatus | undefined;
  if (statusRaw !== null) {
    if (!VALID_BASELINE_STATUSES.has(statusRaw as BaselineStatus)) {
      throw invalidQueryError(
        `Invalid baseline status "${statusRaw}". Allowed: ${[...VALID_BASELINE_STATUSES].join(', ')}.`,
      );
    }
    status = statusRaw as BaselineStatus;
  }

  return {
    origin: params.get('origin') ?? undefined,
    journey: params.get('journey') ?? undefined,
    build: params.get('build') ?? undefined,
    status,
    coverage: params.get('coverage') ?? undefined,
    limit,
    offset,
  };
}

/**
 * Validate host string.
 */
export function validateHost(host: unknown): string {
  if (typeof host !== 'string' || host.trim() === '') {
    return '127.0.0.1';
  }
  const trimmed = host.trim();
  // Safe local hosts or IPs
  if (/[\x00-\x1f\x7f\s]/.test(trimmed)) {
    throw new Error('Host contains invalid or whitespace characters.');
  }
  return trimmed;
}

/**
 * Validate port number.
 */
export function validatePort(port: unknown): number {
  if (typeof port === 'number') {
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error(`Port must be an integer between 0 and 65535 (received ${port}).`);
    }
    return port;
  }
  if (typeof port === 'string') {
    const trimmed = port.trim();
    if (!/^\d+$/.test(trimmed)) {
      throw new Error(`Port must be numeric (received "${port}").`);
    }
    const num = parseInt(trimmed, 10);
    if (num < 0 || num > 65535) {
      throw new Error(`Port must be between 0 and 65535 (received ${num}).`);
    }
    return num;
  }
  throw new Error('Port must be a number or numeric string.');
}
