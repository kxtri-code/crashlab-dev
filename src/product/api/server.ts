/**
 * Product API Server — Build 12B.1: Real Authentication & Storage Wiring.
 *
 * Lightweight, zero-dependency Node.js HTTP server.
 * Binds strictly to 127.0.0.1 (loopback) with zero external network traffic.
 *
 * Supports:
 * - Direct ProductService or repository dependency injection
 * - Explicit storage resolution ('in-memory' | 'postgres')
 * - Real authentication middleware configuration
 * - Safe graceful shutdown (releases pool connections if owned)
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { handleProductApiRequest, type RouteHandlerContext } from './routes.js';
import { ProductService } from '../service/productService.js';
import type { ProductRepositories } from '../repository/interfaces.js';
import type { PostgresPool } from '../repository/postgresPool.js';
import type { ProductStorageType } from '../storage.js';
import { resolveProductRepositories } from '../storage.js';
import type { AuthConfig, AuthMode } from '../auth/identity.js';
import { loadAuthConfigFromEnv } from '../auth/identity.js';
import type { IdGenerator } from '../util/id.js';

export interface ProductApiServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly service?: ProductService;
  readonly repositories?: ProductRepositories;
  readonly storage?: ProductStorageType;
  readonly databaseUrl?: string;
  readonly pool?: PostgresPool;
  readonly authConfig?: AuthConfig;
  readonly authMode?: AuthMode;
  readonly authSecret?: string;
  readonly defaultUserId?: string;
  readonly idGenerator?: IdGenerator;
}

export class ProductApiServer {
  private readonly server: Server;
  private readonly host: string;
  private readonly port: number;
  private readonly service: ProductService;
  private readonly ownedPool?: PostgresPool;
  private activeUrl: string | null = null;
  private activePort: number | null = null;

  constructor(options: ProductApiServerOptions) {
    this.host = options.host ?? '127.0.0.1';
    this.port = options.port ?? 0;

    // 1. Resolve repositories & service
    if (options.service) {
      this.service = options.service;
      this.ownedPool = options.pool;
    } else {
      const resolved = resolveProductRepositories({
        storage: options.storage,
        databaseUrl: options.databaseUrl,
        pool: options.pool,
        repositories: options.repositories,
      });
      this.service = new ProductService({
        repositories: resolved.repositories,
        idGenerator: options.idGenerator,
      });
      this.ownedPool = resolved.pool;
    }

    // 2. Resolve authentication configuration
    const envAuthConfig = loadAuthConfigFromEnv();
    const resolvedMode: AuthMode =
      options.authMode ??
      options.authConfig?.authMode ??
      (process.env.PRODUCT_AUTH_MODE
        ? envAuthConfig.authMode
        : options.defaultUserId
          ? 'development'
          : envAuthConfig.authMode);

    const resolvedSecret =
      options.authSecret ?? options.authConfig?.authSecret ?? envAuthConfig.authSecret;

    const authConfig: AuthConfig = {
      authMode: resolvedMode,
      authSecret: resolvedSecret,
    };

    const context: RouteHandlerContext = {
      service: this.service,
      authConfig,
      defaultUserId: options.defaultUserId,
      idGenerator: options.idGenerator,
    };

    this.server = createServer((req, res) => {
      handleProductApiRequest(req, res, context).catch((err) => {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              success: false,
              error: { code: 'INTERNAL_ERROR', message: (err as Error).message },
            }),
          );
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

  get productService(): ProductService {
    return this.service;
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
        if (this.ownedPool) {
          this.ownedPool.end().then(() => resolve(), reject);
        } else {
          resolve();
        }
        return;
      }
      this.server.close(async (err) => {
        if (err) {
          reject(err);
          return;
        }
        if (this.ownedPool) {
          try {
            await this.ownedPool.end();
            resolve();
          } catch (poolErr) {
            reject(poolErr);
          }
        } else {
          resolve();
        }
      });
    });
  }
}

export function createProductApiServer(options: ProductApiServerOptions): ProductApiServer {
  return new ProductApiServer(options);
}
