/**
 * Candidate Reference Domain Contract — Build 11: Hosted MVP Foundation.
 *
 * Tracks candidate defect findings linked to specific projects and runs.
 * Non-negotiable invariants: confirmed: false, confirmedBug: false.
 */

export type ProductCandidateStatus =
  | 'unreviewed'
  | 'investigating'
  | 'accepted'
  | 'dismissed'
  | 'duplicate'
  | 'resolved';

export interface CandidateReference {
  readonly id: string;
  readonly schemaVersion: '1.0';
  readonly workspaceId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly candidateId: string;
  readonly ruleId: string;
  readonly classification: string;
  readonly reproduced: boolean;
  readonly reviewStatus: ProductCandidateStatus;
  /** Invariant: Automated candidates are never confirmed bugs without human signoff. */
  readonly confirmed: false;
  /** Invariant: Automated tools never claim definitive bug confirmation. */
  readonly confirmedBug: false;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RegisterCandidateReferenceInput {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly candidateId: string;
  readonly ruleId: string;
  readonly classification: string;
  readonly reproduced: boolean;
  readonly reviewStatus?: ProductCandidateStatus;
}
