/**
 * Blob Storage Configuration & Factory — Build 12B.2A: Secure Artifact Blob Storage.
 *
 * Resolves the physical artifact storage backend ('local' | 's3'):
 * - Default: 'local' filesystem with safe configurable root directory
 * - Prohibits unconfigured silent fallbacks
 * - Sanitizes all paths and options
 */

import * as path from 'node:path';
import type { BlobStore } from './interfaces.js';
import { BlobStorageError } from './interfaces.js';
import { LocalBlobStore } from './localStore.js';
import { S3CompatibleBlobStore, type S3ClientLike } from './s3Store.js';
import { SupabaseBlobStore, DEFAULT_MAX_BLOB_BYTES } from './supabaseStore.js';

export type BlobStoreProvider = 'local' | 's3' | 'supabase';

export interface BlobStoreConfig {
  readonly provider: BlobStoreProvider;
  readonly localRoot?: string;
  readonly s3Bucket?: string;
  readonly s3Prefix?: string;
  readonly s3Client?: S3ClientLike;
  readonly supabaseUrl?: string;
  readonly supabaseBucket?: string;
  readonly supabaseServiceRoleKey?: string;
  readonly maxByteLength?: number;
  readonly fetchFn?: typeof fetch;
}

export function loadBlobStoreConfigFromEnv(): BlobStoreConfig {
  const rawProvider = (process.env.PRODUCT_BLOB_STORE ?? 'local').toLowerCase().trim();
  let provider: BlobStoreProvider = 'local';
  if (rawProvider === 's3') {
    provider = 's3';
  } else if (rawProvider === 'supabase') {
    provider = 'supabase';
  }

  const localRoot = process.env.PRODUCT_BLOB_ROOT
    ? path.resolve(process.env.PRODUCT_BLOB_ROOT.trim())
    : path.resolve(process.cwd(), '.artifacts');

  const maxBytes = process.env.PRODUCT_BLOB_MAX_BYTES
    ? Number.parseInt(process.env.PRODUCT_BLOB_MAX_BYTES.trim(), 10)
    : DEFAULT_MAX_BLOB_BYTES;

  return {
    provider,
    localRoot,
    s3Bucket: process.env.PRODUCT_BLOB_S3_BUCKET?.trim(),
    s3Prefix: process.env.PRODUCT_BLOB_S3_PREFIX?.trim(),
    supabaseUrl: process.env.SUPABASE_URL?.trim(),
    supabaseBucket: process.env.SUPABASE_STORAGE_BUCKET?.trim() || 'crashlab-artifacts',
    supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY?.trim(),
    maxByteLength: Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_BLOB_BYTES,
  };
}

export interface ResolveBlobStoreOptions {
  readonly store?: BlobStore;
  readonly config?: Partial<BlobStoreConfig>;
  readonly localRoot?: string;
}

export function resolveBlobStore(options?: ResolveBlobStoreOptions): BlobStore {
  if (options?.store) {
    return options.store;
  }

  const envConfig = loadBlobStoreConfigFromEnv();
  const provider = options?.config?.provider ?? envConfig.provider;

  if (provider === 'local') {
    const rootDirectory = options?.localRoot ?? options?.config?.localRoot ?? envConfig.localRoot;
    if (!rootDirectory) {
      throw new BlobStorageError('Missing root directory for local blob store.');
    }
    return new LocalBlobStore({ rootDirectory });
  }

  if (provider === 's3') {
    const bucket = options?.config?.s3Bucket ?? envConfig.s3Bucket;
    const client = options?.config?.s3Client;

    if (!bucket) {
      throw new BlobStorageError('PRODUCT_BLOB_STORE=s3 is configured, but PRODUCT_BLOB_S3_BUCKET is missing.');
    }
    if (!client) {
      throw new BlobStorageError('PRODUCT_BLOB_STORE=s3 is configured, but no S3 client implementation was provided.');
    }

    return new S3CompatibleBlobStore({
      client,
      bucket,
      prefix: options?.config?.s3Prefix ?? envConfig.s3Prefix,
    });
  }

  if (provider === 'supabase') {
    const supabaseUrl = options?.config?.supabaseUrl ?? envConfig.supabaseUrl;
    const bucket = options?.config?.supabaseBucket ?? envConfig.supabaseBucket;
    const serviceRoleKey = options?.config?.supabaseServiceRoleKey ?? envConfig.supabaseServiceRoleKey;

    if (!supabaseUrl) {
      throw new BlobStorageError('PRODUCT_BLOB_STORE=supabase is configured, but SUPABASE_URL is missing.');
    }
    if (!bucket) {
      throw new BlobStorageError('PRODUCT_BLOB_STORE=supabase is configured, but SUPABASE_STORAGE_BUCKET is missing.');
    }
    if (!serviceRoleKey) {
      throw new BlobStorageError('PRODUCT_BLOB_STORE=supabase is configured, but SUPABASE_SERVICE_ROLE_KEY is missing.');
    }

    return new SupabaseBlobStore({
      supabaseUrl,
      bucket,
      serviceRoleKey,
      maxByteLength: options?.config?.maxByteLength ?? envConfig.maxByteLength,
      fetchFn: options?.config?.fetchFn,
    });
  }

  throw new BlobStorageError(`Unsupported blob store provider "${provider}". Supported: 'local', 's3', 'supabase'.`);
}
