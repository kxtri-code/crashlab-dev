/**
 * Project Domain Contract — Build 11: Hosted MVP Foundation.
 *
 * A project represents an application under test within a workspace.
 */

export interface Project {
  readonly id: string;
  readonly schemaVersion: '1.0';
  readonly workspaceId: string;
  readonly name: string;
  readonly description: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateProjectInput {
  readonly workspaceId: string;
  readonly name: string;
  readonly description?: string;
}
