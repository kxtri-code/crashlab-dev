/**
 * Target Environment Domain Contract — Build 11: Hosted MVP Foundation.
 *
 * Defines an authorized testing environment for a project.
 * Contains safe metadata and non-secret references only.
 * Prohibits production environments, passwords, cookies, bearer tokens, and API keys.
 */

import type { PilotEnvironment } from '../../preflight/types.js';

export type ProductTargetEnvironmentType = PilotEnvironment;

/**
 * Backend-agnostic target authentication strategies (Build 12L).
 * Independent of Supabase or any specific provider.
 */
export type TargetAuthStrategy =
  | 'public'
  | 'basic_credentials'
  | 'cookies_session'
  | 'oauth_session'
  | 'custom_header';

export interface TargetAuthConfig {
  readonly strategy: TargetAuthStrategy;
  /** Safe non-secret environment variable or vault reference key (e.g. STAGING_AUTH_KEY). */
  readonly credentialReference?: string;
  /** Safe custom header name (e.g. X-Staging-Access or Authorization). */
  readonly headerName?: string;
  /** Safe non-secret username or email identifier (e.g. pilot-operator@company.test). */
  readonly usernameReference?: string;
  /** Safe operator-facing description of the staging auth mechanism. */
  readonly description?: string;
  /** Server-computed flag indicating whether the referenced environment secret is configured. */
  readonly credentialConfigured?: boolean;
}

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
  /** Target authentication configuration (independent of provider, secrets stored in server env). */
  readonly authConfig?: TargetAuthConfig;
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
  readonly authConfig?: TargetAuthConfig;
  readonly authorizationReference?: string;
  readonly testDataReference?: string;
  readonly forbiddenActions?: readonly string[];
  readonly resetProcedure?: string;
  readonly testingWindow?: string;
}
