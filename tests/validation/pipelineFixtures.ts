/**
 * Local fixture application server for Build 10 End-to-End Validation.
 *
 * Implements deterministic, local HTTP endpoints for Scenarios A through I:
 *  - Scenario A: Healthy journey (200 OK, clean interactive actions, zero anomalies)
 *  - Scenario B: HTTP 500 (deterministic server fault during request)
 *  - Scenario C: HTTP 404 (deterministic missing resource endpoint)
 *  - Scenario D: JavaScript exception (uncaught page error in DOM)
 *  - Scenario E: Network request failure (transport-level socket destruction)
 *  - Scenario F: Timeout (step target hang / delay exceeding threshold)
 *  - Scenario G: Unexpected origin change (navigation to secondary local server)
 *  - Scenario H: Broken UI state (element disabled or removed after action)
 *  - Scenario I: Intermittent failure (controlled alternating responses between attempts)
 *
 * Guarantees:
 *  - Binds strictly to 127.0.0.1 on ephemeral ports (port 0)
 *  - Zero external network access
 *  - Zero production credentials or payment flows
 *  - Complete server lifecycle cleanup
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';

export interface ValidationServerHandle {
  server: Server;
  origin: string;
  port: number;
  stop: () => Promise<void>;
  resetState: () => void;
  getIntermittentAttempts: () => number;
}

export interface SecondaryServerHandle {
  server: Server;
  origin: string;
  port: number;
  stop: () => Promise<void>;
}

/**
 * Start the primary Build 10 local fixture server.
 */
export async function startValidationServer(): Promise<ValidationServerHandle> {
  let intermittentCounter = 0;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = url.pathname;

    const sendHtml = (status: number, html: string): void => {
      res.writeHead(status, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(html);
    };

    const sendJson = (status: number, data: unknown): void => {
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify(data));
    };

    const sendText = (status: number, text: string): void => {
      res.writeHead(status, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(text);
    };

    // --- Scenario A: Healthy Journey ----------------------------------------
    if (pathname === '/healthy') {
      sendHtml(
        200,
        `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Scenario A - Healthy Journey</title></head>
<body>
  <h1>Healthy App</h1>
  <p>Standard deterministic fixture without defects.</p>
  <button id="btn-action" data-testid="healthy-btn" onclick="document.getElementById('status-msg').textContent = 'Action Completed';">Submit Action</button>
  <div id="status-msg">Ready</div>
  <a href="/healthy/complete" id="link-complete">Proceed to Complete</a>
</body>
</html>`,
      );
      return;
    }

    if (pathname === '/healthy/complete') {
      sendHtml(
        200,
        `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Healthy Completed</title></head>
<body>
  <h1>Complete</h1>
  <p id="confirmation">Healthy journey successfully completed.</p>
</body>
</html>`,
      );
      return;
    }

    // --- Scenario B: HTTP 500 Fault -----------------------------------------
    if (pathname === '/scenario-500') {
      sendHtml(
        200,
        `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Scenario B - HTTP 500</title></head>
<body>
  <h1>HTTP 500 Test</h1>
  <img src="/api/error-500" alt="trigger" style="display:none;" />
  <form id="order-form" action="/healthy/complete" method="get">
    <button id="btn-submit" type="submit">Submit Order</button>
  </form>
  <script>
    fetch('/api/error-500').catch(() => {});
  </script>
</body>
</html>`,
      );
      return;
    }

    if (pathname === '/api/error-500') {
      sendJson(500, { error: 'Internal Server Error', syntheticFault: true });
      return;
    }

    // --- Scenario C: HTTP 404 Missing Resource ------------------------------
    if (pathname === '/scenario-404') {
      sendHtml(
        200,
        `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Scenario C - HTTP 404</title></head>
<body>
  <h1>HTTP 404 Test</h1>
  <button id="btn-trigger-404" onclick="fetch('/api/missing-resource').catch(() => {});">Trigger 404</button>
  <script>
    window.addEventListener('DOMContentLoaded', () => {
      fetch('/api/missing-resource').catch(() => {});
    });
  </script>
</body>
</html>`,
      );
      return;
    }

    if (pathname === '/api/missing-resource') {
      sendJson(404, { error: 'Not Found', path: '/api/missing-resource' });
      return;
    }

    // --- Scenario D: JavaScript Page Error ----------------------------------
    if (pathname === '/scenario-js-error') {
      sendHtml(
        200,
        `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Scenario D - JS Error</title></head>
<body>
  <h1>JavaScript Exception Test</h1>
  <button id="btn-trigger-err" onclick="throw new Error('Synthetic manual click exception');">Trigger Error</button>
  <script>
    window.addEventListener('DOMContentLoaded', () => {
      setTimeout(() => {
        throw new Error('Synthetic fixture JavaScript exception: unhandled runtime fault');
      }, 50);
    });
  </script>
</body>
</html>`,
      );
      return;
    }

    // --- Scenario E: Network Failure (TCP Connection Drop) -------------------
    if (pathname === '/scenario-network-failure') {
      sendHtml(
        200,
        `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Scenario E - Network Failure</title></head>
<body>
  <h1>Network Request Failure Test</h1>
  <button id="btn-trigger-drop" onclick="fetch('/api/socket-drop').catch(() => {});">Trigger Drop</button>
  <script>
    window.addEventListener('DOMContentLoaded', () => {
      fetch('/api/socket-drop').catch(() => {});
    });
  </script>
</body>
</html>`,
      );
      return;
    }

    if (pathname === '/api/socket-drop') {
      // Destroy socket immediately before writing headers, triggering transport-level network failure
      req.socket.destroy();
      return;
    }

    // --- Scenario F: Timeout (Hanging Request) --------------------------------
    if (pathname === '/scenario-timeout') {
      sendHtml(
        200,
        `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Scenario F - Step Timeout</title></head>
<body>
  <h1>Step Timeout Test</h1>
  <a id="link-hang" href="/hang">Hanging Navigation</a>
</body>
</html>`,
      );
      return;
    }

    if (pathname === '/hang') {
      // Deliberately do not end response to exercise step timeout
      // Socket will be cleaned up on server close
      return;
    }

    // --- Scenario G: Unexpected Origin Navigation ---------------------------
    if (pathname === '/scenario-redirect') {
      const target = url.searchParams.get('destination') ?? '/healthy';
      sendHtml(
        200,
        `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Scenario G - Origin Change</title></head>
<body>
  <h1>Cross Origin Navigation Test</h1>
  <a id="external-dest-link" href="${target}">Navigate to Secondary Origin</a>
</body>
</html>`,
      );
      return;
    }

    // --- Scenario H: Broken UI State (Disabled or Missing Control) -----------
    if (pathname === '/scenario-broken-ui') {
      sendHtml(
        200,
        `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Scenario H - Broken UI State</title></head>
<body>
  <h1>Broken UI State Test</h1>
  <button id="btn-pre-action" onclick="document.getElementById('btn-dependent').disabled = true;">Disable Target</button>
  <button id="btn-dependent">Dependent Action</button>
</body>
</html>`,
      );
      return;
    }

    // --- Scenario I: Intermittent Controlled Failure -------------------------
    if (pathname === '/scenario-intermittent') {
      sendHtml(
        200,
        `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Scenario I - Intermittent Failure</title></head>
<body>
  <h1>Intermittent Failure Test</h1>
  <button id="btn-intermittent" onclick="fetch('/api/intermittent').catch(() => {});">Trigger Intermittent</button>
  <script>
    window.addEventListener('DOMContentLoaded', () => {
      fetch('/api/intermittent').catch(() => {});
    });
  </script>
</body>
</html>`,
      );
      return;
    }

    if (pathname === '/api/intermittent') {
      intermittentCounter++;
      // Attempt 1: return 500 error
      // Attempt 2+: return 200 OK
      if (intermittentCounter === 1) {
        sendJson(500, { error: 'Intermittent failure on attempt 1', attempt: intermittentCounter });
      } else {
        sendJson(200, { status: 'healthy', attempt: intermittentCounter });
      }
      return;
    }

    sendText(404, 'Validation fixture route not found');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const port = address.port;
  const origin = `http://127.0.0.1:${port}`;

  const stop = async (): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
      server.closeAllConnections?.();
    });
  };

  return {
    server,
    origin,
    port,
    stop,
    resetState: () => {
      intermittentCounter = 0;
    },
    getIntermittentAttempts: () => intermittentCounter,
  };
}

/**
 * Start secondary server for Scenario G (Unexpected Origin Change).
 */
export async function startSecondaryOriginServer(): Promise<SecondaryServerHandle> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Secondary Origin Destination</title></head>
<body>
  <h1>Secondary Origin Landing Page</h1>
  <p id="origin-indicator">Navigated across local origins.</p>
</body>
</html>`);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const port = address.port;
  const origin = `http://127.0.0.1:${port}`;

  const stop = async (): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
      server.closeAllConnections?.();
    });
  };

  return {
    server,
    origin,
    port,
    stop,
  };
}
