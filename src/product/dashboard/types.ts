/**
 * Product Dashboard Types & Interfaces — Build 12C.1.
 *
 * Defines contracts for:
 * - Dashboard web client state and routing
 * - Authenticated API client interfaces
 * - Static server configuration and lifecycle
 */

import type { TestRun, RunStatus } from '../types/run.js';
import type { RunQueueItem, RunQueueStatus } from '../queue/types.js';
import type { Workspace } from '../types/workspace.js';
import type { Project } from '../types/project.js';
import type { TargetEnvironment } from '../types/target.js';
import type { ProductApprovedJourney } from '../types/journey.js';
import type { CandidateReference } from '../types/candidate.js';
import type { RunArtifact } from '../types/artifact.js';

export const DEFAULT_DASHBOARD_HOST = '127.0.0.1';
export const DEFAULT_DASHBOARD_PORT = 3221;
export const DEFAULT_PRODUCT_API_URL = 'http://127.0.0.1:3220';

export interface DashboardUser {
  readonly id: string;
  readonly schemaVersion: string;
  readonly name: string;
  readonly email: string;
  readonly status: 'active' | 'suspended';
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type DashboardRoute =
  | 'auth'
  | 'overview'
  | 'projects'
  | 'project-detail'
  | 'targets'
  | 'journeys'
  | 'runs'
  | 'run-detail'
  | 'candidates'
  | 'artifacts'
  | 'security';

export interface DashboardServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly apiUrl?: string;
}

export interface RunningDashboardServer {
  readonly url: string;
  readonly port: number;
  readonly apiUrl: string;
  stop(): Promise<void>;
}

export interface PollingConfig {
  readonly intervalMs: number;
  readonly maxConsecutiveFailures: number;
  readonly backoffFactor: number;
}
