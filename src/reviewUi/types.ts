/**
 * Review UI types and interfaces (Build 9.2).
 *
 * Safe, read-only data models for the CrashLab browser-based review UI.
 *
 * Guarantees:
 *  - Read-only: no write operations, no file mutation, no candidate state updates.
 *  - Clear separation: automatic calculated results vs human review state vs evidence vs limitations.
 *  - Invariants: confirmedBug: false and confirmed: false across all views.
 */

import type {
  ApiSummaryResponse,
  ApiCandidateListItem,
  ApiCandidateDetailResponse,
  ApiCandidateHistoryResponse,
  ApiBaselineListItem,
  ApiBaselineDetailResponse,
  ApiRunContextResponse,
  ApiHealthResponse,
  CandidateQueryFilters,
  BaselineQueryFilters,
} from '../reviewApi/types.js';

export const REVIEW_UI_VERSION = '1.0.0';
export const DEFAULT_UI_PORT = 3211;
export const DEFAULT_UI_HOST = '127.0.0.1';
export const DEFAULT_API_URL = 'http://127.0.0.1:3210';

/** Navigation route in the UI. */
export type UiRoute =
  | { name: 'overview' }
  | { name: 'candidates'; filters?: CandidateQueryFilters }
  | { name: 'candidate-detail'; candidateId: string }
  | { name: 'candidate-history'; candidateId: string }
  | { name: 'baselines'; filters?: BaselineQueryFilters }
  | { name: 'baseline-detail'; baselineId: string }
  | { name: 'runs' }
  | { name: 'not-found'; path: string };

/** Options for launching the Review UI server. */
export interface ReviewUiServerOptions {
  host?: string;
  port?: number;
  apiUrl?: string;
  noOpen?: boolean;
}

/** Static asset server handle. */
export interface RunningReviewUiServer {
  host: string;
  port: number;
  url: string;
  apiUrl: string;
  stop: () => Promise<void>;
}

/** Client UI state model. */
export interface UiState {
  currentRoute: UiRoute;
  apiUrl: string;
  health: ApiHealthResponse | null;
  summary: ApiSummaryResponse | null;
  candidateList: {
    data: ApiCandidateListItem[];
    totalCount: number;
    filters: CandidateQueryFilters;
  } | null;
  selectedCandidate: ApiCandidateDetailResponse | null;
  selectedCandidateHistory: ApiCandidateHistoryResponse | null;
  baselineList: {
    data: ApiBaselineListItem[];
    totalCount: number;
  } | null;
  selectedBaseline: ApiBaselineDetailResponse | null;
  currentRun: ApiRunContextResponse | null;
  reproductionRun: ApiRunContextResponse | { available: false } | null;
  error: { code: string; message: string } | null;
  loading: boolean;
}
