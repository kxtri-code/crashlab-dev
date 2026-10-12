/**
 * Secret Provider Implementations — Build 11: Hosted MVP Foundation.
 *
 * Provides a safe in-memory provider for testing without external secret managers.
 */

import type { SecretProvider } from '../types/config.js';

/** In-memory fake secret provider for unit testing. */
export class FakeSecretProvider implements SecretProvider {
  private readonly secrets = new Map<string, string>();

  constructor(initialSecrets: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(initialSecrets)) {
      this.secrets.set(key, value);
    }
  }

  async getSecret(referenceKey: string): Promise<string | null> {
    return this.secrets.get(referenceKey) ?? null;
  }

  async hasSecret(referenceKey: string): Promise<boolean> {
    return this.secrets.has(referenceKey);
  }

  setSecret(referenceKey: string, secretValue: string): void {
    this.secrets.set(referenceKey, secretValue);
  }

  clear(): void {
    this.secrets.clear();
  }
}
