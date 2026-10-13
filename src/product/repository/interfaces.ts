/**
 * Provider-Neutral Repository Interfaces — Build 11: Hosted MVP Foundation.
 *
 * Defines repository abstractions for data persistence.
 * Every tenant-owned entity query requires a `workspaceId` parameter to guarantee
 * tenant isolation at the data access layer.
 */

import type { User } from '../types/user.js';
import type { Workspace, WorkspaceMember } from '../types/workspace.js';
import type { Project } from '../types/project.js';
import type { TargetEnvironment } from '../types/target.js';
import type { ProductApprovedJourney } from '../types/journey.js';
import type { TestRun } from '../types/run.js';
import type { RunArtifact } from '../types/artifact.js';
import type { CandidateReference } from '../types/candidate.js';
import type { AuditEvent } from '../types/audit.js';

export interface UserRepository {
  findById(id: string): Promise<User | null>;
  findByEmail(email: string): Promise<User | null>;
  create(user: User): Promise<User>;
  update(user: User): Promise<User>;
}

export interface WorkspaceRepository {
  findById(id: string): Promise<Workspace | null>;
  findBySlug(slug: string): Promise<Workspace | null>;
  listByOwner(ownerUserId: string): Promise<readonly Workspace[]>;
  create(workspace: Workspace): Promise<Workspace>;
  update(workspace: Workspace): Promise<Workspace>;
}

export interface MembershipRepository {
  findById(id: string): Promise<WorkspaceMember | null>;
  findByWorkspaceAndUser(workspaceId: string, userId: string): Promise<WorkspaceMember | null>;
  listByWorkspace(workspaceId: string): Promise<readonly WorkspaceMember[]>;
  listByUser(userId: string): Promise<readonly WorkspaceMember[]>;
  create(member: WorkspaceMember): Promise<WorkspaceMember>;
  delete(id: string): Promise<boolean>;
}

export interface ProjectRepository {
  findById(workspaceId: string, id: string): Promise<Project | null>;
  listByWorkspace(workspaceId: string): Promise<readonly Project[]>;
  create(project: Project): Promise<Project>;
  update(project: Project): Promise<Project>;
}

export interface TargetRepository {
  findById(workspaceId: string, id: string): Promise<TargetEnvironment | null>;
  listByProject(workspaceId: string, projectId: string): Promise<readonly TargetEnvironment[]>;
  create(target: TargetEnvironment): Promise<TargetEnvironment>;
  update(target: TargetEnvironment): Promise<TargetEnvironment>;
}

export interface JourneyRepository {
  findById(workspaceId: string, id: string): Promise<ProductApprovedJourney | null>;
  listByTarget(workspaceId: string, targetEnvironmentId: string): Promise<readonly ProductApprovedJourney[]>;
  create(journey: ProductApprovedJourney): Promise<ProductApprovedJourney>;
}

export interface RunRepository {
  findById(workspaceId: string, id: string): Promise<TestRun | null>;
  listByProject(workspaceId: string, projectId: string): Promise<readonly TestRun[]>;
  listByWorkspace(workspaceId: string): Promise<readonly TestRun[]>;
  create(run: TestRun): Promise<TestRun>;
  update(run: TestRun): Promise<TestRun>;
}

export interface ArtifactRepository {
  findById(workspaceId: string, id: string): Promise<RunArtifact | null>;
  listByRun(workspaceId: string, runId: string): Promise<readonly RunArtifact[]>;
  create(artifact: RunArtifact): Promise<RunArtifact>;
}

export interface CandidateRepository {
  findById(workspaceId: string, id: string): Promise<CandidateReference | null>;
  listByRun(workspaceId: string, runId: string): Promise<readonly CandidateReference[]>;
  listByProject(workspaceId: string, projectId: string): Promise<readonly CandidateReference[]>;
  create(candidate: CandidateReference): Promise<CandidateReference>;
  update(candidate: CandidateReference): Promise<CandidateReference>;
}

export interface AuditRepository {
  findById(workspaceId: string, id: string): Promise<AuditEvent | null>;
  listByWorkspace(workspaceId: string, limit?: number): Promise<readonly AuditEvent[]>;
  create(event: AuditEvent): Promise<AuditEvent>;
}

import type { RunQueueRepository } from '../queue/repository.js';

export interface ProductRepositories {
  readonly users: UserRepository;
  readonly workspaces: WorkspaceRepository;
  readonly memberships: MembershipRepository;
  readonly projects: ProjectRepository;
  readonly targets: TargetRepository;
  readonly journeys: JourneyRepository;
  readonly runs: RunRepository;
  readonly artifacts: ArtifactRepository;
  readonly candidates: CandidateRepository;
  readonly audits: AuditRepository;
  readonly queue?: RunQueueRepository;
}
