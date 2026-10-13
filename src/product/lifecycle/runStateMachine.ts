/**
 * Test Run State Machine & Transition Logic — Build 11: Hosted MVP Foundation.
 *
 * Implements pure state transition validation for test execution lifecycle.
 * Enforces safety gates: preflight readiness, safe-test mode, and terminal immutability.
 */

import type { RunStatus, TestRun } from '../types/run.js';
import type { AuditEventType } from '../types/audit.js';

export interface TransitionContext {
  /** Preflight readiness status. Required to transition to 'queued' or 'running'. */
  readonly preflightReady?: boolean;
  /** Presence of verifiable execution evidence. Required for 'completed'. */
  readonly hasExecutionEvidence?: boolean;
  /** Whether the run had passing steps (required for full completion vs partial). */
  readonly hasPassedSteps?: boolean;
  /** Reason for failure, blocking, or cancellation. */
  readonly reason?: string;
  /** Explicit manual retry request flag. Required to transition 'failed' -> 'queued'. */
  readonly explicitRetry?: boolean;
}

export interface TransitionValidationResult {
  readonly valid: boolean;
  readonly error?: string;
  readonly auditEventType?: AuditEventType;
}

/** Allowed state transitions map. */
const ALLOWED_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  created: ['preflight', 'queued', 'cancelled'],
  preflight: ['running', 'queued', 'blocked', 'cancelled'],
  queued: ['preflight', 'running', 'cancelled'],
  running: ['completed', 'partial', 'failed', 'blocked', 'cancelling', 'cancelled'],
  cancelling: ['cancelled'],
  completed: [],
  partial: [],
  failed: ['queued'],
  blocked: [],
  cancelled: [],
};

/** Terminal statuses that can never transition further. */
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  'completed',
  'partial',
  'blocked',
  'cancelled',
] as const;

/**
 * Pure transition validator.
 * Checks whether transitioning `currentRun` to `nextStatus` obeys all CrashLab rules.
 */
export function validateRunTransition(
  currentRun: TestRun,
  nextStatus: RunStatus,
  context: TransitionContext = {},
): TransitionValidationResult {
  const currentStatus = currentRun.status;

  // 1. Terminal state check: terminal states cannot transition to anything
  if (TERMINAL_RUN_STATUSES.includes(currentStatus)) {
    return {
      valid: false,
      error: `Cannot transition run from terminal state "${currentStatus}" to "${nextStatus}". Terminal states are immutable.`,
    };
  }

  // 2. Direct edge check
  const allowedNext = ALLOWED_TRANSITIONS[currentStatus];
  if (!allowedNext.includes(nextStatus)) {
    return {
      valid: false,
      error: `Invalid transition from "${currentStatus}" to "${nextStatus}". Allowed target states: ${allowedNext.join(', ') || 'none'}.`,
    };
  }

  // 3. Explicit retry requirement for failed -> queued
  if (currentStatus === 'failed' && nextStatus === 'queued') {
    if (!context.explicitRetry) {
      return {
        valid: false,
        error: 'Cannot re-queue failed run automatically: explicit retry request is required.',
      };
    }
    if (currentRun.attemptCount !== undefined && currentRun.maxAttempts !== undefined) {
      if (currentRun.attemptCount >= currentRun.maxAttempts) {
        return {
          valid: false,
          error: `Cannot re-queue run: maximum attempts (${currentRun.maxAttempts}) reached.`,
        };
      }
    }
  }

  // 4. Preflight readiness requirement for 'running' or 'preflight' -> 'queued'
  if (nextStatus === 'running' || (currentStatus === 'preflight' && nextStatus === 'queued')) {
    const isReady = context.preflightReady ?? currentRun.preflightStatus === 'ready';
    if (!isReady) {
      return {
        valid: false,
        error: `Cannot transition run to "${nextStatus}" because preflight safety gate status is not "ready".`,
      };
    }
  }

  // 5. Completed run requirement: must have valid execution evidence
  if (nextStatus === 'completed') {
    if (context.hasExecutionEvidence === false) {
      return {
        valid: false,
        error: 'Cannot mark run as "completed" without valid execution evidence.',
      };
    }
    if (context.hasPassedSteps === false) {
      return {
        valid: false,
        error: 'Cannot mark run as "completed" when zero steps passed. Run must be classified as "partial".',
      };
    }
  }

  // 6. Invariant check: safeTestMode cannot be bypassed
  if (currentRun.safeTestMode !== true) {
    return {
      valid: false,
      error: 'Cannot execute run: safeTestMode is not enabled. CrashLab requires safe-test mode on all runs.',
    };
  }

  // 7. Map to appropriate audit event
  let auditEventType: AuditEventType = 'run.transitioned';
  if (nextStatus === 'running') {
    auditEventType = 'run.started';
  } else if (nextStatus === 'completed' || nextStatus === 'partial') {
    auditEventType = 'run.completed';
  } else if (nextStatus === 'blocked') {
    auditEventType = 'run.preflight_blocked';
  } else if (nextStatus === 'failed') {
    auditEventType = 'run.failed';
  } else if (nextStatus === 'cancelled') {
    auditEventType = 'run.cancelled';
  } else if (currentStatus === 'failed' && nextStatus === 'queued') {
    auditEventType = 'run.retried';
  } else if (nextStatus === 'queued') {
    auditEventType = 'run.queued';
  }

  return {
    valid: true,
    auditEventType,
  };
}
