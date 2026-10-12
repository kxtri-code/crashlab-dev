/**
 * Product API Server — Build 11: Hosted MVP Foundation.
 *
 * Lightweight, zero-dependency Node.js HTTP server.
 * Binds strictly to 127.0.0.1 (loopback) with zero external network traffic.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { handleProductApiRequest, type RouteHandlerContext } from './routes.js';
import type { ProductService } from '../service/productService.js';

export interface ProductApiServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly service: ProductService;
  readonly defaultUserId?: string;
}

export class ProductApiServer {
  private readonly server: Server;
  private readonly host: string;
  private readonly port: number;
  private activeUrl: string | null = null;
  private activePort: number | null = null;

  constructor(options: ProductApiServerOptions) {
    this.host = options.host ?? '127.0.0.1';
    this.port = options.port ?? 0;

    const context: RouteHandlerContext = {
      service: options.service,
      defaultUserId: options.defaultUserId,
    };

    this.server = createServer((req, res) => {
      handleProductApiRequest(req, res, context).catch((err) => {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: { code: 'INTERNAL_ERROR', message: (err as Error).message } }));
        }
      });
    });
  }

  get url(): string {
    if (!this.activeUrl) {
      throw new Error('Product API server is not running.');
    }
    return this.activeUrl;
  }

  get boundPort(): number {
    if (this.activePort === null) {
      throw new Error('Product API server is not running.');
    }
    return this.activePort;
  }

  async start(): Promise<{ url: string; port: number }> {
    return new Promise((resolve, reject) => {
      this.server.on('error', reject);
      this.server.listen(this.port, this.host, () => {
        const addr = this.server.address() as AddressInfo;
        this.activePort = addr.port;
        this.activeUrl = `http://${this.host}:${addr.port}`;
        resolve({ url: this.activeUrl, port: addr.port });
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server.listening) {
        resolve();
        return;
      }
      this.server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}

export function createProductApiServer(options: ProductApiServerOptions): ProductApiServer {
  return new ProductApiServer(options);
}
