/**
 * Product API Contracts — Build 11: Hosted MVP Foundation.
 *
 * Defines request and response payload contracts for the product API.
 * Contains ZERO secrets, passwords, cookies, or bearer tokens.
 */

import type { Workspace } from '../types/workspace.js';
import type { Project } from '../types/project.js';
import type { TestRun } from '../types/run.js';
import type { RunArtifact } from '../types/artifact.js';

export interface ApiSuccessResponse<T> {
  readonly success: true;
  readonly data: T;
}

export interface ApiErrorResponse {
  readonly success: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
  };
}

export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

export interface HealthResponse {
  readonly status: 'ok';
  readonly version: string;
  readonly appEnvironment: string;
  readonly mode: 'hosted-mvp-foundation';
}

export interface CreateWorkspaceRequest {
  readonly name: string;
  readonly slug: string;
}

export interface CreateProjectRequest {
  readonly workspaceId: string;
  readonly name: string;
  readonly description?: string;
}

export interface WorkspacesListResponse {
  readonly workspaces: readonly Workspace[];
}

export interface ProjectsListResponse {
  readonly projects: readonly Project[];
}

export interface RunsListResponse {
  readonly runs: readonly TestRun[];
}

export interface ArtifactsListResponse {
  readonly artifacts: readonly RunArtifact[];
}
