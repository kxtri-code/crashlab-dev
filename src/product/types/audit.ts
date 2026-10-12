/**
 * Audit Event Domain Contract — Build 11: Hosted MVP Foundation.
 *
 * Defines the immutable security and compliance audit log for all tenant actions.
 * Contains safe metadata only; prohibits secrets, tokens, cookies, and raw test data.
 */

export type AuditEventType =
  | 'workspace.created'
  | 'workspace.member_added'
  | 'workspace.member_removed'
  | 'project.created'
  | 'target.configured'
  | 'journey.approved'
  | 'run.requested'
  | 'run.preflight_passed'
  | 'run.preflight_blocked'
  | 'run.started'
  | 'run.completed'
  | 'run.transitioned'
  | 'candidate.reviewed';

export interface AuditEvent {
  readonly id: string;
  readonly schemaVersion: '1.0';
  readonly workspaceId: string;
  readonly actorUserId: string;
  readonly eventType: AuditEventType;
  readonly entityType: string;
  readonly entityId: string;
  /** Safe, non-secret metadata only. */
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly timestamp: string;
}

export interface CreateAuditEventInput {
  readonly workspaceId: string;
  readonly actorUserId: string;
  readonly eventType: AuditEventType;
  readonly entityType: string;
  readonly entityId: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}
