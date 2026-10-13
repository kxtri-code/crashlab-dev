/**
 * Product Dashboard HTTP Static & Proxy Server — Build 12C.1.
 *
 * Exposes the CrashLab Dashboard browser client over local loopback HTTP:
 * - Serves secure HTML shell with CSP and nosniff headers
 * - Serves embedded CSS styles and JavaScript application bundle
 * - Proxies /api/* requests to the configured Product API server
 * - Enforces read-only HTTP method policy for static assets (GET, HEAD only)
 * - Traversal protection against malicious paths
 * - Graceful lifecycle shutdown
 */

import { createServer, request as httpRequest } from 'node:http';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { STYLES_CSS } from './stylesAsset.js';
import { CLIENT_JS_BUNDLE } from './clientBundle.js';
import { renderDashboardHtmlShell } from './render.js';
import {
  DEFAULT_DASHBOARD_HOST,
  DEFAULT_DASHBOARD_PORT,
  DEFAULT_PRODUCT_API_URL,
  type DashboardServerOptions,
  type RunningDashboardServer,
} from './types.js';

export async function handleDashboardRequest(
  req: IncomingMessage,
  res: ServerResponse,
  apiUrl: string,
): Promise<void> {
  const method = req.method?.toUpperCase() ?? 'GET';
  const rawUrl = req.url ?? '/';

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl, 'http://127.0.0.1');
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { code: 'invalid-url', message: 'Malformed URL.' } }));
    return;
  }

  const pathname = parsedUrl.pathname;

  // 1. Path Traversal & Control Character Protection
  if (rawUrl.includes('..') || rawUrl.toLowerCase().includes('%2e%2e') || pathname.includes('..') || /[\x00-\x1f\x7f]/.test(pathname)) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        error: { code: 'INVALID_PATH', message: 'Path contains traversal or invalid characters.' },
      }),
    );
    return;
  }

  // 2. Health Endpoint: /health
  if (pathname === '/health') {
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      res.end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
    const healthBody = JSON.stringify({
      ok: true,
      service: 'crashlab-dashboard',
      readOnly: true,
      apiUrl,
    });
    res.end(method === 'HEAD' ? undefined : healthBody);
    return;
  }

  // 3. Reverse Proxy: /api/* -> Product API
  if (pathname.startsWith('/api/')) {
    const targetUrl = new URL(pathname + parsedUrl.search, apiUrl);
    const proxyHeaders = { ...req.headers };
    proxyHeaders.host = targetUrl.host;

    const proxyReq = httpRequest(
      targetUrl,
      {
        method,
        headers: proxyHeaders,
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 500, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );

    proxyReq.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            error: {
              code: 'BAD_GATEWAY',
              message: `Failed to proxy to Product API at ${apiUrl}: ${err.message}`,
            },
          }),
        );
      }
    });

    req.pipe(proxyReq);
    return;
  }

  // 4. Static Asset Protection: Only GET and HEAD allowed for dashboard static assets
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      Allow: 'GET, HEAD',
    });
    res.end(
      JSON.stringify({
        error: {
          code: 'METHOD_NOT_ALLOWED',
          message: `Method ${method} not allowed for static dashboard assets.`,
        },
      }),
    );
    return;
  }

  // 5. CSS Stylesheet: /styles.css
  if (pathname === '/styles.css') {
    res.writeHead(200, {
      'Content-Type': 'text/css; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(method === 'HEAD' ? undefined : STYLES_CSS);
    return;
  }

  // 6. JavaScript Client Application Bundle: /app.js
  if (pathname === '/app.js') {
    res.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(method === 'HEAD' ? undefined : CLIENT_JS_BUNDLE);
    return;
  }

  // 7. Root HTML Shell: / or /* (SPA routing fallback)
  const html = renderDashboardHtmlShell({ apiUrl });
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' http://127.0.0.1:* http://localhost:* ws:; font-src 'self' data:; object-src 'none'; frame-src 'none'; base-uri 'self';",
  });
  res.end(method === 'HEAD' ? undefined : html);
}

export async function createDashboardServer(
  options: DashboardServerOptions = {},
): Promise<RunningDashboardServer> {
  const host = options.host ?? DEFAULT_DASHBOARD_HOST;
  const port = options.port ?? DEFAULT_DASHBOARD_PORT;
  const apiUrl = options.apiUrl ?? DEFAULT_PRODUCT_API_URL;

  return new Promise((resolve, reject) => {
    const server: Server = createServer((req, res) => {
      handleDashboardRequest(req, res, apiUrl).catch((err) => {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: (err as Error).message } }));
        }
      });
    });

    server.on('error', reject);

    server.listen(port, host, () => {
      const addr = server.address() as AddressInfo;
      const actualPort = addr.port;
      const url = `http://${host}:${actualPort}`;

      resolve({
        url,
        port: actualPort,
        apiUrl,
        stop: () =>
          new Promise<void>((stopResolve, stopReject) => {
            server.close((err) => (err ? stopReject(err) : stopResolve()));
          }),
      });
    });
  });
}
