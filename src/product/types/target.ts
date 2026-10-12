/**
 * Target Environment Domain Contract — Build 11: Hosted MVP Foundation.
 *
 * Defines an authorized testing environment for a project.
 * Contains safe metadata and non-secret references only.
 * Prohibits production environments, passwords, cookies, bearer tokens, and API keys.
 */

import type { PilotEnvironment } from '../../preflight/types.js';

export type ProductTargetEnvironmentType = PilotEnvironment;

export interface TargetEnvironment {
  readonly id: string;
  readonly schemaVersion: '1.0';
  readonly workspaceId: string;
  readonly projectId: string;
  readonly name: string;
  readonly environment: ProductTargetEnvironmentType;
  readonly targetUrl: string;
  readonly targetOrigin: string;
  readonly allowedOrigins: readonly string[];
  readonly appBuildId?: string;
  /** Non-secret reference to written authorization from application owner. */
  readonly authorizationReference?: string;
  /** Non-secret reference to protected test data fixture (e.g. key or vault ref, never raw values). */
  readonly testDataReference?: string;
  readonly forbiddenActions: readonly string[];
  readonly resetProcedure?: string;
  readonly testingWindow?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateTargetEnvironmentInput {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly name: string;
  readonly environment: ProductTargetEnvironmentType;
  readonly targetUrl: string;
  readonly allowedOrigins: readonly string[];
  readonly appBuildId?: string;
  readonly authorizationReference?: string;
  readonly testDataReference?: string;
  readonly forbiddenActions?: readonly string[];
  readonly resetProcedure?: string;
  readonly testingWindow?: string;
}
