/**
 * Workspace & Membership Domain Contracts — Build 11: Hosted MVP Foundation.
 *
 * Defines the core tenant boundary in CrashLab. Every project, target, run,
 * and artifact belongs strictly to a workspace.
 */

export type WorkspaceRole = 'owner' | 'member' | 'reviewer' | 'viewer';

export const WORKSPACE_ROLES: readonly WorkspaceRole[] = [
  'owner',
  'member',
  'reviewer',
  'viewer',
] as const;

export interface Workspace {
  readonly id: string;
  readonly schemaVersion: '1.0';
  readonly name: string;
  readonly slug: string;
  readonly ownerUserId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkspaceMember {
  readonly id: string;
  readonly schemaVersion: '1.0';
  readonly workspaceId: string;
  readonly userId: string;
  readonly role: WorkspaceRole;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateWorkspaceInput {
  readonly name: string;
  readonly slug: string;
  readonly ownerUserId: string;
}

export interface AddWorkspaceMemberInput {
  readonly workspaceId: string;
  readonly userId: string;
  readonly role: WorkspaceRole;
}
