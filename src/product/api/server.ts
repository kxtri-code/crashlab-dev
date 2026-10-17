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
import type { AuthConfig, AuthMode, ProductionAuthConfig } from '../auth/identity.js';
import { loadAuthConfigFromEnv } from '../auth/identity.js';
import type { JwtVerifier, JwksClient } from '../auth/jwtVerifier.js';
import type { BlobStore } from '../blob/interfaces.js';
import type { BlobStoreConfig } from '../blob/config.js';
import { resolveBlobStore } from '../blob/config.js';
import type { IdGenerator } from '../util/id.js';

import type { RunQueueRepository } from '../queue/repository.js';

export interface ProductApiServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly service?: ProductService;
  readonly repositories?: ProductRepositories;
  readonly runQueue?: RunQueueRepository;
  readonly storage?: ProductStorageType;
  readonly databaseUrl?: string;
  readonly pool?: PostgresPool;
  readonly blobStore?: BlobStore;
  readonly blobStoreConfig?: BlobStoreConfig;
  readonly blobRoot?: string;
  readonly authConfig?: AuthConfig;
  readonly authMode?: AuthMode;
  readonly authSecret?: string;
  readonly productionAuth?: ProductionAuthConfig;
  readonly jwtVerifier?: JwtVerifier;
  readonly jwksClient?: JwksClient;
  readonly defaultUserId?: string;
  readonly idGenerator?: IdGenerator;
  readonly allowedOrigins?: readonly string[];
  readonly corsAllowedOrigins?: readonly string[];
  readonly maxRequestBodyBytes?: number;
  readonly maxArtifactBytes?: number;
  readonly serveDashboard?: boolean;
}


export class ProductApiServer {
  private readonly server: Server;
  private readonly host: string;
  private readonly port: number;
  private readonly service: ProductService;
  private readonly ownedPool?: PostgresPool;
  private readonly ownedBlobStore?: BlobStore;
  private activeUrl: string | null = null;
  private activePort: number | null = null;

  constructor(options: ProductApiServerOptions) {
    this.host = options.host ?? process.env.HOST ?? '127.0.0.1';
    this.port = options.port ?? (process.env.PORT ? parseInt(process.env.PORT, 10) : 0);

    // 1. Resolve repositories & service
    if (options.service) {
      this.service = options.service;
      this.ownedPool = options.pool;
      this.ownedBlobStore = options.blobStore;
    } else {
      const resolved = resolveProductRepositories({
        storage: options.storage,
        databaseUrl: options.databaseUrl,
        pool: options.pool,
        repositories: options.repositories,
      });

      const blobStore =
        options.blobStore ??
        resolveBlobStore({
          config: options.blobStoreConfig,
          localRoot: options.blobRoot,
        });

      this.service = new ProductService({
        repositories: resolved.repositories,
        runQueue: options.runQueue,
        blobStore,
        idGenerator: options.idGenerator,
      });
      this.ownedPool = resolved.pool;
      this.ownedBlobStore = options.blobStore ? undefined : blobStore;
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

    const productionAuth =
      options.productionAuth ?? options.authConfig?.productionAuth ?? envAuthConfig.productionAuth;

    const jwksClient =
      options.jwksClient ?? options.authConfig?.jwksClient ?? envAuthConfig.jwksClient;

    const jwtVerifier =
      options.jwtVerifier ?? options.authConfig?.jwtVerifier ?? envAuthConfig.jwtVerifier;

    const authConfig: AuthConfig = {
      authMode: resolvedMode,
      authSecret: resolvedSecret,
      productionAuth,
      jwksClient,
      jwtVerifier,
    };

    const context: RouteHandlerContext = {
      service: this.service,
      authConfig,
      defaultUserId: options.defaultUserId,
      idGenerator: options.idGenerator,
      allowedOrigins: options.allowedOrigins ?? options.corsAllowedOrigins,
      maxRequestBodyBytes: options.maxRequestBodyBytes,
      maxArtifactBytes: options.maxArtifactBytes,
      serveDashboard: options.serveDashboard,
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

  get blobStore(): BlobStore {
    return this.service.blobStore;
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
    const cleanupResources = async () => {
      if (this.ownedBlobStore) {
        try {
          await this.ownedBlobStore.close();
        } catch {}
      }
      if (this.ownedPool) {
        await this.ownedPool.end();
      }
    };

    return new Promise((resolve, reject) => {
      if (!this.server.listening) {
        cleanupResources().then(() => resolve(), reject);
        return;
      }
      this.server.close(async (err) => {
        if (err) {
          reject(err);
          return;
        }
        try {
          await cleanupResources();
          resolve();
        } catch (cleanupErr) {
          reject(cleanupErr);
        }
      });
    });
  }
}

export function createProductApiServer(options: ProductApiServerOptions): ProductApiServer {
  return new ProductApiServer(options);
}
