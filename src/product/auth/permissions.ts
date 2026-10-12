/**
 * Pure Tenant Authorization Functions — Build 11: Hosted MVP Foundation.
 *
 * Enforces strict workspace boundary isolation and role-based permissions.
 * Every function is deterministic, pure, and independently testable.
 */

import type { WorkspaceMember } from '../types/workspace.js';
import { ROLE_PERMISSIONS } from './roles.js';

/** Verifies that a membership belongs to the target workspace. */
function belongsToWorkspace(
  membership: WorkspaceMember | null | undefined,
  workspaceId: string,
): membership is WorkspaceMember {
  return Boolean(membership && membership.workspaceId === workspaceId);
}

/** Whether the actor can read/view workspace details. */
export function canReadWorkspace(
  membership: WorkspaceMember | null | undefined,
  workspaceId: string,
): boolean {
  if (!belongsToWorkspace(membership, workspaceId)) return false;
  // All valid workspace members (owner, member, reviewer, viewer) have read access.
  return true;
}

/** Whether the actor can manage workspace settings. */
export function canManageWorkspace(
  membership: WorkspaceMember | null | undefined,
  workspaceId: string,
): boolean {
  if (!belongsToWorkspace(membership, workspaceId)) return false;
  return ROLE_PERMISSIONS[membership.role].canManageWorkspace;
}

/** Whether the actor can manage workspace memberships. */
export function canManageMembers(
  membership: WorkspaceMember | null | undefined,
  workspaceId: string,
): boolean {
  if (!belongsToWorkspace(membership, workspaceId)) return false;
  return ROLE_PERMISSIONS[membership.role].canManageMembers;
}

/** Whether the actor can create, edit, or delete projects in the workspace. */
export function canManageProject(
  membership: WorkspaceMember | null | undefined,
  project: { workspaceId: string },
): boolean {
  if (!belongsToWorkspace(membership, project.workspaceId)) return false;
  return ROLE_PERMISSIONS[membership.role].canManageProjects;
}

/** Whether the actor can configure target environments and approved origins. */
export function canConfigureTargets(
  membership: WorkspaceMember | null | undefined,
  targetOrProject: { workspaceId: string },
): boolean {
  if (!belongsToWorkspace(membership, targetOrProject.workspaceId)) return false;
  return ROLE_PERMISSIONS[membership.role].canConfigureTargets;
}

/** Whether the actor can approve user journeys for a target. */
export function canApproveJourneys(
  membership: WorkspaceMember | null | undefined,
  entity: { workspaceId: string },
): boolean {
  if (!belongsToWorkspace(membership, entity.workspaceId)) return false;
  return ROLE_PERMISSIONS[membership.role].canApproveJourneys;
}

/** Whether the actor can trigger or run tests against an approved project target. */
export function canRunProject(
  membership: WorkspaceMember | null | undefined,
  projectOrRun: { workspaceId: string },
): boolean {
  if (!belongsToWorkspace(membership, projectOrRun.workspaceId)) return false;
  return ROLE_PERMISSIONS[membership.role].canRunTests;
}

/** Whether the actor can view execution reports and run artifacts. */
export function canViewReports(
  membership: WorkspaceMember | null | undefined,
  entity: { workspaceId: string },
): boolean {
  if (!belongsToWorkspace(membership, entity.workspaceId)) return false;
  return ROLE_PERMISSIONS[membership.role].canViewReports;
}

/** Whether the actor can record human candidate review decisions. */
export function canReviewCandidate(
  membership: WorkspaceMember | null | undefined,
  candidateOrProject: { workspaceId: string },
): boolean {
  if (!belongsToWorkspace(membership, candidateOrProject.workspaceId)) return false;
  return ROLE_PERMISSIONS[membership.role].canReviewCandidates;
}
