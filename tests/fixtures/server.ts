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
