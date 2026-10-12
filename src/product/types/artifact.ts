/**
 * Run Artifact Domain Contract — Build 11: Hosted MVP Foundation.
 *
 * Tracks durable evidence files generated during pipeline execution.
 * Preserves cryptographic checksums and workspace ownership.
 */

export type ArtifactType =
  | 'scout'
  | 'journey'
  | 'execution'
  | 'anomalies'
  | 'reproduction'
  | 'candidates'
  | 'baseline'
  | 'preflight'
  | 'review-events';

export interface RunArtifact {
  readonly id: string;
  readonly schemaVersion: '1.0';
  readonly workspaceId: string;
  readonly runId: string;
  readonly type: ArtifactType;
  readonly storagePath: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly contentType: string;
  readonly createdAt: string;
}

export interface RegisterArtifactInput {
  readonly workspaceId: string;
  readonly runId: string;
  readonly type: ArtifactType;
  readonly storagePath: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly contentType?: string;
}
