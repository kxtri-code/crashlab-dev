/**
 * CrashLab Worker Internal Health & Readiness Server — Build 12D.2B.
 *
 * Provides minimal, internal HTTP endpoints (/health and /readiness) for container
 * orchestration (Docker health checks, Kubernetes probes, ECS).
 *
 * Security Invariants:
 * - Zero credentials, database URLs, service keys, JWTs, cookies, or secrets exposed.
 * - Non-root internal port (default 3230).
 * - Read-only liveness and connectivity probes.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';

export interface WorkerHealthProvider {
  readonly workerId: string;
  readonly maxConcurrency: number;
  getActiveJobsCount(): number;
  getUptimeSeconds(): number;
  checkQueueHealth(): Promise<boolean>;
  checkStorageHealth(): Promise<boolean>;
}

export class WorkerHealthServer {
  private server: Server | null = null;
  private listeningPort: number | null = null;

  constructor(
    private readonly provider: WorkerHealthProvider,
    private readonly port: number,
  ) {}

  get portNumber(): number | null {
    return this.listeningPort;
  }

  get isRunning(): boolean {
    return this.server !== null;
  }

  async start(): Promise<number> {
    if (this.server) {
      return this.listeningPort!;
    }

    return new Promise((resolve, reject) => {
      const srv = createServer((req: IncomingMessage, res: ServerResponse) => {
        this.handleRequest(req, res).catch(() => {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' });
            res.end(JSON.stringify({ status: 'error', message: 'Internal health check failure' }));
          }
        });
      });

      srv.on('error', (err) => {
        reject(err);
      });

      srv.listen(this.port, '0.0.0.0', () => {
        const addr = srv.address();
        const actualPort = typeof addr === 'object' && addr ? addr.port : this.port;
        this.listeningPort = actualPort;
        this.server = srv;
        resolve(actualPort);
      });
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

    if (req.method !== 'GET') {
      res.writeHead(405);
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    if (pathname === '/health') {
      const body = {
        status: 'ok',
        workerId: this.provider.workerId,
        uptimeSeconds: Math.round(this.provider.getUptimeSeconds() * 100) / 100,
        activeJobs: this.provider.getActiveJobsCount(),
        maxConcurrency: this.provider.maxConcurrency,
      };
      res.writeHead(200);
      res.end(JSON.stringify(body, null, 2));
      return;
    }

    if (pathname === '/readiness') {
      let queueOk = false;
      let storageOk = false;

      try {
        queueOk = await this.provider.checkQueueHealth();
      } catch {
        queueOk = false;
      }

      try {
        storageOk = await this.provider.checkStorageHealth();
      } catch {
        storageOk = false;
      }

      const isReady = queueOk && storageOk;
      const statusCode = isReady ? 200 : 503;

      const body = {
        status: isReady ? 'ready' : 'degraded',
        workerId: this.provider.workerId,
        activeJobs: this.provider.getActiveJobsCount(),
        maxConcurrency: this.provider.maxConcurrency,
        checks: {
          queue: queueOk ? 'connected' : 'disconnected',
          storage: storageOk ? 'connected' : 'degraded',
        },
      };

      res.writeHead(statusCode);
      res.end(JSON.stringify(body, null, 2));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  async close(): Promise<void> {
    if (!this.server) {
      return;
    }

    const srv = this.server;
    this.server = null;
    this.listeningPort = null;

    return new Promise((resolve) => {
      srv.close(() => {
        resolve();
      });
    });
  }
}
