/**
 * Test Run Domain Contract — Build 11: Hosted MVP Foundation.
 *
 * Defines the state machine entity for test execution.
 * Enforces safe-test mode and strict lifecycle invariants.
 */

import type { SafetyGateStatus } from '../../preflight/types.js';

export type RunStatus =
  | 'created'
  | 'preflight'
  | 'queued'
  | 'running'
  | 'cancelling'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'blocked'
  | 'cancelled';

export const RUN_STATUSES: readonly RunStatus[] = [
  'created',
  'preflight',
  'queued',
  'running',
  'cancelling',
  'completed',
  'partial',
  'failed',
  'blocked',
  'cancelled',
] as const;

export interface TestRun {
  readonly id: string;
  readonly schemaVersion: '1.0';
  readonly workspaceId: string;
  readonly projectId: string;
  readonly targetEnvironmentId: string;
  readonly journeyId: string;
  readonly status: RunStatus;
  /** Invariant: Safe test mode is permanently enabled. */
  readonly safeTestMode: true;
  readonly preflightStatus: SafetyGateStatus | 'pending';
  readonly preflightReportRef?: string;
  readonly executionReportRef?: string;
  readonly anomalyReportRef?: string;
  readonly reproductionReportRef?: string;
  readonly candidatesReportRef?: string;
  readonly anomalyCount?: number;
  readonly candidateCount?: number;
  readonly baselineRef?: string;
  readonly blockedReason?: string;
  readonly failureReason?: string;
  readonly cancelReason?: string;
  readonly attemptCount?: number;
  readonly maxAttempts?: number;
  readonly availableAt?: string;
  readonly leaseOwner?: string;
  readonly leaseExpiry?: string;
  readonly lastError?: string;
  readonly cancelledAt?: string;
  readonly requestId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
}

export interface CreateTestRunInput {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly targetEnvironmentId: string;
  readonly journeyId: string;
  readonly maxAttempts?: number;
  readonly requestId?: string;
  readonly validatePreflight?: boolean;
}
