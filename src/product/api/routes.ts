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
import type { ArtifactType } from '../types/artifact.js';
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
    // 2.5 Current authenticated user endpoint: GET /api/v1/me
    if (pathname === '/api/v1/me' && method === 'GET') {
      const user = await context.service.getUser(actorUserId);
      const safeUser = user ?? {
        id: actorUserId,
        schemaVersion: '1.0',
        name: actorUserId,
        email: `${actorUserId}@crashlab.local`,
        status: 'active' as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      sendJson(res, 200, { success: true, data: { user: safeUser }, requestId }, requestId);
      return;
    }

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

    // Workspace detail endpoint: /api/v1/workspaces/:workspaceId
    const workspaceDetailMatch = pathname.match(/^\/api\/v1\/workspaces\/([^/]+)$/);
    if (workspaceDetailMatch && method === 'GET') {
      const workspaceId = workspaceDetailMatch[1]!;
      targetedWorkspaceId = workspaceId;
      const workspace = await context.service.getWorkspace(workspaceId, actorUserId);
      sendJson(res, 200, { success: true, data: { workspace }, requestId }, requestId);
      return;
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

    // Project targets endpoint: /api/v1/projects/:projectId/targets or /api/v1/targets
    const projectTargetsMatch = pathname.match(/^\/api\/v1\/projects\/([^/]+)\/targets$/);
    if ((pathname === '/api/v1/targets' || projectTargetsMatch) && method === 'GET') {
      const workspaceId = searchParams.get('workspaceId');
      const projectId = projectTargetsMatch ? projectTargetsMatch[1]! : searchParams.get('projectId');
      if (!workspaceId) {
        sendError(res, 400, 'BAD_REQUEST', 'Missing required query parameter "workspaceId".', requestId);
        return;
      }
      if (!projectId) {
        sendError(res, 400, 'BAD_REQUEST', 'Missing required query parameter "projectId".', requestId);
        return;
      }
      targetedWorkspaceId = workspaceId;
      const targets = await context.service.listTargets(workspaceId, projectId, actorUserId);
      sendJson(res, 200, { success: true, data: { targets }, requestId }, requestId);
      return;
    }

    // Target journeys endpoint: /api/v1/targets/:targetId/journeys or /api/v1/journeys
    const targetJourneysMatch = pathname.match(/^\/api\/v1\/targets\/([^/]+)\/journeys$/);
    if ((pathname === '/api/v1/journeys' || targetJourneysMatch) && method === 'GET') {
      const workspaceId = searchParams.get('workspaceId');
      const targetId = targetJourneysMatch ? targetJourneysMatch[1]! : searchParams.get('targetId');
      if (!workspaceId) {
        sendError(res, 400, 'BAD_REQUEST', 'Missing required query parameter "workspaceId".', requestId);
        return;
      }
      if (!targetId) {
        sendError(res, 400, 'BAD_REQUEST', 'Missing required query parameter "targetId".', requestId);
        return;
      }
      targetedWorkspaceId = workspaceId;
      const journeys = await context.service.listJourneys(workspaceId, targetId, actorUserId);
      sendJson(res, 200, { success: true, data: { journeys }, requestId }, requestId);
      return;
    }

    // Project candidates endpoint: /api/v1/projects/:projectId/candidates
    const projectCandidatesMatch = pathname.match(/^\/api\/v1\/projects\/([^/]+)\/candidates$/);
    if (projectCandidatesMatch && method === 'GET') {
      const projectId = projectCandidatesMatch[1]!;
      const workspaceId = searchParams.get('workspaceId');
      if (!workspaceId) {
        sendError(res, 400, 'BAD_REQUEST', 'Missing required query parameter "workspaceId".', requestId);
        return;
      }
      targetedWorkspaceId = workspaceId;
      const candidates = await context.service.listCandidates(workspaceId, projectId, actorUserId);
      sendJson(res, 200, { success: true, data: { candidates }, requestId }, requestId);
      return;
    }

    // Run candidates endpoint: /api/v1/runs/:runId/candidates
    const runCandidatesMatch = pathname.match(/^\/api\/v1\/runs\/([^/]+)\/candidates$/);
    if (runCandidatesMatch && method === 'GET') {
      const runId = runCandidatesMatch[1]!;
      const workspaceId = searchParams.get('workspaceId');
      if (!workspaceId) {
        sendError(res, 400, 'BAD_REQUEST', 'Missing required query parameter "workspaceId".', requestId);
        return;
      }
      targetedWorkspaceId = workspaceId;
      const candidates = await context.service.listCandidatesByRun(workspaceId, runId, actorUserId);
      sendJson(res, 200, { success: true, data: { candidates }, requestId }, requestId);
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

    // Create/enqueue run endpoint: POST /api/v1/runs
    if (pathname === '/api/v1/runs' && method === 'POST') {
      const body = await parseBody<{
        workspaceId?: string;
        projectId?: string;
        targetEnvironmentId?: string;
        journeyId?: string;
        maxAttempts?: number;
      }>(req);

      if (!body.workspaceId || !body.projectId || !body.targetEnvironmentId || !body.journeyId) {
        sendError(
          res,
          400,
          'BAD_REQUEST',
          'Missing required fields "workspaceId", "projectId", "targetEnvironmentId", and "journeyId".',
          requestId,
        );
        return;
      }

      targetedWorkspaceId = body.workspaceId;
      const result = await context.service.enqueueRun(
        {
          workspaceId: body.workspaceId,
          projectId: body.projectId,
          targetEnvironmentId: body.targetEnvironmentId,
          journeyId: body.journeyId,
          maxAttempts: body.maxAttempts,
          requestId,
        },
        actorUserId,
      );

      sendJson(res, 201, { success: true, data: result.run, requestId }, requestId);
      return;
    }

    // Cancel run endpoint: POST /api/v1/runs/:runId/cancel
    const runCancelMatch = pathname.match(/^\/api\/v1\/runs\/([^/]+)\/cancel$/);
    if (runCancelMatch && method === 'POST') {
      const runId = runCancelMatch[1]!;
      const body = await parseBody<{ workspaceId?: string; reason?: string }>(req);
      const workspaceId = body.workspaceId ?? searchParams.get('workspaceId');
      if (!workspaceId) {
        sendError(res, 400, 'BAD_REQUEST', 'Missing required field "workspaceId".', requestId);
        return;
      }
      targetedWorkspaceId = workspaceId;
      const cancelledRun = await context.service.cancelRun(
        workspaceId,
        runId,
        actorUserId,
        body.reason,
      );
      sendJson(res, 200, { success: true, data: cancelledRun, requestId }, requestId);
      return;
    }

    // Explicit retry run endpoint: POST /api/v1/runs/:runId/retry
    const runRetryMatch = pathname.match(/^\/api\/v1\/runs\/([^/]+)\/retry$/);
    if (runRetryMatch && method === 'POST') {
      const runId = runRetryMatch[1]!;
      const body = await parseBody<{ workspaceId?: string }>(req);
      const workspaceId = body.workspaceId ?? searchParams.get('workspaceId');
      if (!workspaceId) {
        sendError(res, 400, 'BAD_REQUEST', 'Missing required field "workspaceId".', requestId);
        return;
      }
      targetedWorkspaceId = workspaceId;
      const retried = await context.service.retryRun(workspaceId, runId, actorUserId);
      sendJson(res, 200, { success: true, data: retried.run, requestId }, requestId);
      return;
    }

    // Queue status detail endpoint: GET /api/v1/runs/:runId/queue
    const runQueueMatch = pathname.match(/^\/api\/v1\/runs\/([^/]+)\/queue$/);
    if (runQueueMatch && method === 'GET') {
      const runId = runQueueMatch[1]!;
      const workspaceId = searchParams.get('workspaceId');
      if (!workspaceId) {
        sendError(res, 400, 'BAD_REQUEST', 'Missing required query parameter "workspaceId".', requestId);
        return;
      }
      targetedWorkspaceId = workspaceId;
      const queueItem = await context.service.getRunQueueItem(workspaceId, runId, actorUserId);
      if (!queueItem) {
        sendError(res, 404, 'NOT_FOUND', `Queue item for run "${runId}" not found.`, requestId);
        return;
      }
      sendJson(res, 200, { success: true, data: queueItem, requestId }, requestId);
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

    // Upload/store artifact endpoint: POST /api/v1/runs/:runId/artifacts
    const runArtifactsMatch = pathname.match(/^\/api\/v1\/runs\/([^/]+)\/artifacts$/);
    if (runArtifactsMatch && method === 'POST') {
      const runId = runArtifactsMatch[1]!;
      const body = await parseBody<{
        workspaceId?: string;
        type: ArtifactType;
        content: string | Record<string, unknown>;
        contentType?: string;
        encoding?: 'utf8' | 'base64';
      }>(req);

      const workspaceId = body.workspaceId ?? searchParams.get('workspaceId');
      if (!workspaceId) {
        sendError(res, 400, 'BAD_REQUEST', 'Missing required field "workspaceId".', requestId);
        return;
      }
      if (!body.type) {
        sendError(res, 400, 'BAD_REQUEST', 'Missing required field "type".', requestId);
        return;
      }
      if (body.content === undefined || body.content === null) {
        sendError(res, 400, 'BAD_REQUEST', 'Missing required field "content".', requestId);
        return;
      }

      targetedWorkspaceId = workspaceId;

      let buffer: Buffer;
      if (body.encoding === 'base64' && typeof body.content === 'string') {
        buffer = Buffer.from(body.content, 'base64');
      } else if (typeof body.content === 'object') {
        buffer = Buffer.from(JSON.stringify(body.content, null, 2), 'utf8');
      } else {
        buffer = Buffer.from(String(body.content), 'utf8');
      }

      const stored = await context.service.storeArtifact(
        {
          workspaceId,
          runId,
          type: body.type,
          content: buffer,
          contentType: body.contentType ?? (typeof body.content === 'object' ? 'application/json' : 'text/plain'),
        },
        actorUserId,
      );

      sendJson(res, 201, { success: true, data: stored, requestId }, requestId);
      return;
    }

    // List run artifacts endpoint: GET /api/v1/runs/:runId/artifacts
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

    // Artifact detail endpoint: GET /api/v1/artifacts/:artifactId
    const artifactDetailMatch = pathname.match(/^\/api\/v1\/artifacts\/([^/]+)$/);
    if (artifactDetailMatch && method === 'GET') {
      const artifactId = artifactDetailMatch[1]!;
      const workspaceId = searchParams.get('workspaceId');
      if (!workspaceId) {
        sendError(res, 400, 'BAD_REQUEST', 'Missing required query parameter "workspaceId".', requestId);
        return;
      }
      targetedWorkspaceId = workspaceId;
      const artifact = await context.service.getArtifact(workspaceId, artifactId, actorUserId);
      sendJson(res, 200, { success: true, data: artifact, requestId }, requestId);
      return;
    }

    // Artifact download endpoint: GET /api/v1/artifacts/:artifactId/content
    const artifactContentMatch = pathname.match(/^\/api\/v1\/artifacts\/([^/]+)\/content$/);
    if (artifactContentMatch && method === 'GET') {
      const artifactId = artifactContentMatch[1]!;
      const workspaceId = searchParams.get('workspaceId');
      if (!workspaceId) {
        sendError(res, 400, 'BAD_REQUEST', 'Missing required query parameter "workspaceId".', requestId);
        return;
      }
      targetedWorkspaceId = workspaceId;
      const { artifact, payload } = await context.service.getArtifactContent(workspaceId, artifactId, actorUserId);

      res.writeHead(200, {
        'content-type': artifact.contentType,
        'content-length': String(payload.content.length),
        'etag': `"${artifact.sha256}"`,
        'x-artifact-type': artifact.type,
        'x-artifact-sha256': artifact.sha256,
        'x-request-id': requestId,
        'cache-control': 'private, no-transform',
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, OPTIONS',
        'access-control-allow-headers': 'Content-Type, X-User-Id, Authorization',
        'access-control-expose-headers': 'Content-Type, Content-Length, ETag, X-Request-Id, X-Artifact-Sha256, X-Artifact-Type',
      });
      res.end(payload.content);
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
