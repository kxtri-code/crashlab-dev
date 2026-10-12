/**
 * Product API Request Dispatcher & Route Handlers — Build 11: Hosted MVP Foundation.
 *
 * Provides safe, tenant-isolated REST endpoints.
 * Operates purely over ProductService with fake identity resolution and zero browser execution.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { ProductService, TenantAccessDeniedError, EntityNotFoundError } from '../service/productService.js';
import type { ApiResponse, HealthResponse } from './types.js';

export interface RouteHandlerContext {
  readonly service: ProductService;
  readonly defaultUserId?: string;
}

function sendJson(res: ServerResponse, statusCode: number, payload: ApiResponse<unknown> | HealthResponse): void {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'Content-Type, X-User-Id, Authorization',
  });
  res.end(body);
}

function sendError(res: ServerResponse, statusCode: number, code: string, message: string, details?: unknown): void {
  sendJson(res, statusCode, {
    success: false,
    error: { code, message, details },
  });
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

function resolveActorUserId(req: IncomingMessage, context: RouteHandlerContext): string | null {
  const headerVal = req.headers['x-user-id'];
  if (typeof headerVal === 'string' && headerVal.trim() !== '') {
    return headerVal.trim();
  }
  return context.defaultUserId ?? null;
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

  // 1. Health endpoint
  if (pathname === '/health' && method === 'GET') {
    sendJson(res, 200, {
      status: 'ok',
      version: '0.1.0',
      appEnvironment: 'local',
      mode: 'hosted-mvp-foundation',
    });
    return;
  }

  const actorUserId = resolveActorUserId(req, context);
  if (!actorUserId) {
    sendError(res, 401, 'UNAUTHORIZED', 'Missing actor user identity. Provide X-User-Id header.');
    return;
  }

  try {
    // 2. Workspaces endpoints
    if (pathname === '/api/v1/workspaces') {
      if (method === 'GET') {
        const workspaces = await context.service.listWorkspacesForUser(actorUserId);
        sendJson(res, 200, { success: true, data: { workspaces } });
        return;
      }
      if (method === 'POST') {
        const body = await parseBody<{ name?: string; slug?: string }>(req);
        if (!body.name || !body.slug) {
          sendError(res, 400, 'BAD_REQUEST', 'Missing required fields "name" and "slug".');
          return;
        }
        const result = await context.service.createWorkspace({
          name: body.name,
          slug: body.slug,
          ownerUserId: actorUserId,
        });
        sendJson(res, 201, { success: true, data: result.workspace });
        return;
      }
    }

    // 3. Projects endpoints
    if (pathname === '/api/v1/projects') {
      if (method === 'GET') {
        const workspaceId = searchParams.get('workspaceId');
        if (!workspaceId) {
          sendError(res, 400, 'BAD_REQUEST', 'Missing required query parameter "workspaceId".');
          return;
        }
        const projects = await context.service.listProjects(workspaceId, actorUserId);
        sendJson(res, 200, { success: true, data: { projects } });
        return;
      }
      if (method === 'POST') {
        const body = await parseBody<{ workspaceId?: string; name?: string; description?: string }>(req);
        if (!body.workspaceId || !body.name) {
          sendError(res, 400, 'BAD_REQUEST', 'Missing required fields "workspaceId" and "name".');
          return;
        }
        const project = await context.service.createProject(
          {
            workspaceId: body.workspaceId,
            name: body.name,
            description: body.description,
          },
          actorUserId,
        );
        sendJson(res, 201, { success: true, data: project });
        return;
      }
    }

    // Project detail endpoint: /api/v1/projects/:projectId
    const projectDetailMatch = pathname.match(/^\/api\/v1\/projects\/([^/]+)$/);
    if (projectDetailMatch && method === 'GET') {
      const projectId = projectDetailMatch[1]!;
      const workspaceId = searchParams.get('workspaceId');
      if (!workspaceId) {
        sendError(res, 400, 'BAD_REQUEST', 'Missing required query parameter "workspaceId".');
        return;
      }
      const project = await context.service.getProject(workspaceId, projectId, actorUserId);
      sendJson(res, 200, { success: true, data: project });
      return;
    }

    // Project runs endpoint: /api/v1/projects/:projectId/runs
    const projectRunsMatch = pathname.match(/^\/api\/v1\/projects\/([^/]+)\/runs$/);
    if (projectRunsMatch && method === 'GET') {
      const projectId = projectRunsMatch[1]!;
      const workspaceId = searchParams.get('workspaceId');
      if (!workspaceId) {
        sendError(res, 400, 'BAD_REQUEST', 'Missing required query parameter "workspaceId".');
        return;
      }
      const runs = await context.service.listRunsByProject(workspaceId, projectId, actorUserId);
      sendJson(res, 200, { success: true, data: { runs } });
      return;
    }

    // Run detail endpoint: /api/v1/runs/:runId
    const runDetailMatch = pathname.match(/^\/api\/v1\/runs\/([^/]+)$/);
    if (runDetailMatch && method === 'GET') {
      const runId = runDetailMatch[1]!;
      const workspaceId = searchParams.get('workspaceId');
      if (!workspaceId) {
        sendError(res, 400, 'BAD_REQUEST', 'Missing required query parameter "workspaceId".');
        return;
      }
      const run = await context.service.getRun(workspaceId, runId, actorUserId);
      sendJson(res, 200, { success: true, data: run });
      return;
    }

    // Run artifacts endpoint: /api/v1/runs/:runId/artifacts
    const runArtifactsMatch = pathname.match(/^\/api\/v1\/runs\/([^/]+)\/artifacts$/);
    if (runArtifactsMatch && method === 'GET') {
      const runId = runArtifactsMatch[1]!;
      const workspaceId = searchParams.get('workspaceId');
      if (!workspaceId) {
        sendError(res, 400, 'BAD_REQUEST', 'Missing required query parameter "workspaceId".');
        return;
      }
      const artifacts = await context.service.listArtifacts(workspaceId, runId, actorUserId);
      sendJson(res, 200, { success: true, data: { artifacts } });
      return;
    }

    // Unknown endpoint
    sendError(res, 404, 'NOT_FOUND', `Route not found: ${method} ${pathname}`);
  } catch (err) {
    if (err instanceof TenantAccessDeniedError) {
      sendError(res, 403, 'FORBIDDEN', err.message);
      return;
    }
    if (err instanceof EntityNotFoundError) {
      sendError(res, 404, 'NOT_FOUND', err.message);
      return;
    }
    sendError(res, 500, 'INTERNAL_SERVER_ERROR', (err as Error).message);
  }
}
