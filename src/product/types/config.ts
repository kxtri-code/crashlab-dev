/**
 * Configuration & Provider Interfaces — Build 11: Hosted MVP Foundation.
 *
 * Defines provider-neutral interfaces for application configuration, secret
 * boundaries, storage, and worker execution.
 */

export type AppEnvironment = 'local' | 'test' | 'staging' | 'production';

/** Differentiates safe metadata from secret references and secret values. */
export interface SecretReference {
  /** Non-secret reference key (e.g. `vault:secret_auth_token_01`). */
  readonly referenceKey: string;
  readonly description?: string;
}

/** Provider-neutral interface for resolving secret values securely. */
export interface SecretProvider {
  /** Resolves a secret reference to its runtime value. */
  getSecret(referenceKey: string): Promise<string | null>;
  /** Verifies whether a secret reference exists without returning its value. */
  hasSecret(referenceKey: string): Promise<boolean>;
}

/** Provider-neutral report artifact storage interface. */
export interface ReportStorageProvider {
  saveArtifact(options: {
    workspaceId: string;
    runId: string;
    filename: string;
    content: string | Buffer;
    contentType: string;
  }): Promise<{ storagePath: string; byteSize: number; sha256: string }>;

  readArtifact(storagePath: string): Promise<Buffer | null>;
  artifactExists(storagePath: string): Promise<boolean>;
}

/** Provider-neutral browser worker dispatch interface. */
export interface BrowserWorkerProvider {
  /** Returns worker capability status. In Build 11, returns local-only capability. */
  getStatus(): Promise<{ mode: 'local' | 'worker-pool'; availableWorkers: number }>;
  /** Dispatch signature for future worker jobs. Not invoked in Build 11. */
  dispatchJob?(jobId: string, payload: unknown): Promise<{ accepted: boolean }>;
}

/** Product system configuration. */
export interface ProductSystemConfig {
  readonly appEnvironment: AppEnvironment;
  readonly secretProvider: SecretProvider;
  readonly storageProvider: ReportStorageProvider;
  readonly workerProvider: BrowserWorkerProvider;
  readonly safeTestModePermanent: true;
}
