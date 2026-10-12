/**
 * Local synthetic fixture server for CrashLab product demonstrations (Build 10.5).
 *
 * Guarantees:
 *  - Binds strictly to loopback (127.0.0.1) on an ephemeral port.
 *  - Zero external network access or telemetry.
 *  - Zero real credentials, payment gateways, or customer data.
 *  - Self-contained deterministic routes for healthy and fault scenarios.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';

export interface DemoFixtureHandle {
  server: Server;
  origin: string;
  port: number;
  stop: () => Promise<void>;
}

const CATALOG_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>CrashLab Demo Store</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px; color: #1e293b; }
    h1 { color: #0f172a; border-bottom: 2px solid #e2e8f0; padding-bottom: 12px; }
    .badge { display: inline-block; padding: 4px 8px; background: #e0f2fe; color: #0369a1; border-radius: 4px; font-size: 13px; font-weight: 600; }
    .card { border: 1px solid #cbd5e1; border-radius: 8px; padding: 20px; margin: 20px 0; background: #f8fafc; }
    .btn { display: inline-block; padding: 10px 18px; background: #2563eb; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 500; cursor: pointer; }
    .btn:hover { background: #1d4ed8; }
    .nav { margin-bottom: 24px; display: flex; gap: 16px; align-items: center; }
    .nav a { color: #2563eb; text-decoration: none; font-weight: 500; }
    .footer { margin-top: 40px; font-size: 13px; color: #64748b; border-top: 1px solid #e2e8f0; padding-top: 16px; }
  </style>
</head>
<body>
  <div class="nav">
    <span class="badge">LOCAL SYNTHETIC FIXTURE</span>
    <a href="/" id="nav-home">Store Home</a>
    <a href="/cart" id="nav-cart">Shopping Cart</a>
  </div>
  <h1 id="page-title">Synthetic Widget Catalog</h1>
  <p>Welcome to the CrashLab demonstration environment. This application is a fully local, safe fixture with zero external connectivity.</p>

  <div class="card" id="product-card-1">
    <h2>Reliable Automation Widget (v1)</h2>
    <p>A deterministic, safe interactive test component designed for local pipeline rehearsals.</p>
    <a href="/items/1" class="btn" id="btn-view-item">View Widget Details</a>
  </div>

  <div class="card" id="product-card-2">
    <h2>Shopping Cart Overview</h2>
    <p>Safe shopping cart review without any checkout, payment, or transactional capabilities.</p>
    <a href="/cart" class="btn" id="btn-view-cart">Inspect Cart</a>
  </div>

  <div class="footer">
    <p>CrashLab Build 10.5 Demo &bull; Loopback Only &bull; Safe Test Mode Active</p>
  </div>
</body>
</html>`;

const ITEM_DETAIL_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Widget Details - CrashLab Demo Store</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px; color: #1e293b; }
    .card { border: 1px solid #cbd5e1; border-radius: 8px; padding: 24px; background: #f8fafc; }
    .btn { display: inline-block; padding: 10px 18px; background: #059669; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 500; }
    .back { display: inline-block; margin-top: 20px; color: #2563eb; text-decoration: none; }
  </style>
</head>
<body>
  <h1>Reliable Automation Widget</h1>
  <div class="card">
    <p>SKU: <strong>WIDGET-LOCAL-001</strong></p>
    <p>Status: <span style="color: #059669; font-weight: bold;">In Stock (Local Fixture)</span></p>
    <p>Description: Safe mock product for validating navigation and observation journeys.</p>
    <a href="/cart" class="btn" id="btn-add-cart">Add to Local Cart</a>
  </div>
  <a href="/" class="back" id="link-back">&larr; Return to Catalog</a>
</body>
</html>`;

const CART_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Shopping Cart - CrashLab Demo Store</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px; color: #1e293b; }
    .notice { padding: 12px 16px; background: #fef3c7; border: 1px solid #f59e0b; border-radius: 6px; color: #92400e; margin-bottom: 20px; }
    .cart-table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    .cart-table th, .cart-table td { padding: 12px; border: 1px solid #cbd5e1; text-align: left; }
    .cart-table th { background: #f1f5f9; }
    .back { display: inline-block; margin-top: 20px; color: #2563eb; text-decoration: none; font-weight: 500; }
  </style>
</head>
<body>
  <div class="notice">
    <strong>Notice:</strong> This is a non-transactional demonstration cart. Payment and checkout actions are intentionally omitted and strictly blocked by CrashLab safety rules.
  </div>
  <h1 id="cart-title">Your Local Synthetic Cart</h1>
  <table class="cart-table" id="cart-items">
    <thead>
      <tr>
        <th>Item</th>
        <th>Quantity</th>
        <th>Status</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td>Reliable Automation Widget</td>
        <td>1</td>
        <td>Verified Safe</td>
      </tr>
    </tbody>
  </table>
  <a href="/" class="back" id="link-return-store">&larr; Continue Exploring Store</a>
</body>
</html>`;

/**
 * Starts a local HTTP demo server binding exclusively to loopback on an ephemeral port.
 */
export async function startDemoFixtureServer(port = 0): Promise<DemoFixtureHandle> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = url.pathname;

    const sendHtml = (status: number, html: string): void => {
      res.writeHead(status, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store, no-cache, must-revalidate',
        'x-crashlab-demo': 'true',
      });
      res.end(html);
    };

    const sendText = (status: number, text: string): void => {
      res.writeHead(status, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store, no-cache, must-revalidate',
        'x-crashlab-demo': 'true',
      });
      res.end(text);
    };

    // Route: Controlled HTTP 500 fault
    if (pathname === '/boom') {
      sendText(500, 'Internal Server Error: Controlled synthetic server fault on /boom route.');
      return;
    }

    // Route: Healthy store home
    if (pathname === '/' || pathname === '/healthy') {
      sendHtml(200, CATALOG_HTML);
      return;
    }

    // Route: Item detail
    if (pathname === '/items/1') {
      sendHtml(200, ITEM_DETAIL_HTML);
      return;
    }

    // Route: Safe cart
    if (pathname === '/cart') {
      sendHtml(200, CART_HTML);
      return;
    }

    // Route: 404 for unknown endpoints
    sendText(404, 'Not Found: Route is not part of demo synthetic fixture.');
  });

  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve();
    });
  });

  const address = server.address();
  const assignedPort = typeof address === 'object' && address !== null ? address.port : port;
  const origin = `http://127.0.0.1:${assignedPort}`;

  const stop = async (): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  };

  return {
    server,
    origin,
    port: assignedPort,
    stop,
  };
}
