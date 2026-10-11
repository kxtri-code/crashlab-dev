/**
 * Review UI Local Static & Proxy Server (Build 9.2).
 *
 * Exposes the CrashLab Review browser application over local HTTP.
 *
 * Invariants:
 *  - Read-only: accepts GET and HEAD only; all mutation methods return 405 Method Not Allowed.
 *  - Strict local binding (127.0.0.1 by default).
 *  - Proxies /api/* to the backing Build 9.1 Review API.
 *  - Does not read candidate files directly from the browser filesystem.
 *  - Leaves all report and baseline files byte-identical.
 */

import { createServer, request as httpRequest } from 'node:http';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import { STYLES_CSS } from './stylesAsset.js';
import { CLIENT_JS_BUNDLE } from './clientBundle.js';
import { renderHtmlShell } from './render.js';
import { validateHost, validatePort } from '../reviewApi/validator.js';
import { DEFAULT_UI_HOST, DEFAULT_UI_PORT, DEFAULT_API_URL } from './types.js';
import type { ReviewUiServerOptions, RunningReviewUiServer } from './types.js';

/**
 * Handle incoming request to the Review UI server.
 */
export async function handleUiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  apiUrl: string,
): Promise<void> {
  const method = req.method?.toUpperCase();

  // 1. Enforce read-only constraint
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      Allow: 'GET, HEAD',
    });
    res.end(
      JSON.stringify({
        error: {
          code: 'method-not-allowed',
          message: `Method ${method ?? 'UNKNOWN'} not allowed. Review UI is read-only.`,
        },
      }),
    );
    return;
  }

  // 2. Parse and validate URL
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

  // 3. Traversal protection
  if (pathname.includes('..') || /[\x00-\x1f\x7f]/.test(pathname)) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        error: { code: 'invalid-path', message: 'Path contains traversal or invalid characters.' },
      }),
    );
    return;
  }

  // 4. Route: /health
  if (pathname === '/health') {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
    const healthBody = JSON.stringify({
      ok: true,
      service: 'crashlab-review-ui',
      readOnly: true,
      apiUrl,
    });
    res.end(method === 'HEAD' ? undefined : healthBody);
    return;
  }

  // 5. Route: /styles.css
  if (pathname === '/styles.css') {
    res.writeHead(200, {
      'Content-Type': 'text/css; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(method === 'HEAD' ? undefined : STYLES_CSS);
    return;
  }

  // 6. Route: /app.js
  if (pathname === '/app.js') {
    res.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(method === 'HEAD' ? undefined : CLIENT_JS_BUNDLE);
    return;
  }

  // 7. Route: /api/* (Proxy to backing Review API)
  if (pathname.startsWith('/api/')) {
    proxyApiRequest(req, res, apiUrl, method as 'GET' | 'HEAD');
    return;
  }

  // 8. Default: Serve HTML Shell (SPA fallback for client routing)
  const html = renderHtmlShell({
    title: 'CrashLab Review',
    bodyContent: '<div id="loading-indicator">Loading CrashLab Review UI...</div>',
    apiUrl,
  });

  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self' 'unsafe-inline'; connect-src 'self' http://127.0.0.1:* http://localhost:*; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:;",
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(method === 'HEAD' ? undefined : html);
}

/**
 * Proxy request to the backing Review API server.
 */
function proxyApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  apiUrl: string,
  method: 'GET' | 'HEAD',
): void {
  let targetUrl: URL;
  try {
    targetUrl = new URL(req.url ?? '/', apiUrl);
  } catch {
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { code: 'bad-gateway', message: 'Invalid target API URL.' } }));
    return;
  }

  const clientReq = httpRequest(
    {
      hostname: targetUrl.hostname,
      port: targetUrl.port,
      path: targetUrl.pathname + targetUrl.search,
      method,
      headers: {
        Accept: 'application/json',
      },
    },
    (apiRes) => {
      res.writeHead(apiRes.statusCode ?? 500, {
        'Content-Type': apiRes.headers['content-type'] || 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        ...(apiRes.headers.allow ? { Allow: apiRes.headers.allow } : {}),
      });

      apiRes.pipe(res);
    },
  );

  clientReq.on('error', (err) => {
    res.writeHead(502, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(
      JSON.stringify({
        error: {
          code: 'api-unavailable',
          message: `Backing Review API at ${apiUrl} is unavailable: ${err.message}`,
        },
      }),
    );
  });

  clientReq.end();
}

/**
 * Create and configure the Review UI server.
 */
export async function createReviewUiServer(
  options: ReviewUiServerOptions = {},
): Promise<RunningReviewUiServer> {
  const host = validateHost(options.host ?? DEFAULT_UI_HOST);
  const port = options.port !== undefined ? validatePort(options.port) : DEFAULT_UI_PORT;
  const apiUrl = options.apiUrl ?? DEFAULT_API_URL;

  const server = createServer((req, res) => {
    void handleUiRequest(req, res, apiUrl);
  });

  const uiServer: RunningReviewUiServer = {
    host,
    port,
    url: `http://${host}:${port}`,
    apiUrl,
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

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      const address = server.address();
      if (address && typeof address === 'object') {
        uiServer.port = address.port;
        uiServer.url = `http://${host}:${address.port}`;
      }
      resolve();
    });
  });

  return uiServer;
}
