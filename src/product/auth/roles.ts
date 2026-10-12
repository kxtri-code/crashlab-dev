/**
 * Role Definitions & Permission Matrices — Build 11: Hosted MVP Foundation.
 *
 * Defines the standard capabilities for workspace roles:
 *  - owner: full management, targets, tests, review
 *  - member: view projects, run tests, view reports
 *  - reviewer: view reports, update human review state
 *  - viewer: strictly read-only
 *
 * Invariant: No role may bypass payment guards, preflight validation,
 * origin restrictions, safe-test mode, or confirmation invariants.
 */

import type { WorkspaceRole } from '../types/workspace.js';

export interface RolePermissions {
  readonly canManageWorkspace: boolean;
  readonly canManageMembers: boolean;
  readonly canManageProjects: boolean;
  readonly canConfigureTargets: boolean;
  readonly canApproveJourneys: boolean;
  readonly canRunTests: boolean;
  readonly canViewReports: boolean;
  readonly canReviewCandidates: boolean;
}

export const ROLE_PERMISSIONS: Readonly<Record<WorkspaceRole, RolePermissions>> = {
  owner: {
    canManageWorkspace: true,
    canManageMembers: true,
    canManageProjects: true,
    canConfigureTargets: true,
    canApproveJourneys: true,
    canRunTests: true,
    canViewReports: true,
    canReviewCandidates: true,
  },
  member: {
    canManageWorkspace: false,
    canManageMembers: false,
    canManageProjects: false,
    canConfigureTargets: false,
    canApproveJourneys: false,
    canRunTests: true,
    canViewReports: true,
    canReviewCandidates: false,
  },
  reviewer: {
    canManageWorkspace: false,
    canManageMembers: false,
    canManageProjects: false,
    canConfigureTargets: false,
    canApproveJourneys: false,
    canRunTests: false,
    canViewReports: true,
    canReviewCandidates: true,
  },
  viewer: {
    canManageWorkspace: false,
    canManageMembers: false,
    canManageProjects: false,
    canConfigureTargets: false,
    canApproveJourneys: false,
    canRunTests: false,
    canViewReports: true,
    canReviewCandidates: false,
  },
};
