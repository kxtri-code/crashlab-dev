/**
 * Read-Only Review API HTTP Server Adapter (Build 9.1).
 *
 * Exposes CrashLab candidate defect reports, review-state history, and baseline
 * registries via a safe, local, deterministic HTTP API.
 *
 * Non-negotiable Guarantees:
 *  - Read-only: accepts GET and HEAD only; mutations return 405 Method Not Allowed.
 *  - Strict local binding (127.0.0.1 by default).
 *  - No Playwright, no database, no external network calls.
 *  - Immutability: leaves all underlying report and baseline files byte-identical.
 *  - Determinism: byte-identical responses for identical requests and input data.
 *  - `confirmedBug: false` and `confirmed: false` across all responses.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import type { ReviewApiData } from './queries.js';
import {
  querySummary,
  queryCandidates,
  queryCandidateDetail,
  queryCandidateHistory,
  queryBaselines,
  queryBaselineDetail,
  queryCurrentRunContext,
  queryReproductionRunContext,
} from './queries.js';
import {
  validateCandidateIdRoute,
  validateBaselineIdRoute,
  validateCandidateFilters,
  validateBaselineFilters,
  validateHost,
  validatePort,
} from './validator.js';
import { formatApiError, invalidPathError, methodNotAllowedError, notFoundError } from './errors.js';
import { canonicalJsonStringify } from './serialization.js';
import { REVIEW_API_SCHEMA_VERSION, type ApiHealthResponse, type ReviewApiServerOptions } from './types.js';
import { loadReviewApiData } from './loader.js';

export interface RunningReviewApiServer {
  server: Server;
  host: string;
  port: number;
  url: string;
  data: ReviewApiData;
  start: () => Promise<RunningReviewApiServer>;
  stop: () => Promise<void>;
}

/** Health response object. */
const HEALTH_RESPONSE: ApiHealthResponse = {
  ok: true,
  service: 'crashlab-review-api',
  readOnly: true,
  schemaVersion: REVIEW_API_SCHEMA_VERSION,
};

/**
 * Handle one incoming HTTP request.
 */
export async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  data: ReviewApiData,
): Promise<void> {
  const method = req.method?.toUpperCase();

  // Enforce read-only constraint
  if (method !== 'GET' && method !== 'HEAD') {
    const error = methodNotAllowedError(method);
    const { statusCode, response } = formatApiError(error);
    const body = canonicalJsonStringify(response);
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      Allow: 'GET, HEAD',
    });
    res.end(body);
    return;
  }

  // Parse and validate URL
  const rawUrl = req.url ?? '/';
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl, 'http://127.0.0.1');
  } catch {
    const { statusCode, response } = formatApiError(invalidPathError('Malformed request URL.'));
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(method === 'HEAD' ? undefined : canonicalJsonStringify(response));
    return;
  }

  const pathname = parsedUrl.pathname;

  // Path safety: reject traversal or null bytes
  if (pathname.includes('..') || /[\x00-\x1f\x7f]/.test(pathname)) {
    const { statusCode, response } = formatApiError(
      invalidPathError('Path contains invalid characters or traversal sequences.'),
    );
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(method === 'HEAD' ? undefined : canonicalJsonStringify(response));
    return;
  }

  try {
    let result: unknown;

    // Route: /health
    if (pathname === '/health') {
      result = HEALTH_RESPONSE;
    }
    // Route: /api/summary
    else if (pathname === '/api/summary') {
      result = querySummary(data);
    }
    // Route: /api/candidates
    else if (pathname === '/api/candidates') {
      const filters = validateCandidateFilters(parsedUrl.searchParams);
      result = queryCandidates(data, filters);
    }
    // Route: /api/candidates/:candidateId and /api/candidates/:candidateId/history
    else if (pathname.startsWith('/api/candidates/')) {
      const rest = pathname.slice('/api/candidates/'.length);
      const segments = rest.split('/').filter(Boolean);

      if (segments.length === 1 && segments[0]) {
        const candidateId = validateCandidateIdRoute(segments[0]);
        result = queryCandidateDetail(data, candidateId);
      } else if (segments.length === 2 && segments[0] && segments[1] === 'history') {
        const candidateId = validateCandidateIdRoute(segments[0]);
        result = queryCandidateHistory(data, candidateId);
      } else {
        throw notFoundError(`Route not found: ${pathname}`);
      }
    }
    // Route: /api/baselines
    else if (pathname === '/api/baselines') {
      const filters = validateBaselineFilters(parsedUrl.searchParams);
      result = queryBaselines(data, filters);
    }
    // Route: /api/baselines/:baselineId
    else if (pathname.startsWith('/api/baselines/')) {
      const rest = pathname.slice('/api/baselines/'.length);
      const segments = rest.split('/').filter(Boolean);

      if (segments.length === 1 && segments[0]) {
        const baselineId = validateBaselineIdRoute(segments[0]);
        result = queryBaselineDetail(data, baselineId);
      } else {
        throw notFoundError(`Route not found: ${pathname}`);
      }
    }
    // Route: /api/runs/current
    else if (pathname === '/api/runs/current') {
      result = queryCurrentRunContext(data);
    }
    // Route: /api/runs/reproduction
    else if (pathname === '/api/runs/reproduction') {
      result = queryReproductionRunContext(data);
    }
    // Not found
    else {
      throw notFoundError(`Route not found: ${pathname}`);
    }

    const body = canonicalJsonStringify(result);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(method === 'HEAD' ? undefined : body);
  } catch (error) {
    const { statusCode, response } = formatApiError(error);
    const body = canonicalJsonStringify(response);
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(method === 'HEAD' ? undefined : body);
  }
}

/**
 * Create and configure the Review API server instance.
 */
export async function createReviewApiServer(
  options: ReviewApiServerOptions,
  cwd: string = process.cwd(),
): Promise<RunningReviewApiServer> {
  const host = validateHost(options.host ?? '127.0.0.1');
  const port = options.port !== undefined ? validatePort(options.port) : 3210;

  // Load all required artifacts safely before listening
  const data = await loadReviewApiData(options.paths, cwd);

  const server = createServer((req, res) => {
    void handleRequest(req, res, data);
  });

  const apiServer: RunningReviewApiServer = {
    server,
    host,
    port,
    url: `http://${host}:${port}`,
    data,
    start: async () => {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          const address = server.address();
          if (address && typeof address === 'object') {
            apiServer.port = address.port;
            apiServer.url = `http://${host}:${address.port}`;
          }
          resolve();
        });
      });
      return apiServer;
    },
    stop: async () => {
      await new Promise<void>((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };

  return apiServer;
}
