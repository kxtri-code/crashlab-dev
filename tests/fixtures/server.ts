/**
 * Local fixture server for browser-backed tests.
 *
 * Uses `node:http` only - no test-runner web server dependency. Listens on an
 * ephemeral port so parallel test files never collide.
 */

import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Endpoints that must return a non-2xx status, to exercise error capture. */
function fixtureResponse(pathname: string): { status: number; type: string; body: string } {
  if (pathname === '/style.css') {
    return { status: 200, type: 'text/css; charset=utf-8', body: 'body { font-family: sans-serif; }' };
  }
  if (pathname === '/app.js') {
    return { status: 200, type: 'text/javascript; charset=utf-8', body: '/* fixture script */' };
  }
  if (pathname === '/api/telemetry') {
    return { status: 200, type: 'application/json', body: '{"ok":true}' };
  }
  if (pathname === '/api/missing-resource') {
    return { status: 404, type: 'application/json', body: '{"error":"not found"}' };
  }
  if (pathname === '/boom') {
    return { status: 500, type: 'text/plain; charset=utf-8', body: 'internal fixture error' };
  }
  if (pathname === '/api/probe') {
    return { status: 200, type: 'application/json', body: '{"ok":true}' };
  }
  if (pathname === '/submitted') {
    return { status: 200, type: 'text/html; charset=utf-8', body: '<!doctype html><title>Submitted</title><h1>Submitted</h1>' };
  }
  if (pathname === '/catalog') {
    return { status: 200, type: 'text/html; charset=utf-8', body: 'catalog placeholder' };
  }
  if (pathname === '/spa-form') {
    return {
      status: 200,
      type: 'text/html; charset=utf-8',
      body: `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>SPA Form - CrashLab Fixture</title></head>
<body>
  <h1>SPA Form</h1>
  <form id="spa-form" data-testid="spa-form">
    <label for="query">Query</label>
    <input id="query" name="query" type="text" data-testid="query" />
    <button type="submit" id="spa-submit" data-testid="spa-submit">Submit via JS</button>
  </form>
  <script>
    document.getElementById('spa-form').addEventListener('submit', (e) => {
      e.preventDefault();
      window.location.href = '/thank-you';
    });
  </script>
</body>
</html>`,
    };
  }
  return { status: 404, type: 'text/plain; charset=utf-8', body: 'fixture route not found' };
}

/** Start the fixture server. Caller must `await stopFixtureServer(server)`. */
export async function startFixtureServer(): Promise<{ server: Server; origin: string }> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const pathname = url.pathname;

    const send = (status: number, type: string, body: string): void => {
      response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      response.end(body);
    };

    // Redirect endpoint, to exercise `target.redirected`.
    if (pathname === '/redirect') {
      response.writeHead(302, { location: '/plain' });
      response.end();
      return;
    }

    const pageFile: Record<string, string> = {
      '/checkout': 'checkout.html',
      '/login': 'login.html',
      '/plain': 'plain.html',
      // Build 3: the page the executor drives.
      '/executor': 'executor.html',
      // Build 3.1: the integration shop page, goal -> scout -> journey -> execute.
      '/shop': 'shop.html',
      // Build 6.2: pages whose links give the planner a structured assertion.
      '/catalog': 'assertions.html',
      '/cart': 'cart.html',
      // Build 6.3: forms whose declared action gives the planner a postcondition.
      '/contact': 'postcondition.html',
      '/thank-you': 'thank-you.html',
      '/payment-success': 'thank-you.html',
    };
    const file = pageFile[pathname];
    if (file) {
      readFile(join(HERE, file), 'utf8')
        .then((contents) => {
          // Resolve the canonical link's placeholder PORT to the real origin.
          send(200, 'text/html; charset=utf-8', contents.replaceAll('PORT', String(server.address() === null ? 0 : (server.address() as { port: number }).port)));
        })
        .catch(() => send(404, 'text/plain; charset=utf-8', 'fixture page missing'));
      return;
    }

    const fixture = fixtureResponse(pathname);
    send(fixture.status, fixture.type, fixture.body);
  });

  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return { server, origin: `http://127.0.0.1:${port}` };
}

/** Stop a server started by `startFixtureServer`. */
export async function stopFixtureServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
    server.closeAllConnections?.();
  });
}
