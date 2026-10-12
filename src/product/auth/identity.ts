/**
 * Identity & Authentication Context — Build 12B.1: Real Authentication Boundary.
 *
 * Defines provider-neutral authenticated identity context and authentication configuration.
 * Strictly distinguishes production authentication from local development mode.
 */

export type AuthMethod = 'bearer_token' | 'development_header';
export type AuthMode = 'development' | 'production';

export interface IdentityContext {
  readonly userId: string;
  readonly authMethod: AuthMethod;
  readonly requestId: string;
  readonly workspaceId?: string;
}

export interface AuthConfig {
  readonly authMode: AuthMode;
  readonly authSecret: string;
}

/** Default local secret used only in development/test fallback when not explicitly configured. */
export const DEFAULT_DEV_AUTH_SECRET = 'crashlab-local-dev-secret-do-not-use-in-production';

/**
 * Loads authentication configuration from environment variables.
 * PRODUCT_AUTH_MODE: 'development' | 'production' (default: 'production')
 * PRODUCT_AUTH_SECRET: Secret key for signing and verifying tokens
 */
export function loadAuthConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): AuthConfig {
  const rawMode = env.PRODUCT_AUTH_MODE?.trim().toLowerCase();
  const authMode: AuthMode = rawMode === 'development' ? 'development' : 'production';
  const authSecret = env.PRODUCT_AUTH_SECRET?.trim() || DEFAULT_DEV_AUTH_SECRET;

  return {
    authMode,
    authSecret,
  };
}
