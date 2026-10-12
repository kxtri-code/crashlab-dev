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
}

export interface TransitionValidationResult {
  readonly valid: boolean;
  readonly error?: string;
  readonly auditEventType?: AuditEventType;
}

/** Allowed state transitions map. */
const ALLOWED_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  created: ['preflight', 'cancelled'],
  preflight: ['queued', 'blocked', 'cancelled'],
  queued: ['running', 'cancelled'],
  running: ['completed', 'partial', 'failed', 'blocked', 'cancelled'],
  completed: [],
  partial: [],
  failed: [],
  blocked: [],
  cancelled: [],
};

/** Terminal statuses that can never transition further. */
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  'completed',
  'partial',
  'failed',
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

  // 3. Preflight readiness requirement for 'queued' and 'running'
  if (nextStatus === 'queued' || nextStatus === 'running') {
    const isReady = context.preflightReady ?? currentRun.preflightStatus === 'ready';
    if (!isReady) {
      return {
        valid: false,
        error: `Cannot transition run to "${nextStatus}" because preflight safety gate status is not "ready".`,
      };
    }
  }

  // 4. Completed run requirement: must have valid execution evidence
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

  // 5. Invariant check: safeTestMode cannot be bypassed
  if (currentRun.safeTestMode !== true) {
    return {
      valid: false,
      error: 'Cannot execute run: safeTestMode is not enabled. CrashLab requires safe-test mode on all runs.',
    };
  }

  // 6. Map to appropriate audit event
  let auditEventType: AuditEventType = 'run.transitioned';
  if (nextStatus === 'running') {
    auditEventType = 'run.started';
  } else if (nextStatus === 'completed' || nextStatus === 'partial') {
    auditEventType = 'run.completed';
  } else if (nextStatus === 'blocked') {
    auditEventType = 'run.preflight_blocked';
  }

  return {
    valid: true,
    auditEventType,
  };
}
