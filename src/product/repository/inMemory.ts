/**
 * In-Memory Product Repositories Adapter — Build 11: Hosted MVP Foundation.
 *
 * Provides a clean, isolated, in-memory implementation of ProductRepositories
 * for testing without any external database dependencies.
 * Strictly verifies workspaceId tenant ownership on every customer query.
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
import type {
  UserRepository,
  WorkspaceRepository,
  MembershipRepository,
  ProjectRepository,
  TargetRepository,
  JourneyRepository,
  RunRepository,
  ArtifactRepository,
  CandidateRepository,
  AuditRepository,
  ProductRepositories,
} from './interfaces.js';

function clone<T>(val: T): T {
  return JSON.parse(JSON.stringify(val)) as T;
}

export class InMemoryUserRepository implements UserRepository {
  private readonly users = new Map<string, User>();

  async findById(id: string): Promise<User | null> {
    const user = this.users.get(id);
    return user ? clone(user) : null;
  }

  async findByEmail(email: string): Promise<User | null> {
    const lower = email.toLowerCase().trim();
    for (const user of this.users.values()) {
      if (user.email.toLowerCase().trim() === lower) {
        return clone(user);
      }
    }
    return null;
  }

  async create(user: User): Promise<User> {
    if (this.users.has(user.id)) {
      throw new Error(`User with ID "${user.id}" already exists.`);
    }
    const existing = await this.findByEmail(user.email);
    if (existing) {
      throw new Error(`User with email "${user.email}" already exists.`);
    }
    this.users.set(user.id, clone(user));
    return clone(user);
  }

  async update(user: User): Promise<User> {
    if (!this.users.has(user.id)) {
      throw new Error(`User with ID "${user.id}" does not exist.`);
    }
    this.users.set(user.id, clone(user));
    return clone(user);
  }

  clear(): void {
    this.users.clear();
  }
}

export class InMemoryWorkspaceRepository implements WorkspaceRepository {
  private readonly workspaces = new Map<string, Workspace>();

  async findById(id: string): Promise<Workspace | null> {
    const ws = this.workspaces.get(id);
    return ws ? clone(ws) : null;
  }

  async findBySlug(slug: string): Promise<Workspace | null> {
    const lower = slug.toLowerCase().trim();
    for (const ws of this.workspaces.values()) {
      if (ws.slug.toLowerCase().trim() === lower) {
        return clone(ws);
      }
    }
    return null;
  }

  async listByOwner(ownerUserId: string): Promise<readonly Workspace[]> {
    const results: Workspace[] = [];
    for (const ws of this.workspaces.values()) {
      if (ws.ownerUserId === ownerUserId) {
        results.push(clone(ws));
      }
    }
    return results;
  }

  async create(workspace: Workspace): Promise<Workspace> {
    if (this.workspaces.has(workspace.id)) {
      throw new Error(`Workspace with ID "${workspace.id}" already exists.`);
    }
    const existing = await this.findBySlug(workspace.slug);
    if (existing) {
      throw new Error(`Workspace with slug "${workspace.slug}" already exists.`);
    }
    this.workspaces.set(workspace.id, clone(workspace));
    return clone(workspace);
  }

  async update(workspace: Workspace): Promise<Workspace> {
    if (!this.workspaces.has(workspace.id)) {
      throw new Error(`Workspace with ID "${workspace.id}" does not exist.`);
    }
    this.workspaces.set(workspace.id, clone(workspace));
    return clone(workspace);
  }

  clear(): void {
    this.workspaces.clear();
  }
}

export class InMemoryMembershipRepository implements MembershipRepository {
  private readonly members = new Map<string, WorkspaceMember>();

  async findById(id: string): Promise<WorkspaceMember | null> {
    const member = this.members.get(id);
    return member ? clone(member) : null;
  }

  async findByWorkspaceAndUser(workspaceId: string, userId: string): Promise<WorkspaceMember | null> {
    for (const member of this.members.values()) {
      if (member.workspaceId === workspaceId && member.userId === userId) {
        return clone(member);
      }
    }
    return null;
  }

  async listByWorkspace(workspaceId: string): Promise<readonly WorkspaceMember[]> {
    const results: WorkspaceMember[] = [];
    for (const member of this.members.values()) {
      if (member.workspaceId === workspaceId) {
        results.push(clone(member));
      }
    }
    return results;
  }

  async listByUser(userId: string): Promise<readonly WorkspaceMember[]> {
    const results: WorkspaceMember[] = [];
    for (const member of this.members.values()) {
      if (member.userId === userId) {
        results.push(clone(member));
      }
    }
    return results;
  }

  async create(member: WorkspaceMember): Promise<WorkspaceMember> {
    if (this.members.has(member.id)) {
      throw new Error(`Member with ID "${member.id}" already exists.`);
    }
    const existing = await this.findByWorkspaceAndUser(member.workspaceId, member.userId);
    if (existing) {
      throw new Error(`User "${member.userId}" is already a member of workspace "${member.workspaceId}".`);
    }
    this.members.set(member.id, clone(member));
    return clone(member);
  }

  async delete(id: string): Promise<boolean> {
    return this.members.delete(id);
  }

  clear(): void {
    this.members.clear();
  }
}

export class InMemoryProjectRepository implements ProjectRepository {
  private readonly projects = new Map<string, Project>();

  async findById(workspaceId: string, id: string): Promise<Project | null> {
    const project = this.projects.get(id);
    if (!project || project.workspaceId !== workspaceId) return null;
    return clone(project);
  }

  async listByWorkspace(workspaceId: string): Promise<readonly Project[]> {
    const results: Project[] = [];
    for (const project of this.projects.values()) {
      if (project.workspaceId === workspaceId) {
        results.push(clone(project));
      }
    }
    return results;
  }

  async create(project: Project): Promise<Project> {
    if (this.projects.has(project.id)) {
      throw new Error(`Project with ID "${project.id}" already exists.`);
    }
    for (const existing of this.projects.values()) {
      if (existing.workspaceId === project.workspaceId && existing.name.toLowerCase() === project.name.toLowerCase()) {
        throw new Error(`Project with name "${project.name}" already exists in workspace "${project.workspaceId}".`);
      }
    }
    this.projects.set(project.id, clone(project));
    return clone(project);
  }

  async update(project: Project): Promise<Project> {
    const existing = this.projects.get(project.id);
    if (!existing || existing.workspaceId !== project.workspaceId) {
      throw new Error(`Project with ID "${project.id}" does not exist in workspace "${project.workspaceId}".`);
    }
    this.projects.set(project.id, clone(project));
    return clone(project);
  }

  clear(): void {
    this.projects.clear();
  }
}

export class InMemoryTargetRepository implements TargetRepository {
  private readonly targets = new Map<string, TargetEnvironment>();

  async findById(workspaceId: string, id: string): Promise<TargetEnvironment | null> {
    const target = this.targets.get(id);
    if (!target || target.workspaceId !== workspaceId) return null;
    return clone(target);
  }

  async listByProject(workspaceId: string, projectId: string): Promise<readonly TargetEnvironment[]> {
    const results: TargetEnvironment[] = [];
    for (const target of this.targets.values()) {
      if (target.workspaceId === workspaceId && target.projectId === projectId) {
        results.push(clone(target));
      }
    }
    return results;
  }

  async create(target: TargetEnvironment): Promise<TargetEnvironment> {
    if (this.targets.has(target.id)) {
      throw new Error(`Target with ID "${target.id}" already exists.`);
    }
    this.targets.set(target.id, clone(target));
    return clone(target);
  }

  async update(target: TargetEnvironment): Promise<TargetEnvironment> {
    const existing = this.targets.get(target.id);
    if (!existing || existing.workspaceId !== target.workspaceId) {
      throw new Error(`Target with ID "${target.id}" does not exist in workspace "${target.workspaceId}".`);
    }
    this.targets.set(target.id, clone(target));
    return clone(target);
  }

  clear(): void {
    this.targets.clear();
  }
}

export class InMemoryJourneyRepository implements JourneyRepository {
  private readonly journeys = new Map<string, ProductApprovedJourney>();

  async findById(workspaceId: string, id: string): Promise<ProductApprovedJourney | null> {
    const journey = this.journeys.get(id);
    if (!journey || journey.workspaceId !== workspaceId) return null;
    return clone(journey);
  }

  async listByTarget(workspaceId: string, targetEnvironmentId: string): Promise<readonly ProductApprovedJourney[]> {
    const results: ProductApprovedJourney[] = [];
    for (const journey of this.journeys.values()) {
      if (journey.workspaceId === workspaceId && journey.targetEnvironmentId === targetEnvironmentId) {
        results.push(clone(journey));
      }
    }
    return results;
  }

  async create(journey: ProductApprovedJourney): Promise<ProductApprovedJourney> {
    if (this.journeys.has(journey.id)) {
      throw new Error(`ApprovedJourney with ID "${journey.id}" already exists.`);
    }
    this.journeys.set(journey.id, clone(journey));
    return clone(journey);
  }

  clear(): void {
    this.journeys.clear();
  }
}

export class InMemoryRunRepository implements RunRepository {
  private readonly runs = new Map<string, TestRun>();

  async findById(workspaceId: string, id: string): Promise<TestRun | null> {
    const run = this.runs.get(id);
    if (!run || run.workspaceId !== workspaceId) return null;
    return clone(run);
  }

  async listByProject(workspaceId: string, projectId: string): Promise<readonly TestRun[]> {
    const results: TestRun[] = [];
    for (const run of this.runs.values()) {
      if (run.workspaceId === workspaceId && run.projectId === projectId) {
        results.push(clone(run));
      }
    }
    return results;
  }

  async listByWorkspace(workspaceId: string): Promise<readonly TestRun[]> {
    const results: TestRun[] = [];
    for (const run of this.runs.values()) {
      if (run.workspaceId === workspaceId) {
        results.push(clone(run));
      }
    }
    return results;
  }

  async create(run: TestRun): Promise<TestRun> {
    if (this.runs.has(run.id)) {
      throw new Error(`TestRun with ID "${run.id}" already exists.`);
    }
    this.runs.set(run.id, clone(run));
    return clone(run);
  }

  async update(run: TestRun): Promise<TestRun> {
    const existing = this.runs.get(run.id);
    if (!existing || existing.workspaceId !== run.workspaceId) {
      throw new Error(`TestRun with ID "${run.id}" does not exist in workspace "${run.workspaceId}".`);
    }
    this.runs.set(run.id, clone(run));
    return clone(run);
  }

  clear(): void {
    this.runs.clear();
  }
}

export class InMemoryArtifactRepository implements ArtifactRepository {
  private readonly artifacts = new Map<string, RunArtifact>();

  async findById(workspaceId: string, id: string): Promise<RunArtifact | null> {
    const art = this.artifacts.get(id);
    if (!art || art.workspaceId !== workspaceId) return null;
    return clone(art);
  }

  async listByRun(workspaceId: string, runId: string): Promise<readonly RunArtifact[]> {
    const results: RunArtifact[] = [];
    for (const art of this.artifacts.values()) {
      if (art.workspaceId === workspaceId && art.runId === runId) {
        results.push(clone(art));
      }
    }
    return results;
  }

  async create(artifact: RunArtifact): Promise<RunArtifact> {
    if (this.artifacts.has(artifact.id)) {
      throw new Error(`RunArtifact with ID "${artifact.id}" already exists.`);
    }
    this.artifacts.set(artifact.id, clone(artifact));
    return clone(artifact);
  }

  clear(): void {
    this.artifacts.clear();
  }
}

export class InMemoryCandidateRepository implements CandidateRepository {
  private readonly candidates = new Map<string, CandidateReference>();

  async findById(workspaceId: string, id: string): Promise<CandidateReference | null> {
    const cand = this.candidates.get(id);
    if (!cand || cand.workspaceId !== workspaceId) return null;
    return clone(cand);
  }

  async listByRun(workspaceId: string, runId: string): Promise<readonly CandidateReference[]> {
    const results: CandidateReference[] = [];
    for (const cand of this.candidates.values()) {
      if (cand.workspaceId === workspaceId && cand.runId === runId) {
        results.push(clone(cand));
      }
    }
    return results;
  }

  async listByProject(workspaceId: string, projectId: string): Promise<readonly CandidateReference[]> {
    const results: CandidateReference[] = [];
    for (const cand of this.candidates.values()) {
      if (cand.workspaceId === workspaceId && cand.projectId === projectId) {
        results.push(clone(cand));
      }
    }
    return results;
  }

  async create(candidate: CandidateReference): Promise<CandidateReference> {
    if (this.candidates.has(candidate.id)) {
      throw new Error(`CandidateReference with ID "${candidate.id}" already exists.`);
    }
    this.candidates.set(candidate.id, clone(candidate));
    return clone(candidate);
  }

  async update(candidate: CandidateReference): Promise<CandidateReference> {
    const existing = this.candidates.get(candidate.id);
    if (!existing || existing.workspaceId !== candidate.workspaceId) {
      throw new Error(`CandidateReference with ID "${candidate.id}" does not exist in workspace "${candidate.workspaceId}".`);
    }
    this.candidates.set(candidate.id, clone(candidate));
    return clone(candidate);
  }

  clear(): void {
    this.candidates.clear();
  }
}

export class InMemoryAuditRepository implements AuditRepository {
  private readonly audits: AuditEvent[] = [];

  async findById(workspaceId: string, id: string): Promise<AuditEvent | null> {
    const event = this.audits.find((a) => a.id === id && a.workspaceId === workspaceId);
    return event ? clone(event) : null;
  }

  async listByWorkspace(workspaceId: string, limit = 100): Promise<readonly AuditEvent[]> {
    const matching = this.audits
      .filter((a) => a.workspaceId === workspaceId)
      .slice(-limit)
      .reverse();
    return clone(matching);
  }

  async create(event: AuditEvent): Promise<AuditEvent> {
    this.audits.push(clone(event));
    return clone(event);
  }

  clear(): void {
    this.audits.length = 0;
  }
}

/** Convenience factory creating an isolated in-memory product repository suite. */
export function createInMemoryProductRepositories(): ProductRepositories {
  return {
    users: new InMemoryUserRepository(),
    workspaces: new InMemoryWorkspaceRepository(),
    memberships: new InMemoryMembershipRepository(),
    projects: new InMemoryProjectRepository(),
    targets: new InMemoryTargetRepository(),
    journeys: new InMemoryJourneyRepository(),
    runs: new InMemoryRunRepository(),
    artifacts: new InMemoryArtifactRepository(),
    candidates: new InMemoryCandidateRepository(),
    audits: new InMemoryAuditRepository(),
  };
}
