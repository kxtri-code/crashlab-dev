/**
 * Approved Journey Domain Contract — Build 11: Hosted MVP Foundation.
 *
 * Defines an authorized journey that has passed human QA review and is approved
 * for execution against a specific target environment.
 */

export interface ProductApprovedJourney {
  readonly id: string;
  readonly schemaVersion: '1.0';
  readonly workspaceId: string;
  readonly projectId: string;
  readonly targetEnvironmentId: string;
  readonly goal: string;
  readonly origin: string;
  readonly allowedActions: readonly string[];
  readonly forbiddenActions: readonly string[];
  readonly requiresCredentials: boolean;
  readonly requiresTestData: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateApprovedJourneyInput {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly targetEnvironmentId: string;
  readonly goal: string;
  readonly origin: string;
  readonly allowedActions: readonly string[];
  readonly forbiddenActions?: readonly string[];
  readonly requiresCredentials?: boolean;
  readonly requiresTestData?: boolean;
}
