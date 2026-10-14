/**
 * Typed Product API Client — Build 12C.1.
 *
 * Implements a secure HTTP client for interacting with the Product API:
 * - Bearer authentication header injection
 * - Request ID extraction and propagation
 * - Error classification (401 Unauthorized, 403 Forbidden, 404 Not Found, 500 Server Error)
 * - Safe timeouts with AbortController
 * - Zero secret logging (passwords, tokens, and database credentials are never logged)
 * - Zero direct database queries (strictly communicates over HTTP)
 */

import type { ApiResponse } from '../api/types.js';
import type { Workspace } from '../types/workspace.js';
import type { Project } from '../types/project.js';
import type { TargetEnvironment } from '../types/target.js';
import type { ProductApprovedJourney } from '../types/journey.js';
import type { TestRun } from '../types/run.js';
import type { RunQueueItem } from '../queue/types.js';
import type { CandidateReference } from '../types/candidate.js';
import type { RunArtifact } from '../types/artifact.js';
import type { DashboardUser } from './types.js';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;

  constructor(status: number, code: string, message: string, requestId?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

export class UnauthorizedError extends ApiError {
  constructor(message = 'Authentication required.', requestId?: string) {
    super(401, 'UNAUTHORIZED', message, requestId);
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends ApiError {
  constructor(message = 'Access denied: insufficient permissions or cross-tenant access prohibited.', requestId?: string) {
    super(403, 'FORBIDDEN', message, requestId);
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends ApiError {
  constructor(message = 'Resource not found.', requestId?: string) {
    super(404, 'NOT_FOUND', message, requestId);
    this.name = 'NotFoundError';
  }
}

export class PreflightBlockedError extends ApiError {
  readonly failureReasons: readonly string[];

  constructor(message = 'Execution refused by safety preflight gate.', failureReasons: readonly string[] = [], requestId?: string) {
    super(422, 'PREFLIGHT_BLOCKED', message, requestId);
    this.name = 'PreflightBlockedError';
    this.failureReasons = failureReasons;
  }
}

export interface ProductApiClientOptions {
  readonly baseUrl: string;
  readonly token?: string | (() => string | null);
  readonly timeoutMs?: number;
}

export interface RequestOptions {
  readonly method?: 'GET' | 'POST';
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  readonly headers?: Record<string, string>;
}

export interface ApiResponseWithMeta<T> {
  readonly success: boolean;
  readonly data: T;
  readonly requestId?: string;
}

export class ProductApiClient {
  private readonly baseUrl: string;
  private readonly tokenProvider: () => string | null;
  private readonly timeoutMs: number;

  constructor(options: ProductApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    if (typeof options.token === 'function') {
      this.tokenProvider = options.token;
    } else if (typeof options.token === 'string') {
      const fixed = options.token;
      this.tokenProvider = () => fixed;
    } else {
      this.tokenProvider = () => null;
    }
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  private resolveToken(): string | null {
    return this.tokenProvider();
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<ApiResponseWithMeta<T>> {
    const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const token = this.resolveToken();

    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(options.headers ?? {}),
    };

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    let bodyStr: string | undefined;
    if (options.body !== undefined && options.body !== null) {
      headers['Content-Type'] = 'application/json';
      bodyStr = JSON.stringify(options.body);
    }

    const controller = new AbortController();
    const timeoutTimer = setTimeout(() => controller.abort(), this.timeoutMs);

    let signal: AbortSignal = controller.signal;
    if (options.signal) {
      options.signal.addEventListener('abort', () => controller.abort());
    }

    try {
      const res = await fetch(url, {
        method: options.method ?? 'GET',
        headers,
        body: bodyStr,
        signal,
      });

      const requestId = res.headers.get('x-request-id') ?? undefined;

      if (!res.ok) {
        let code = 'ERROR';
        let message = `HTTP ${res.status} ${res.statusText}`;
        let errJson: any = null;

        try {
          errJson = (await res.json()) as any;
          if (errJson && errJson.error) {
            code = errJson.error.code || code;
            message = errJson.error.message || message;
          }
        } catch {}

        if (res.status === 401) {
          throw new UnauthorizedError(message, requestId);
        }
        if (res.status === 403) {
          throw new ForbiddenError(message, requestId);
        }
        if (res.status === 404) {
          throw new NotFoundError(message, requestId);
        }
        if (res.status === 422 || code === 'PREFLIGHT_BLOCKED') {
          const reasons = errJson?.error?.details?.failureReasons ?? [];
          throw new PreflightBlockedError(message, reasons, requestId);
        }

        throw new ApiError(res.status, code, message, requestId);
      }

      const json = (await res.json()) as ApiResponse<T>;
      return {
        success: json.success,
        data: (json as any).data as T,
        requestId: requestId ?? json.requestId,
      };
    } finally {
      clearTimeout(timeoutTimer);
    }
  }

  async getMe(): Promise<ApiResponseWithMeta<{ user: DashboardUser }>> {
    return this.request<{ user: DashboardUser }>('/api/v1/me');
  }

  async listWorkspaces(): Promise<ApiResponseWithMeta<{ workspaces: readonly Workspace[] }>> {
    return this.request<{ workspaces: readonly Workspace[] }>('/api/v1/workspaces');
  }

  async getWorkspace(workspaceId: string): Promise<ApiResponseWithMeta<{ workspace: Workspace }>> {
    return this.request<{ workspace: Workspace }>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}`);
  }

  async listProjects(workspaceId: string): Promise<ApiResponseWithMeta<{ projects: readonly Project[] }>> {
    return this.request<{ projects: readonly Project[] }>(`/api/v1/projects?workspaceId=${encodeURIComponent(workspaceId)}`);
  }

  async getProject(workspaceId: string, projectId: string): Promise<ApiResponseWithMeta<Project>> {
    return this.request<Project>(`/api/v1/projects/${encodeURIComponent(projectId)}?workspaceId=${encodeURIComponent(workspaceId)}`);
  }

  async listTargets(workspaceId: string, projectId: string): Promise<ApiResponseWithMeta<{ targets: readonly TargetEnvironment[] }>> {
    return this.request<{ targets: readonly TargetEnvironment[] }>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/targets?workspaceId=${encodeURIComponent(workspaceId)}`,
    );
  }

  async listJourneys(workspaceId: string, targetId: string): Promise<ApiResponseWithMeta<{ journeys: readonly ProductApprovedJourney[] }>> {
    return this.request<{ journeys: readonly ProductApprovedJourney[] }>(
      `/api/v1/targets/${encodeURIComponent(targetId)}/journeys?workspaceId=${encodeURIComponent(workspaceId)}`,
    );
  }

  async listProjectJourneys(workspaceId: string, projectId: string): Promise<ApiResponseWithMeta<{ journeys: readonly ProductApprovedJourney[] }>> {
    return this.request<{ journeys: readonly ProductApprovedJourney[] }>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/journeys?workspaceId=${encodeURIComponent(workspaceId)}`,
    );
  }

  async getJourney(workspaceId: string, journeyId: string): Promise<ApiResponseWithMeta<ProductApprovedJourney>> {
    return this.request<ProductApprovedJourney>(
      `/api/v1/journeys/${encodeURIComponent(journeyId)}?workspaceId=${encodeURIComponent(workspaceId)}`,
    );
  }

  async createRun(input: {
    workspaceId: string;
    projectId: string;
    targetEnvironmentId: string;
    journeyId: string;
    maxAttempts?: number;
  }): Promise<ApiResponseWithMeta<TestRun>> {
    return this.request<TestRun>('/api/v1/runs', {
      method: 'POST',
      body: input,
    });
  }

  async listRuns(workspaceId: string, projectId: string): Promise<ApiResponseWithMeta<{ runs: readonly TestRun[] }>> {
    return this.request<{ runs: readonly TestRun[] }>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/runs?workspaceId=${encodeURIComponent(workspaceId)}`,
    );
  }

  async getRun(workspaceId: string, runId: string): Promise<ApiResponseWithMeta<TestRun>> {
    return this.request<TestRun>(`/api/v1/runs/${encodeURIComponent(runId)}?workspaceId=${encodeURIComponent(workspaceId)}`);
  }

  async getRunQueue(workspaceId: string, runId: string): Promise<ApiResponseWithMeta<RunQueueItem>> {
    return this.request<RunQueueItem>(`/api/v1/runs/${encodeURIComponent(runId)}/queue?workspaceId=${encodeURIComponent(workspaceId)}`);
  }

  async cancelRun(workspaceId: string, runId: string, reason?: string): Promise<ApiResponseWithMeta<TestRun>> {
    return this.request<TestRun>(`/api/v1/runs/${encodeURIComponent(runId)}/cancel`, {
      method: 'POST',
      body: { workspaceId, reason },
    });
  }

  async listRunCandidates(workspaceId: string, runId: string): Promise<ApiResponseWithMeta<{ candidates: readonly CandidateReference[] }>> {
    return this.request<{ candidates: readonly CandidateReference[] }>(
      `/api/v1/runs/${encodeURIComponent(runId)}/candidates?workspaceId=${encodeURIComponent(workspaceId)}`,
    );
  }

  async listRunArtifacts(workspaceId: string, runId: string): Promise<ApiResponseWithMeta<{ artifacts: readonly RunArtifact[] }>> {
    return this.request<{ artifacts: readonly RunArtifact[] }>(
      `/api/v1/runs/${encodeURIComponent(runId)}/artifacts?workspaceId=${encodeURIComponent(workspaceId)}`,
    );
  }

  async getArtifact(workspaceId: string, artifactId: string): Promise<ApiResponseWithMeta<RunArtifact>> {
    return this.request<RunArtifact>(`/api/v1/artifacts/${encodeURIComponent(artifactId)}?workspaceId=${encodeURIComponent(workspaceId)}`);
  }

  async getArtifactContent(workspaceId: string, artifactId: string): Promise<{
    content: Buffer;
    contentType: string;
    sha256: string;
    requestId?: string;
  }> {
    const url = `${this.baseUrl}/api/v1/artifacts/${encodeURIComponent(artifactId)}/content?workspaceId=${encodeURIComponent(workspaceId)}`;
    const token = this.resolveToken();
    const headers: Record<string, string> = {};
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const res = await fetch(url, { headers });
    const requestId = res.headers.get('x-request-id') ?? undefined;

    if (!res.ok) {
      if (res.status === 401) throw new UnauthorizedError('Authentication required.', requestId);
      if (res.status === 403) throw new ForbiddenError('Access denied to artifact content.', requestId);
      if (res.status === 404) throw new NotFoundError('Artifact not found.', requestId);
      throw new ApiError(res.status, 'ERROR', `Failed to download artifact: ${res.statusText}`, requestId);
    }

    const arrayBuffer = await res.arrayBuffer();
    return {
      content: Buffer.from(arrayBuffer),
      contentType: res.headers.get('content-type') || 'application/octet-stream',
      sha256: res.headers.get('x-artifact-sha256') || '',
      requestId,
    };
  }
}
