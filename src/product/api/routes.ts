/**
 * Product API Request Dispatcher & Route Handlers — Build 12B.1: Real Authentication & Storage.
 *
 * Provides safe, tenant-isolated REST endpoints with:
 * - Real authentication boundary (Bearer tokens / dev fallback)
 * - Request ID tracking and response propagation (X-Request-Id)
 * - Workspace isolation enforcement
 * - Security audit logging on access denial
 * - Zero browser execution
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { ProductService, TenantAccessDeniedError, EntityNotFoundError } from '../service/productService.js';
import type { ApiResponse, HealthResponse } from './types.js';
import type { AuthConfig } from '../auth/identity.js';
import { loadAuthConfigFromEnv } from '../auth/identity.js';
import { authenticateRequest } from '../auth/middleware.js';
import type { IdGenerator } from '../util/id.js';

export interface RouteHandlerContext {
  readonly service: ProductService;
  readonly authConfig?: AuthConfig;
  readonly defaultUserId?: string;
  readonly idGenerator?: IdGenerator;
}

function sendJson(
  res: ServerResponse,
  statusCode: number,
  payload: ApiResponse<unknown> | HealthResponse,
  requestId?: string,
): void {
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'Content-Type, X-User-Id, Authorization',
  };
  if (requestId) {
    headers['x-request-id'] = requestId;
  }
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, headers);
  res.end(body);
}

function sendError(
  res: ServerResponse,
  statusCode: number,
  code: string,
  message: string,
  requestId?: string,
  details?: unknown,
): void {
  sendJson(
    res,
    statusCode,
    {
      success: false,
      error: { code, message, details },
      requestId,
    },
    requestId,
  );
}

async function parseBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw || raw.trim() === '') {
        resolve({} as T);
        return;
      }
      try {
        resolve(JSON.parse(raw) as T);
      } catch (err) {
        reject(new Error(`Malformed JSON body: ${(err as Error).message}`));
      }
    });
    req.on('error', reject);
  });
}

export async function handleProductApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  context: RouteHandlerContext,
): Promise<void> {
  const method = req.method?.toUpperCase() ?? 'GET';
  const urlObj = new URL(req.url ?? '/', 'http://127.0.0.1');
  const pathname = urlObj.pathname;
  const searchParams = urlObj.searchParams;

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'Content-Type, X-User-Id, Authorization',
    });
    res.end();
    return;
  }

  const fallbackRequestId =
    context.idGenerator?.generateId('req') ?? `req_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

  // 1. Health endpoint (public, zero secrets)
  if (pathname === '/health' && method === 'GET') {
    sendJson(
      res,
      200,
      {
        status: 'ok',
        version: '0.1.0',
        appEnvironment: 'local',
        mode: 'hosted-mvp-foundation',
        requestId: fallbackRequestId,
      },
      fallbackRequestId,
    );
    return;
  }

  // 2. Authentication Enforcement
  const authConfig = context.authConfig ?? loadAuthConfigFromEnv();
  const authResult = authenticateRequest(req, {
    authConfig,
    defaultUserId: context.defaultUserId,
    idGenerator: context.idGenerator,
  });

  if (!authResult.success || !authResult.identity) {
    sendError(
      res,
      authResult.statusCode ?? 401,
      authResult.error?.code ?? 'UNAUTHORIZED',
      authResult.error?.message ?? 'Authentication required.',
      authResult.requestId,
    );
    return;
  }

  const identity = authResult.identity;
  const actorUserId = identity.userId;
  const requestId = identity.requestId;

  let targetedWorkspaceId: string | undefined;

  try {
    // 3. Workspaces endpoints
    if (pathname === '/api/v1/workspaces') {
      if (method === 'GET') {
        const workspaces = await context.service.listWorkspacesForUser(actorUserId);
        sendJson(res, 200, { success: true, data: { workspaces }, requestId }, requestId);
        return;
      }
      if (method === 'POST') {
        const body = await parseBody<{ name?: string; slug?: string }>(req);
        if (!body.name || !body.slug) {
          sendError(res, 400, 'BAD_REQUEST', 'Missing required fields "name" and "slug".', requestId);
          return;
        }
        const result = await context.service.createWorkspace({
          name: body.name,
          slug: body.slug,
          ownerUserId: actorUserId,
        });
        sendJson(res, 201, { success: true, data: result.workspace, requestId }, requestId);
        return;
      }
    }

    // 4. Projects endpoints
    if (pathname === '/api/v1/projects') {
      if (method === 'GET') {
        const workspaceId = searchParams.get('workspaceId');
        if (!workspaceId) {
          sendError(res, 400, 'BAD_REQUEST', 'Missing required query parameter "workspaceId".', requestId);
          return;
        }
        targetedWorkspaceId = workspaceId;
        const projects = await context.service.listProjects(workspaceId, actorUserId);
        sendJson(res, 200, { success: true, data: { projects }, requestId }, requestId);
        return;
      }
      if (method === 'POST') {
        const body = await parseBody<{ workspaceId?: string; name?: string; description?: string }>(req);
        if (!body.workspaceId || !body.name) {
          sendError(res, 400, 'BAD_REQUEST', 'Missing required fields "workspaceId" and "name".', requestId);
          return;
        }
        targetedWorkspaceId = body.workspaceId;
        const project = await context.service.createProject(
          {
            workspaceId: body.workspaceId,
            name: body.name,
            description: body.description,
          },
          actorUserId,
        );
        sendJson(res, 201, { success: true, data: project, requestId }, requestId);
        return;
      }
    }

    // Project detail endpoint: /api/v1/projects/:projectId
    const projectDetailMatch = pathname.match(/^\/api\/v1\/projects\/([^/]+)$/);
    if (projectDetailMatch && method === 'GET') {
      const projectId = projectDetailMatch[1]!;
      const workspaceId = searchParams.get('workspaceId');
      if (!workspaceId) {
        sendError(res, 400, 'BAD_REQUEST', 'Missing required query parameter "workspaceId".', requestId);
        return;
      }
      targetedWorkspaceId = workspaceId;
      const project = await context.service.getProject(workspaceId, projectId, actorUserId);
      sendJson(res, 200, { success: true, data: project, requestId }, requestId);
      return;
    }

    // Project runs endpoint: /api/v1/projects/:projectId/runs
    const projectRunsMatch = pathname.match(/^\/api\/v1\/projects\/([^/]+)\/runs$/);
    if (projectRunsMatch && method === 'GET') {
      const projectId = projectRunsMatch[1]!;
      const workspaceId = searchParams.get('workspaceId');
      if (!workspaceId) {
        sendError(res, 400, 'BAD_REQUEST', 'Missing required query parameter "workspaceId".', requestId);
        return;
      }
      targetedWorkspaceId = workspaceId;
      const runs = await context.service.listRunsByProject(workspaceId, projectId, actorUserId);
      sendJson(res, 200, { success: true, data: { runs }, requestId }, requestId);
      return;
    }

    // Run detail endpoint: /api/v1/runs/:runId
    const runDetailMatch = pathname.match(/^\/api\/v1\/runs\/([^/]+)$/);
    if (runDetailMatch && method === 'GET') {
      const runId = runDetailMatch[1]!;
      const workspaceId = searchParams.get('workspaceId');
      if (!workspaceId) {
        sendError(res, 400, 'BAD_REQUEST', 'Missing required query parameter "workspaceId".', requestId);
        return;
      }
      targetedWorkspaceId = workspaceId;
      const run = await context.service.getRun(workspaceId, runId, actorUserId);
      sendJson(res, 200, { success: true, data: run, requestId }, requestId);
      return;
    }

    // Run artifacts endpoint: /api/v1/runs/:runId/artifacts
    const runArtifactsMatch = pathname.match(/^\/api\/v1\/runs\/([^/]+)\/artifacts$/);
    if (runArtifactsMatch && method === 'GET') {
      const runId = runArtifactsMatch[1]!;
      const workspaceId = searchParams.get('workspaceId');
      if (!workspaceId) {
        sendError(res, 400, 'BAD_REQUEST', 'Missing required query parameter "workspaceId".', requestId);
        return;
      }
      targetedWorkspaceId = workspaceId;
      const artifacts = await context.service.listArtifacts(workspaceId, runId, actorUserId);
      sendJson(res, 200, { success: true, data: { artifacts }, requestId }, requestId);
      return;
    }

    // Unknown endpoint
    sendError(res, 404, 'NOT_FOUND', `Route not found: ${method} ${pathname}`, requestId);
  } catch (err) {
    if (err instanceof TenantAccessDeniedError) {
      if (targetedWorkspaceId) {
        try {
          await context.service.recordSecurityEvent(
            targetedWorkspaceId,
            actorUserId,
            'workspace.access_denied',
            'workspace',
            targetedWorkspaceId,
            { reason: err.message, path: pathname, requestId },
          );
        } catch {
          // Do not fail the request if audit recording fails
        }
      }
      sendError(res, 403, 'FORBIDDEN', err.message, requestId);
      return;
    }
    if (err instanceof EntityNotFoundError) {
      sendError(res, 404, 'NOT_FOUND', err.message, requestId);
      return;
    }
    sendError(res, 500, 'INTERNAL_SERVER_ERROR', (err as Error).message, requestId);
  }
}
