/**
 * Identity & Authentication Context — Build 12D.1: Production Authentication Boundary.
 *
 * Defines provider-neutral authenticated identity context and authentication configuration.
 * Strictly distinguishes production authentication (JWT / JWKS) from local development mode (HMAC dev tokens).
 */

import {
  JwksClient,
  JwtVerifier,
  type JwksFetchFunction,
} from './jwtVerifier.js';

export type AuthMethod = 'bearer_token' | 'bearer_jwt' | 'development_header';
export type AuthMode = 'development' | 'production';

export interface IdentityContext {
  readonly userId: string;
  readonly authMethod: AuthMethod;
  readonly requestId: string;
  readonly email?: string;
  readonly workspaceId?: string;
}

export interface ProductionAuthConfig {
  readonly supabaseUrl?: string;
  readonly supabaseJwksUrl?: string;
  readonly supabaseJwtIssuer?: string;
  readonly supabaseJwtAudience?: string;
  readonly jwksCacheTtlMs?: number;
  readonly jwksFetchFn?: JwksFetchFunction;
}

export interface AuthConfig {
  readonly authMode: AuthMode;
  readonly authSecret: string; // Used strictly for local development mode HMAC tokens
  readonly productionAuth?: ProductionAuthConfig;
  readonly jwksClient?: JwksClient;
  readonly jwtVerifier?: JwtVerifier;
}

/** Default local secret used only in development/test fallback when explicitly in development mode. */
export const DEFAULT_DEV_AUTH_SECRET = 'crashlab-local-dev-secret-do-not-use-in-production';

/** Expected default audience for Supabase Auth tokens */
export const DEFAULT_SUPABASE_JWT_AUDIENCE = 'authenticated';

export interface ProductionAuthValidationResult {
  readonly valid: boolean;
  readonly missingVariables: readonly string[];
}

/**
 * Validates production authentication configuration from environment variables.
 * Reports missing variable names ONLY — never prints or returns variable values.
 */
export function validateProductionAuthConfig(
  env: Record<string, string | undefined> = process.env,
): ProductionAuthValidationResult {
  const missing: string[] = [];

  const hasJwksUrl = Boolean(env.SUPABASE_JWKS_URL?.trim());
  const hasSupabaseUrl = Boolean(env.SUPABASE_URL?.trim());

  if (!hasJwksUrl && !hasSupabaseUrl) {
    missing.push('SUPABASE_URL');
  }

  const hasIssuer = Boolean(env.SUPABASE_JWT_ISSUER?.trim());
  if (!hasIssuer && !hasSupabaseUrl) {
    missing.push('SUPABASE_JWT_ISSUER');
  }

  return {
    valid: missing.length === 0,
    missingVariables: Object.freeze(missing),
  };
}

/**
 * Loads authentication configuration from environment variables.
 * PRODUCT_AUTH_MODE: 'development' | 'production' (default: 'production')
 * PRODUCT_AUTH_SECRET: Secret key for signing and verifying development tokens
 * SUPABASE_URL: Root Supabase URL (server-only)
 * SUPABASE_JWKS_URL: JWKS public key endpoint (server-only)
 * SUPABASE_JWT_ISSUER: Expected JWT issuer URL
 * SUPABASE_JWT_AUDIENCE: Expected JWT audience (default: 'authenticated')
 */
export function loadAuthConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): AuthConfig {
  const rawMode = env.PRODUCT_AUTH_MODE?.trim().toLowerCase();
  const authMode: AuthMode = rawMode === 'development' ? 'development' : 'production';
  const authSecret = env.PRODUCT_AUTH_SECRET?.trim() || DEFAULT_DEV_AUTH_SECRET;

  const supabaseUrl = env.SUPABASE_URL?.trim();
  const supabaseJwksUrl =
    env.SUPABASE_JWKS_URL?.trim() ||
    (supabaseUrl ? `${supabaseUrl.replace(/\/+$/, '')}/auth/v1/.well-known/jwks.json` : undefined);
  const supabaseJwtIssuer =
    env.SUPABASE_JWT_ISSUER?.trim() ||
    (supabaseUrl ? `${supabaseUrl.replace(/\/+$/, '')}/auth/v1` : undefined);
  const supabaseJwtAudience =
    env.SUPABASE_JWT_AUDIENCE?.trim() || DEFAULT_SUPABASE_JWT_AUDIENCE;

  let productionAuth: ProductionAuthConfig | undefined;
  let jwksClient: JwksClient | undefined;
  let jwtVerifier: JwtVerifier | undefined;

  if (supabaseJwksUrl && supabaseJwtIssuer) {
    productionAuth = {
      supabaseUrl,
      supabaseJwksUrl,
      supabaseJwtIssuer,
      supabaseJwtAudience,
    };
    jwksClient = new JwksClient({ jwksUrl: supabaseJwksUrl });
    jwtVerifier = new JwtVerifier({
      jwksClient,
      expectedIssuer: supabaseJwtIssuer,
      expectedAudience: supabaseJwtAudience,
    });
  }

  return {
    authMode,
    authSecret,
    productionAuth,
    jwksClient,
    jwtVerifier,
  };
}
