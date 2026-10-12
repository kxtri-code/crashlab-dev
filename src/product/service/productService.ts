/**
 * Product Service — Build 11: Hosted MVP Foundation.
 *
 * Core domain service enforcing:
 *  - Strict tenant boundary isolation
 *  - Role-based permissions
 *  - Secret-free entity creation
 *  - Comprehensive audit event logging
 *  - Non-negotiable trust invariants: safeTestMode, confirmed: false, confirmedBug: false.
 */

import type { User, CreateUserInput } from '../types/user.js';
import type { Workspace, WorkspaceMember, CreateWorkspaceInput, AddWorkspaceMemberInput, WorkspaceRole } from '../types/workspace.js';
import type { Project, CreateProjectInput } from '../types/project.js';
import type { TargetEnvironment, CreateTargetEnvironmentInput } from '../types/target.js';
import type { ProductApprovedJourney, CreateApprovedJourneyInput } from '../types/journey.js';
import type { TestRun, CreateTestRunInput, RunStatus } from '../types/run.js';
import type { RunArtifact, RegisterArtifactInput } from '../types/artifact.js';
import type { CandidateReference, RegisterCandidateReferenceInput, ProductCandidateStatus } from '../types/candidate.js';
import type { AuditEvent } from '../types/audit.js';
import type { ProductRepositories } from '../repository/interfaces.js';
import type { IdGenerator } from '../util/id.js';
import { defaultIdGenerator } from '../util/id.js';
import {
  canReadWorkspace,
  canManageWorkspace,
  canManageMembers,
  canManageProject,
  canConfigureTargets,
  canApproveJourneys,
  canRunProject,
  canViewReports,
  canReviewCandidate,
} from '../auth/permissions.js';
import { validateRunTransition, type TransitionContext } from '../lifecycle/runStateMachine.js';
import { validateProductTargetPreflight } from './preflightAdapter.js';
import { assertNoSecrets } from '../secrets/sanitizer.js';

export class TenantAccessDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantAccessDeniedError';
  }
}

export class EntityNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EntityNotFoundError';
  }
}

export class PreflightRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreflightRefusedError';
  }
}

export interface ProductServiceDependencies {
  readonly repositories: ProductRepositories;
  readonly idGenerator?: IdGenerator;
  readonly now?: () => Date;
}

export class ProductService {
  private readonly repos: ProductRepositories;
  private readonly ids: IdGenerator;
  private readonly clock: () => Date;

  constructor(deps: ProductServiceDependencies) {
    this.repos = deps.repositories;
    this.ids = deps.idGenerator ?? defaultIdGenerator;
    this.clock = deps.now ?? (() => new Date());
  }

  private timestamp(): string {
    return this.clock().toISOString();
  }

  private async getMembership(workspaceId: string, actorUserId: string): Promise<WorkspaceMember | null> {
    return this.repos.memberships.findByWorkspaceAndUser(workspaceId, actorUserId);
  }

  private async recordAudit(
    workspaceId: string,
    actorUserId: string,
    eventType: AuditEvent['eventType'],
    entityType: string,
    entityId: string,
    metadata: Record<string, unknown> = {},
  ): Promise<AuditEvent> {
    assertNoSecrets(metadata, 'Audit metadata');
    const event: AuditEvent = {
      id: this.ids.generateId('aud'),
      schemaVersion: '1.0',
      workspaceId,
      actorUserId,
      eventType,
      entityType,
      entityId,
      metadata: Object.freeze({ ...metadata }),
      timestamp: this.timestamp(),
    };
    return this.repos.audits.create(event);
  }

  // --- Users -----------------------------------------------------------------

  async createUser(input: CreateUserInput): Promise<User> {
    assertNoSecrets(input, 'User input');
    const ts = this.timestamp();
    const user: User = {
      id: this.ids.generateId('usr'),
      schemaVersion: '1.0',
      email: input.email.toLowerCase().trim(),
      name: input.name.trim(),
      status: 'active',
      createdAt: ts,
      updatedAt: ts,
    };
    return this.repos.users.create(user);
  }

  async getUser(userId: string): Promise<User | null> {
    return this.repos.users.findById(userId);
  }

  // --- Workspaces ------------------------------------------------------------

  async createWorkspace(input: CreateWorkspaceInput): Promise<{ workspace: Workspace; membership: WorkspaceMember }> {
    assertNoSecrets(input, 'Workspace input');
    const owner = await this.repos.users.findById(input.ownerUserId);
    if (!owner) {
      throw new EntityNotFoundError(`Owner user "${input.ownerUserId}" not found.`);
    }

    const ts = this.timestamp();
    const wsId = this.ids.generateId('ws');
    const workspace: Workspace = {
      id: wsId,
      schemaVersion: '1.0',
      name: input.name.trim(),
      slug: input.slug.toLowerCase().trim(),
      ownerUserId: input.ownerUserId,
      createdAt: ts,
      updatedAt: ts,
    };
    const createdWorkspace = await this.repos.workspaces.create(workspace);

    // Automatically add creator as 'owner'
    const member: WorkspaceMember = {
      id: this.ids.generateId('mem'),
      schemaVersion: '1.0',
      workspaceId: wsId,
      userId: input.ownerUserId,
      role: 'owner',
      createdAt: ts,
      updatedAt: ts,
    };
    const createdMember = await this.repos.memberships.create(member);

    await this.recordAudit(wsId, input.ownerUserId, 'workspace.created', 'workspace', wsId, {
      name: workspace.name,
      slug: workspace.slug,
    });

    return { workspace: createdWorkspace, membership: createdMember };
  }

  async listWorkspacesForUser(userId: string): Promise<readonly Workspace[]> {
    const memberships = await this.repos.memberships.listByUser(userId);
    const workspaces: Workspace[] = [];
    for (const m of memberships) {
      const ws = await this.repos.workspaces.findById(m.workspaceId);
      if (ws) workspaces.push(ws);
    }
    return workspaces;
  }

  async getWorkspace(workspaceId: string, actorUserId: string): Promise<Workspace> {
    const membership = await this.getMembership(workspaceId, actorUserId);
    if (!canReadWorkspace(membership, workspaceId)) {
      throw new TenantAccessDeniedError(`Access denied to workspace "${workspaceId}".`);
    }
    const ws = await this.repos.workspaces.findById(workspaceId);
    if (!ws) {
      throw new EntityNotFoundError(`Workspace "${workspaceId}" not found.`);
    }
    return ws;
  }

  async addMember(input: AddWorkspaceMemberInput, actorUserId: string): Promise<WorkspaceMember> {
    const membership = await this.getMembership(input.workspaceId, actorUserId);
    if (!canManageMembers(membership, input.workspaceId)) {
      throw new TenantAccessDeniedError(`Access denied: Actor cannot manage members in workspace "${input.workspaceId}".`);
    }

    const targetUser = await this.repos.users.findById(input.userId);
    if (!targetUser) {
      throw new EntityNotFoundError(`Target user "${input.userId}" not found.`);
    }

    const ts = this.timestamp();
    const member: WorkspaceMember = {
      id: this.ids.generateId('mem'),
      schemaVersion: '1.0',
      workspaceId: input.workspaceId,
      userId: input.userId,
      role: input.role,
      createdAt: ts,
      updatedAt: ts,
    };
    const created = await this.repos.memberships.create(member);

    await this.recordAudit(input.workspaceId, actorUserId, 'workspace.member_added', 'workspace_member', created.id, {
      targetUserId: input.userId,
      role: input.role,
    });

    return created;
  }

  async listMembers(workspaceId: string, actorUserId: string): Promise<readonly WorkspaceMember[]> {
    const membership = await this.getMembership(workspaceId, actorUserId);
    if (!canReadWorkspace(membership, workspaceId)) {
      throw new TenantAccessDeniedError(`Access denied to workspace "${workspaceId}".`);
    }
    return this.repos.memberships.listByWorkspace(workspaceId);
  }

  // --- Projects --------------------------------------------------------------

  async createProject(input: CreateProjectInput, actorUserId: string): Promise<Project> {
    assertNoSecrets(input, 'Project input');
    const membership = await this.getMembership(input.workspaceId, actorUserId);
    if (!canManageProject(membership, { workspaceId: input.workspaceId })) {
      throw new TenantAccessDeniedError(`Access denied: Actor cannot manage projects in workspace "${input.workspaceId}".`);
    }

    const ts = this.timestamp();
    const project: Project = {
      id: this.ids.generateId('prj'),
      schemaVersion: '1.0',
      workspaceId: input.workspaceId,
      name: input.name.trim(),
      description: input.description?.trim() ?? '',
      createdAt: ts,
      updatedAt: ts,
    };
    const created = await this.repos.projects.create(project);

    await this.recordAudit(input.workspaceId, actorUserId, 'project.created', 'project', created.id, {
      name: created.name,
    });

    return created;
  }

  async getProject(workspaceId: string, projectId: string, actorUserId: string): Promise<Project> {
    const membership = await this.getMembership(workspaceId, actorUserId);
    if (!canReadWorkspace(membership, workspaceId)) {
      throw new TenantAccessDeniedError(`Access denied to workspace "${workspaceId}".`);
    }
    const project = await this.repos.projects.findById(workspaceId, projectId);
    if (!project) {
      throw new EntityNotFoundError(`Project "${projectId}" not found in workspace "${workspaceId}".`);
    }
    return project;
  }

  async listProjects(workspaceId: string, actorUserId: string): Promise<readonly Project[]> {
    const membership = await this.getMembership(workspaceId, actorUserId);
    if (!canReadWorkspace(membership, workspaceId)) {
      throw new TenantAccessDeniedError(`Access denied to workspace "${workspaceId}".`);
    }
    return this.repos.projects.listByWorkspace(workspaceId);
  }

  // --- Target Environments ----------------------------------------------------

  async createTarget(input: CreateTargetEnvironmentInput, actorUserId: string): Promise<TargetEnvironment> {
    assertNoSecrets(input, 'Target input');
    const membership = await this.getMembership(input.workspaceId, actorUserId);
    if (!canConfigureTargets(membership, { workspaceId: input.workspaceId })) {
      throw new TenantAccessDeniedError(`Access denied: Actor cannot configure targets in workspace "${input.workspaceId}".`);
    }

    // Prohibit production environments
    if ((input.environment as string) === 'production') {
      throw new Error('Prohibited target environment: production is not allowed in CrashLab.');
    }

    // Verify project exists in this workspace
    const project = await this.repos.projects.findById(input.workspaceId, input.projectId);
    if (!project) {
      throw new EntityNotFoundError(`Project "${input.projectId}" not found in workspace "${input.workspaceId}".`);
    }

    // Resolve URL and origin
    const urlObj = new URL(input.targetUrl);
    const targetOrigin = urlObj.origin;

    const ts = this.timestamp();
    const target: TargetEnvironment = {
      id: this.ids.generateId('tgt'),
      schemaVersion: '1.0',
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      name: input.name.trim(),
      environment: input.environment,
      targetUrl: input.targetUrl,
      targetOrigin,
      allowedOrigins: Object.freeze([...input.allowedOrigins]),
      appBuildId: input.appBuildId,
      authorizationReference: input.authorizationReference,
      testDataReference: input.testDataReference,
      forbiddenActions: Object.freeze([...(input.forbiddenActions ?? ['checkout', 'payment', 'delete_account', 'change_password'])]),
      resetProcedure: input.resetProcedure,
      testingWindow: input.testingWindow,
      createdAt: ts,
      updatedAt: ts,
    };

    const created = await this.repos.targets.create(target);

    await this.recordAudit(input.workspaceId, actorUserId, 'target.configured', 'target_environment', created.id, {
      name: created.name,
      environment: created.environment,
      targetOrigin: created.targetOrigin,
    });

    return created;
  }

  async getTarget(workspaceId: string, targetId: string, actorUserId: string): Promise<TargetEnvironment> {
    const membership = await this.getMembership(workspaceId, actorUserId);
    if (!canReadWorkspace(membership, workspaceId)) {
      throw new TenantAccessDeniedError(`Access denied to workspace "${workspaceId}".`);
    }
    const target = await this.repos.targets.findById(workspaceId, targetId);
    if (!target) {
      throw new EntityNotFoundError(`Target "${targetId}" not found in workspace "${workspaceId}".`);
    }
    return target;
  }

  async listTargets(workspaceId: string, projectId: string, actorUserId: string): Promise<readonly TargetEnvironment[]> {
    const membership = await this.getMembership(workspaceId, actorUserId);
    if (!canReadWorkspace(membership, workspaceId)) {
      throw new TenantAccessDeniedError(`Access denied to workspace "${workspaceId}".`);
    }
    return this.repos.targets.listByProject(workspaceId, projectId);
  }

  // --- Approved Journeys -----------------------------------------------------

  async approveJourney(input: CreateApprovedJourneyInput, actorUserId: string): Promise<ProductApprovedJourney> {
    assertNoSecrets(input, 'Journey input');
    const membership = await this.getMembership(input.workspaceId, actorUserId);
    if (!canApproveJourneys(membership, { workspaceId: input.workspaceId })) {
      throw new TenantAccessDeniedError(`Access denied: Actor cannot approve journeys in workspace "${input.workspaceId}".`);
    }

    const target = await this.repos.targets.findById(input.workspaceId, input.targetEnvironmentId);
    if (!target) {
      throw new EntityNotFoundError(`Target "${input.targetEnvironmentId}" not found in workspace "${input.workspaceId}".`);
    }

    const ts = this.timestamp();
    const journey: ProductApprovedJourney = {
      id: this.ids.generateId('jny'),
      schemaVersion: '1.0',
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      targetEnvironmentId: input.targetEnvironmentId,
      goal: input.goal.trim(),
      origin: input.origin.trim(),
      allowedActions: Object.freeze([...input.allowedActions]),
      forbiddenActions: Object.freeze([...(input.forbiddenActions ?? target.forbiddenActions)]),
      requiresCredentials: Boolean(input.requiresCredentials),
      requiresTestData: Boolean(input.requiresTestData),
      createdAt: ts,
      updatedAt: ts,
    };

    const created = await this.repos.journeys.create(journey);

    await this.recordAudit(input.workspaceId, actorUserId, 'journey.approved', 'approved_journey', created.id, {
      goal: created.goal,
      origin: created.origin,
    });

    return created;
  }

  async listJourneys(workspaceId: string, targetId: string, actorUserId: string): Promise<readonly ProductApprovedJourney[]> {
    const membership = await this.getMembership(workspaceId, actorUserId);
    if (!canReadWorkspace(membership, workspaceId)) {
      throw new TenantAccessDeniedError(`Access denied to workspace "${workspaceId}".`);
    }
    return this.repos.journeys.listByTarget(workspaceId, targetId);
  }

  // --- Test Runs & Lifecycle -------------------------------------------------

  async createRun(input: CreateTestRunInput, actorUserId: string): Promise<TestRun> {
    assertNoSecrets(input, 'Run input');
    const membership = await this.getMembership(input.workspaceId, actorUserId);
    if (!canRunProject(membership, { workspaceId: input.workspaceId })) {
      throw new TenantAccessDeniedError(`Access denied: Actor cannot trigger runs in workspace "${input.workspaceId}".`);
    }

    const target = await this.repos.targets.findById(input.workspaceId, input.targetEnvironmentId);
    if (!target) {
      throw new EntityNotFoundError(`Target "${input.targetEnvironmentId}" not found in workspace "${input.workspaceId}".`);
    }

    const journey = await this.repos.journeys.findById(input.workspaceId, input.journeyId);
    if (!journey) {
      throw new EntityNotFoundError(`Journey "${input.journeyId}" not found in workspace "${input.workspaceId}".`);
    }

    const ts = this.timestamp();
    const run: TestRun = {
      id: this.ids.generateId('run'),
      schemaVersion: '1.0',
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      targetEnvironmentId: input.targetEnvironmentId,
      journeyId: input.journeyId,
      status: 'created',
      safeTestMode: true,
      preflightStatus: 'pending',
      createdAt: ts,
      updatedAt: ts,
    };

    const created = await this.repos.runs.create(run);

    await this.recordAudit(input.workspaceId, actorUserId, 'run.requested', 'test_run', created.id, {
      targetId: input.targetEnvironmentId,
      journeyId: input.journeyId,
    });

    return created;
  }

  async getRun(workspaceId: string, runId: string, actorUserId: string): Promise<TestRun> {
    const membership = await this.getMembership(workspaceId, actorUserId);
    if (!canReadWorkspace(membership, workspaceId)) {
      throw new TenantAccessDeniedError(`Access denied to workspace "${workspaceId}".`);
    }
    const run = await this.repos.runs.findById(workspaceId, runId);
    if (!run) {
      throw new EntityNotFoundError(`TestRun "${runId}" not found in workspace "${workspaceId}".`);
    }
    return run;
  }

  async listRunsByProject(workspaceId: string, projectId: string, actorUserId: string): Promise<readonly TestRun[]> {
    const membership = await this.getMembership(workspaceId, actorUserId);
    if (!canReadWorkspace(membership, workspaceId)) {
      throw new TenantAccessDeniedError(`Access denied to workspace "${workspaceId}".`);
    }
    return this.repos.runs.listByProject(workspaceId, projectId);
  }

  /**
   * Executes preflight safety validation for a run.
   * Transitions status to 'preflight', evaluates safety rules, and moves to
   * 'queued' if ready or 'blocked' if safety checks failed.
   */
  async evaluateRunPreflight(
    workspaceId: string,
    runId: string,
    actorUserId: string,
  ): Promise<{ run: TestRun; preflightResult: ReturnType<typeof validateProductTargetPreflight> }> {
    const run = await this.getRun(workspaceId, runId, actorUserId);

    // Transition created -> preflight
    const preflightCheck = validateRunTransition(run, 'preflight');
    if (!preflightCheck.valid) {
      throw new Error(preflightCheck.error);
    }

    const target = await this.getTarget(workspaceId, run.targetEnvironmentId, actorUserId);
    const journeys = await this.listJourneys(workspaceId, target.id, actorUserId);

    // Run Build 10.2 preflight validator
    const preflightResult = validateProductTargetPreflight(target, journeys);

    const ts = this.timestamp();
    let updatedRun: TestRun;

    if (preflightResult.status === 'ready') {
      // Transition preflight -> queued
      const queueCheck = validateRunTransition({ ...run, status: 'preflight', preflightStatus: 'ready' }, 'queued', { preflightReady: true });
      if (!queueCheck.valid) {
        throw new Error(queueCheck.error);
      }

      updatedRun = {
        ...run,
        status: 'queued',
        preflightStatus: 'ready',
        updatedAt: ts,
      };

      await this.repos.runs.update(updatedRun);
      await this.recordAudit(workspaceId, actorUserId, 'run.preflight_passed', 'test_run', runId, {
        targetOrigin: preflightResult.targetOrigin,
        checksPassed: preflightResult.checks.filter((c) => c.passed).length,
      });
    } else {
      // Preflight blocked or invalid -> transition to 'blocked'
      const blockedReason = preflightResult.failureReasons.join('; ') || 'Preflight safety checks failed.';
      updatedRun = {
        ...run,
        status: 'blocked',
        preflightStatus: preflightResult.status,
        blockedReason,
        updatedAt: ts,
      };

      await this.repos.runs.update(updatedRun);
      await this.recordAudit(workspaceId, actorUserId, 'run.preflight_blocked', 'test_run', runId, {
        reasons: preflightResult.failureReasons,
      });
    }

    return { run: updatedRun, preflightResult };
  }

  /**
   * Pure lifecycle transition with audit event generation.
   */
  async transitionRun(
    workspaceId: string,
    runId: string,
    nextStatus: RunStatus,
    context: TransitionContext,
    actorUserId: string,
  ): Promise<TestRun> {
    const run = await this.getRun(workspaceId, runId, actorUserId);
    const membership = await this.getMembership(workspaceId, actorUserId);

    if (!canRunProject(membership, { workspaceId })) {
      throw new TenantAccessDeniedError(`Access denied: Actor cannot transition runs in workspace "${workspaceId}".`);
    }

    const validation = validateRunTransition(run, nextStatus, context);
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    const ts = this.timestamp();
    const updatedRun: TestRun = {
      ...run,
      status: nextStatus,
      updatedAt: ts,
      startedAt: nextStatus === 'running' && !run.startedAt ? ts : run.startedAt,
      finishedAt: ['completed', 'partial', 'failed', 'blocked', 'cancelled'].includes(nextStatus) ? ts : run.finishedAt,
      failureReason: context.reason && nextStatus === 'failed' ? context.reason : run.failureReason,
      blockedReason: context.reason && nextStatus === 'blocked' ? context.reason : run.blockedReason,
      cancelReason: context.reason && nextStatus === 'cancelled' ? context.reason : run.cancelReason,
    };

    const saved = await this.repos.runs.update(updatedRun);

    if (validation.auditEventType) {
      await this.recordAudit(workspaceId, actorUserId, validation.auditEventType, 'test_run', runId, {
        previousStatus: run.status,
        newStatus: nextStatus,
        reason: context.reason,
      });
    }

    return saved;
  }

  // --- Candidate Findings & Review -------------------------------------------

  async registerCandidate(input: RegisterCandidateReferenceInput, actorUserId: string): Promise<CandidateReference> {
    assertNoSecrets(input, 'Candidate input');
    const membership = await this.getMembership(input.workspaceId, actorUserId);
    if (!canRunProject(membership, { workspaceId: input.workspaceId })) {
      throw new TenantAccessDeniedError(`Access denied to register candidates in workspace "${input.workspaceId}".`);
    }

    const ts = this.timestamp();
    const candidate: CandidateReference = {
      id: this.ids.generateId('candref'),
      schemaVersion: '1.0',
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      runId: input.runId,
      candidateId: input.candidateId,
      ruleId: input.ruleId,
      classification: input.classification,
      reproduced: input.reproduced,
      reviewStatus: input.reviewStatus ?? 'unreviewed',
      confirmed: false,
      confirmedBug: false,
      createdAt: ts,
      updatedAt: ts,
    };

    return this.repos.candidates.create(candidate);
  }

  async reviewCandidate(
    workspaceId: string,
    candidateId: string,
    status: ProductCandidateStatus,
    notes: string,
    actorUserId: string,
  ): Promise<CandidateReference> {
    const membership = await this.getMembership(workspaceId, actorUserId);
    if (!canReviewCandidate(membership, { workspaceId })) {
      throw new TenantAccessDeniedError(`Access denied: Actor does not have reviewer role in workspace "${workspaceId}".`);
    }

    const candidate = await this.repos.candidates.findById(workspaceId, candidateId);
    if (!candidate) {
      throw new EntityNotFoundError(`Candidate "${candidateId}" not found in workspace "${workspaceId}".`);
    }

    const ts = this.timestamp();
    const updated: CandidateReference = {
      ...candidate,
      reviewStatus: status,
      updatedAt: ts,
    };

    const saved = await this.repos.candidates.update(updated);

    await this.recordAudit(workspaceId, actorUserId, 'candidate.reviewed', 'candidate_reference', candidateId, {
      previousStatus: candidate.reviewStatus,
      newStatus: status,
      notes,
    });

    return saved;
  }

  async listCandidates(workspaceId: string, projectId: string, actorUserId: string): Promise<readonly CandidateReference[]> {
    const membership = await this.getMembership(workspaceId, actorUserId);
    if (!canViewReports(membership, { workspaceId })) {
      throw new TenantAccessDeniedError(`Access denied to view candidate reports in workspace "${workspaceId}".`);
    }
    return this.repos.candidates.listByProject(workspaceId, projectId);
  }

  // --- Run Artifacts ---------------------------------------------------------

  async registerArtifact(input: RegisterArtifactInput, actorUserId: string): Promise<RunArtifact> {
    assertNoSecrets(input, 'Artifact input');
    const membership = await this.getMembership(input.workspaceId, actorUserId);
    if (!canRunProject(membership, { workspaceId: input.workspaceId })) {
      throw new TenantAccessDeniedError(`Access denied to register artifacts in workspace "${input.workspaceId}".`);
    }

    const ts = this.timestamp();
    const artifact: RunArtifact = {
      id: this.ids.generateId('art'),
      schemaVersion: '1.0',
      workspaceId: input.workspaceId,
      runId: input.runId,
      type: input.type,
      storagePath: input.storagePath,
      byteSize: input.byteSize,
      sha256: input.sha256,
      contentType: input.contentType ?? 'application/json',
      createdAt: ts,
    };

    return this.repos.artifacts.create(artifact);
  }

  async listArtifacts(workspaceId: string, runId: string, actorUserId: string): Promise<readonly RunArtifact[]> {
    const membership = await this.getMembership(workspaceId, actorUserId);
    if (!canViewReports(membership, { workspaceId })) {
      throw new TenantAccessDeniedError(`Access denied to view artifacts in workspace "${workspaceId}".`);
    }
    return this.repos.artifacts.listByRun(workspaceId, runId);
  }

  // --- Audit Events ----------------------------------------------------------

  async listAuditEvents(workspaceId: string, actorUserId: string, limit = 50): Promise<readonly AuditEvent[]> {
    const membership = await this.getMembership(workspaceId, actorUserId);
    if (!canReadWorkspace(membership, workspaceId)) {
      throw new TenantAccessDeniedError(`Access denied to workspace "${workspaceId}".`);
    }
    return this.repos.audits.listByWorkspace(workspaceId, limit);
  }
}
