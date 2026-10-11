/**
 * Read-Only Review API HTTP Client Adapter (Build 9.2).
 *
 * Consumes the Build 9.1 Read-Only Review API.
 *
 * Invariant:
 *  - Enforces GET / HEAD requests only.
 *  - Refuses and throws on any mutation attempts (POST, PUT, PATCH, DELETE).
 *  - Does not read files directly from the browser filesystem.
 */

import type {
  ApiSummaryResponse,
  ApiCandidatesListResponse,
  ApiCandidateDetailResponse,
  ApiCandidateHistoryResponse,
  ApiBaselinesListResponse,
  ApiBaselineDetailResponse,
  ApiRunContextResponse,
  ApiHealthResponse,
  CandidateQueryFilters,
  BaselineQueryFilters,
} from '../reviewApi/types.js';

export class ReadOnlyApiError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: Record<string, unknown>;

  constructor(statusCode: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ReadOnlyApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export class ReviewApiClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string = 'http://127.0.0.1:3210') {
    // Strip trailing slashes
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  /**
   * Internal fetch wrapper enforcing read-only constraint.
   */
  public async request<T>(
    endpoint: string,
    options: { method?: 'GET' | 'HEAD'; query?: Record<string, string | number | boolean | undefined> } = {},
  ): Promise<T> {
    const method = (options.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      throw new Error(
        `CrashLab Review UI is strictly read-only. Mutation method "${method}" is prohibited.`,
      );
    }

    const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    const url = new URL(`${this.baseUrl}${cleanEndpoint}`);

    if (options.query) {
      for (const [key, val] of Object.entries(options.query)) {
        if (val !== undefined && val !== null && val !== '') {
          url.searchParams.set(key, String(val));
        }
      }
    }

    const res = await fetch(url.toString(), {
      method,
      headers: {
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      let code = 'http-error';
      let message = `Request failed with status ${res.status}`;
      let details: Record<string, unknown> | undefined;

      try {
        const body = (await res.json()) as { error?: { code?: string; message?: string; details?: Record<string, unknown> } };
        if (body.error) {
          code = body.error.code ?? code;
          message = body.error.message ?? message;
          details = body.error.details;
        }
      } catch {
        // If not JSON, use default error message
      }

      throw new ReadOnlyApiError(res.status, code, message, details);
    }

    if (method === 'HEAD') {
      return {} as T;
    }

    return (await res.json()) as T;
  }

  /** GET /health */
  public async getHealth(): Promise<ApiHealthResponse> {
    return this.request<ApiHealthResponse>('/health');
  }

  /** GET /api/summary */
  public async getSummary(): Promise<ApiSummaryResponse> {
    return this.request<ApiSummaryResponse>('/api/summary');
  }

  /** GET /api/candidates */
  public async getCandidates(filters: CandidateQueryFilters = {}): Promise<ApiCandidatesListResponse> {
    const query: Record<string, string | number | boolean | undefined> = {
      classification: filters.classification,
      reviewStatus: filters.reviewStatus,
      ruleId: filters.ruleId,
      kind: filters.kind,
      reproduced: filters.reproduced,
      environment: filters.environment,
      requiresInvestigation: filters.requiresInvestigation,
      baselinePresent: filters.baselinePresent,
      currentPresent: filters.currentPresent,
      limit: filters.limit,
      offset: filters.offset,
    };
    return this.request<ApiCandidatesListResponse>('/api/candidates', { query });
  }

  /** GET /api/candidates/:id */
  public async getCandidateDetail(candidateId: string): Promise<ApiCandidateDetailResponse> {
    return this.request<ApiCandidateDetailResponse>(`/api/candidates/${encodeURIComponent(candidateId)}`);
  }

  /** GET /api/candidates/:id/history */
  public async getCandidateHistory(candidateId: string): Promise<ApiCandidateHistoryResponse> {
    return this.request<ApiCandidateHistoryResponse>(`/api/candidates/${encodeURIComponent(candidateId)}/history`);
  }

  /** GET /api/baselines */
  public async getBaselines(filters: BaselineQueryFilters = {}): Promise<ApiBaselinesListResponse> {
    const query: Record<string, string | number | boolean | undefined> = {
      origin: filters.origin,
      journey: filters.journey,
      build: filters.build,
      status: filters.status,
      coverage: filters.coverage,
      limit: filters.limit,
      offset: filters.offset,
    };
    return this.request<ApiBaselinesListResponse>('/api/baselines', { query });
  }

  /** GET /api/baselines/:id */
  public async getBaselineDetail(baselineId: string): Promise<ApiBaselineDetailResponse> {
    return this.request<ApiBaselineDetailResponse>(`/api/baselines/${encodeURIComponent(baselineId)}`);
  }

  /** GET /api/runs/current */
  public async getCurrentRun(): Promise<ApiRunContextResponse> {
    return this.request<ApiRunContextResponse>('/api/runs/current');
  }

  /** GET /api/runs/reproduction */
  public async getReproductionRun(): Promise<ApiRunContextResponse | { available: false }> {
    return this.request<ApiRunContextResponse | { available: false }>('/api/runs/reproduction');
  }
}
