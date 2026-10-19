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

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { User, CreateUserInput } from '../types/user.js';
import type { Workspace, WorkspaceMember, CreateWorkspaceInput, AddWorkspaceMemberInput, WorkspaceRole } from '../types/workspace.js';
import type { Project, CreateProjectInput } from '../types/project.js';
import type { TargetEnvironment, CreateTargetEnvironmentInput, TargetAuthConfig, TargetAuthStrategy } from '../types/target.js';
import type { ProductApprovedJourney, CreateApprovedJourneyInput } from '../types/journey.js';
import type { TestRun, CreateTestRunInput, RunStatus } from '../types/run.js';
import type { RunArtifact, RegisterArtifactInput, StoreArtifactInput } from '../types/artifact.js';
import type { CandidateReference, RegisterCandidateReferenceInput, ProductCandidateStatus, CandidateReproductionStatus, CandidateReproductionDetails } from '../types/candidate.js';
import type { AuditEvent } from '../types/audit.js';
import type { ProductRepositories } from '../repository/interfaces.js';
import type { BlobStore, BlobLocator, BlobMetadata, BlobPayload } from '../blob/interfaces.js';
import { resolveBlobStore } from '../blob/config.js';
import { reproduceSignals } from '../../reproducer/reproducer.js';
import type { ReproductionReport } from '../../reproducer/types.js';
import type { JourneyPlan } from '../../journey/types.js';
import type { ExecutionReport } from '../../executor/types.js';
import type { AnomalyReport } from '../../anomaly/report.js';
import type { AnomalyKind, EvidenceType } from '../../anomaly/types.js';
import type { RunQueueRepository } from '../queue/repository.js';
import { InMemoryRunQueueRepository } from '../queue/repository.js';
import type { RunQueueItem } from '../queue/types.js';
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
import type { SafetyGateStatus } from '../../preflight/types.js';
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

export class InvalidEntityRelationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidEntityRelationError';
  }
}

export class PreflightRefusedError extends Error {
  readonly failureReasons: readonly string[];
  readonly preflightStatus: SafetyGateStatus;

  constructor(message: string, failureReasons: readonly string[] = [], status: SafetyGateStatus = 'blocked') {
    super(message);
    this.name = 'PreflightRefusedError';
    this.failureReasons = failureReasons;
    this.preflightStatus = status;
  }
}

export class ReproductionConcurrencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReproductionConcurrencyError';
  }
}

export interface ProductServiceDependencies {
  readonly repositories: ProductRepositories;
  readonly runQueue?: RunQueueRepository;
  readonly blobStore?: BlobStore;
  readonly idGenerator?: IdGenerator;
  readonly now?: () => Date;
  readonly reproduceSignalsFn?: typeof reproduceSignals;
}

export class ProductService {
  private readonly repos: ProductRepositories;
  private readonly queue: RunQueueRepository;
  private readonly blobs: BlobStore;
  private readonly ids: IdGenerator;
  private readonly clock: () => Date;
  private readonly reproduceSignalsFn: typeof reproduceSignals;
  private activeReproductionRunId: string | null = null;

  constructor(deps: ProductServiceDependencies) {
    this.repos = deps.repositories;
    this.queue = deps.runQueue ?? deps.repositories.queue ?? new InMemoryRunQueueRepository();
    this.blobs = deps.blobStore ?? resolveBlobStore();
    this.ids = deps.idGenerator ?? defaultIdGenerator;
    this.clock = deps.now ?? (() => new Date());
    this.reproduceSignalsFn = deps.reproduceSignalsFn ?? reproduceSignals;
  }

  get blobStore(): BlobStore {
    return this.blobs;
  }

  get runQueue(): RunQueueRepository {
    return this.queue;
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

  async recordSecurityEvent(
    workspaceId: string,
    actorUserId: string,
    eventType: AuditEvent['eventType'],
    entityType: string,
    entityId: string,
    metadata: Record<string, unknown> = {},
  ): Promise<AuditEvent> {
    return this.recordAudit(workspaceId, actorUserId, eventType, entityType, entityId, metadata);
  }

  /** Checks database connectivity safely without exposing credentials. */
  async checkDatabaseConnectivity(): Promise<boolean> {
    try {
      await this.repos.users.findById('__health_probe__');
      return true;
    } catch {
      return false;
    }
  }

  /** Checks storage provider readiness safely. */
  async checkStorageReadiness(): Promise<boolean> {
    try {
      await this.blobs.exists({
        workspaceId: 'ws_health',
        projectId: 'prj_health',
        runId: 'run_health',
        artifactId: 'art_health',
      });
      return true;
    } catch {
      return false;
    }
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

    const authConfig: TargetAuthConfig = input.authConfig
      ? {
          strategy: input.authConfig.strategy || 'public',
          credentialReference: input.authConfig.credentialReference?.trim() || undefined,
          headerName: input.authConfig.headerName?.trim() || undefined,
          usernameReference: input.authConfig.usernameReference?.trim() || undefined,
          description: input.authConfig.description?.trim() || undefined,
          credentialConfigured: input.authConfig.credentialReference
            ? Boolean(process.env[input.authConfig.credentialReference.trim()])
            : undefined,
        }
      : { strategy: 'public' };

    let testDataReference = input.testDataReference;
    if (!testDataReference && authConfig.strategy !== 'public') {
      testDataReference = `auth:${JSON.stringify(authConfig)}`;
    }

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
      authConfig,
      authorizationReference: input.authorizationReference,
      testDataReference,
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
      authStrategy: authConfig.strategy,
    });

    return this.enrichTarget(created);
  }

  private enrichTarget(target: TargetEnvironment): TargetEnvironment {
    let authConfig = target.authConfig;
    if (!authConfig && target.testDataReference && target.testDataReference.startsWith('auth:')) {
      try {
        authConfig = JSON.parse(target.testDataReference.slice(5));
      } catch {}
    }
    if (authConfig) {
      const configured = authConfig.credentialReference
        ? Boolean(process.env[authConfig.credentialReference.trim()])
        : undefined;
      return {
        ...target,
        authConfig: {
          ...authConfig,
          credentialConfigured: configured,
        },
      };
    }
    return {
      ...target,
      authConfig: { strategy: 'public' },
    };
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
    return this.enrichTarget(target);
  }

  async listTargets(workspaceId: string, projectId: string, actorUserId: string): Promise<readonly TargetEnvironment[]> {
    const membership = await this.getMembership(workspaceId, actorUserId);
    if (!canReadWorkspace(membership, workspaceId)) {
      throw new TenantAccessDeniedError(`Access denied to workspace "${workspaceId}".`);
    }
    const targets = await this.repos.targets.listByProject(workspaceId, projectId);
    return targets.map((t) => this.enrichTarget(t));
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

  async getJourney(workspaceId: string, journeyId: string, actorUserId: string): Promise<ProductApprovedJourney> {
    const membership = await this.getMembership(workspaceId, actorUserId);
    if (!canReadWorkspace(membership, workspaceId)) {
      throw new TenantAccessDeniedError(`Access denied to workspace "${workspaceId}".`);
    }
    const journey = await this.repos.journeys.findById(workspaceId, journeyId);
    if (!journey) {
      throw new EntityNotFoundError(`Journey "${journeyId}" not found in workspace "${workspaceId}".`);
    }
    return journey;
  }

  async listJourneysByProject(workspaceId: string, projectId: string, actorUserId: string): Promise<readonly ProductApprovedJourney[]> {
    const membership = await this.getMembership(workspaceId, actorUserId);
    if (!canReadWorkspace(membership, workspaceId)) {
      throw new TenantAccessDeniedError(`Access denied to workspace "${workspaceId}".`);
    }
    const targets = await this.repos.targets.listByProject(workspaceId, projectId);
    const results: ProductApprovedJourney[] = [];
    for (const t of targets) {
      const list = await this.repos.journeys.listByTarget(workspaceId, t.id);
      results.push(...list);
    }
    return results;
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

  /**
   * Enqueues a product TestRun for asynchronous worker claiming and execution.
   * Creates a queued TestRun and persists an atomic RunQueueItem.
   */
  async enqueueRun(
    input: CreateTestRunInput,
    actorUserId: string,
  ): Promise<{ run: TestRun; queueItem: RunQueueItem }> {
    assertNoSecrets(input, 'CreateTestRunInput');
    const membership = await this.getMembership(input.workspaceId, actorUserId);
    if (!canRunProject(membership, { workspaceId: input.workspaceId })) {
      throw new TenantAccessDeniedError(`Access denied: Actor cannot trigger runs in workspace "${input.workspaceId}".`);
    }

    const target = await this.repos.targets.findById(input.workspaceId, input.targetEnvironmentId);
    if (!target) {
      throw new EntityNotFoundError(`Target "${input.targetEnvironmentId}" not found in workspace "${input.workspaceId}".`);
    }
    if (target.projectId !== input.projectId) {
      throw new InvalidEntityRelationError(`Target "${input.targetEnvironmentId}" does not belong to project "${input.projectId}".`);
    }

    const journey = await this.repos.journeys.findById(input.workspaceId, input.journeyId);
    if (!journey) {
      throw new EntityNotFoundError(`Journey "${input.journeyId}" not found in workspace "${input.workspaceId}".`);
    }
    if (journey.projectId !== input.projectId || journey.targetEnvironmentId !== input.targetEnvironmentId) {
      throw new InvalidEntityRelationError(`Journey "${input.journeyId}" does not belong to target environment "${input.targetEnvironmentId}".`);
    }

    if (
      !journey.schemaVersion ||
      journey.schemaVersion !== '1.0' ||
      !journey.goal ||
      typeof journey.goal !== 'string' ||
      !journey.origin ||
      !Array.isArray(journey.allowedActions) ||
      !Array.isArray(journey.forbiddenActions)
    ) {
      throw new InvalidEntityRelationError(`Journey "${input.journeyId}" is malformed or invalid schema.`);
    }

    // Optional preflight enforcement before enqueuing
    if (input.validatePreflight) {
      if ((input as unknown as { safeTestMode?: boolean }).safeTestMode === false) {
        throw new PreflightRefusedError('Safe-test mode cannot be disabled.', ['Safe-test mode is disabled.']);
      }

      const preflightResult = validateProductTargetPreflight(target, [journey]);
      if (preflightResult.status !== 'ready') {
        const failureReasons = preflightResult.failureReasons;
        await this.recordAudit(input.workspaceId, actorUserId, 'run.preflight_blocked', 'test_run', `refused-${Date.now()}`, {
          targetId: target.id,
          journeyId: journey.id,
          reasons: failureReasons,
        });
        throw new PreflightRefusedError(
          preflightResult.failureReasons.join('; ') || 'Preflight safety checks failed.',
          failureReasons,
          preflightResult.status,
        );
      }
    }

    const ts = this.timestamp();
    const runId = this.ids.generateId('run');
    const maxAttempts = input.maxAttempts !== undefined && input.maxAttempts > 0 ? input.maxAttempts : 1;

    const run: TestRun = {
      id: runId,
      schemaVersion: '1.0',
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      targetEnvironmentId: input.targetEnvironmentId,
      journeyId: input.journeyId,
      status: 'queued',
      safeTestMode: true,
      preflightStatus: 'pending',
      attemptCount: 1,
      maxAttempts,
      availableAt: ts,
      requestId: input.requestId,
      createdAt: ts,
      updatedAt: ts,
    };

    const queueItem: RunQueueItem = {
      runId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      targetId: input.targetEnvironmentId,
      journeyId: input.journeyId,
      queueStatus: 'queued',
      attemptCount: 1,
      maxAttempts,
      availableAt: ts,
      leaseOwner: null,
      leaseExpiry: null,
      startedAt: null,
      completedAt: null,
      lastError: null,
      cancellationTimestamp: null,
      requestId: input.requestId ?? null,
      createdAt: ts,
      updatedAt: ts,
    };

    const createdRun = await this.repos.runs.create(run);
    const createdQueueItem = await this.queue.enqueue(queueItem);

    await this.recordAudit(input.workspaceId, actorUserId, 'run.queued', 'test_run', createdRun.id, {
      targetId: input.targetEnvironmentId,
      journeyId: input.journeyId,
      requestId: input.requestId,
    });

    return { run: createdRun, queueItem: createdQueueItem };
  }

  /**
   * Idempotently cancels a queued or running TestRun.
   */
  async cancelRun(
    workspaceId: string,
    runId: string,
    actorUserId: string,
    reason?: string,
  ): Promise<TestRun> {
    const membership = await this.getMembership(workspaceId, actorUserId);
    if (!canRunProject(membership, { workspaceId })) {
      throw new TenantAccessDeniedError(`Access denied: Actor cannot cancel runs in workspace "${workspaceId}".`);
    }

    const run = await this.repos.runs.findById(workspaceId, runId);
    if (!run) {
      throw new EntityNotFoundError(`TestRun "${runId}" not found in workspace "${workspaceId}".`);
    }

    // Idempotent cancellation: if already cancelled, return cleanly
    if (run.status === 'cancelled') {
      return run;
    }

    // Immutable terminal states
    if (run.status === 'completed' || run.status === 'partial' || run.status === 'blocked') {
      throw new Error(`Cannot cancel run in terminal status "${run.status}". Terminal states are immutable.`);
    }

    const ts = this.timestamp();
    const cancelReason = reason?.trim() || 'Run was cancelled.';

    if (run.status === 'running') {
      // Transition running -> cancelling
      const updatedRun: TestRun = {
        ...run,
        status: 'cancelling',
        cancelReason,
        cancelledAt: ts,
        updatedAt: ts,
      };
      const saved = await this.repos.runs.update(updatedRun);

      const queueItem = await this.queue.findByRunId(workspaceId, runId);
      if (queueItem) {
        await this.queue.update({
          ...queueItem,
          queueStatus: 'cancelling',
          cancellationTimestamp: ts,
          updatedAt: ts,
        });
      }

      await this.recordAudit(workspaceId, actorUserId, 'run.transitioned', 'test_run', runId, {
        previousStatus: 'running',
        newStatus: 'cancelling',
        reason: cancelReason,
      });

      return saved;
    }

    // If 'cancelling', return existing (idempotent)
    if (run.status === 'cancelling') {
      return run;
    }

    // If 'queued' or 'created' or 'preflight'
    const updatedRun: TestRun = {
      ...run,
      status: 'cancelled',
      cancelReason,
      cancelledAt: ts,
      finishedAt: ts,
      updatedAt: ts,
    };
    const saved = await this.repos.runs.update(updatedRun);

    const queueItem = await this.queue.findByRunId(workspaceId, runId);
    if (queueItem) {
      await this.queue.update({
        ...queueItem,
        queueStatus: 'cancelled',
        cancellationTimestamp: ts,
        completedAt: ts,
        updatedAt: ts,
      });
      if (queueItem.leaseOwner) {
        await this.queue.releaseLease(runId, queueItem.leaseOwner);
      }
    }

    await this.recordAudit(workspaceId, actorUserId, 'run.cancelled', 'test_run', runId, {
      reason: cancelReason,
    });

    return saved;
  }

  /**
   * Explicitly retries a failed TestRun if attempt limits allow.
   * Safety-blocked or completed runs cannot be retried.
   */
  async retryRun(
    workspaceId: string,
    runId: string,
    actorUserId: string,
  ): Promise<{ run: TestRun; queueItem: RunQueueItem }> {
    const membership = await this.getMembership(workspaceId, actorUserId);
    if (!canRunProject(membership, { workspaceId })) {
      throw new TenantAccessDeniedError(`Access denied: Actor cannot retry runs in workspace "${workspaceId}".`);
    }

    const run = await this.repos.runs.findById(workspaceId, runId);
    if (!run) {
      throw new EntityNotFoundError(`TestRun "${runId}" not found in workspace "${workspaceId}".`);
    }

    // Safety and terminal checks
    if (run.status === 'blocked') {
      throw new Error('Safety-blocked runs cannot be retried.');
    }
    if (run.status === 'cancelled') {
      throw new Error('Cancelled runs cannot be retried.');
    }
    if (run.status === 'completed' || run.status === 'partial') {
      throw new Error(`Cannot retry run with terminal status "${run.status}".`);
    }
    if (run.status !== 'failed') {
      throw new Error(`Cannot retry run with status "${run.status}". Only failed runs can be retried.`);
    }

    const queueItem = await this.queue.findByRunId(workspaceId, runId);
    const currentAttempts = queueItem?.attemptCount ?? run.attemptCount ?? 1;
    const maxAttempts = queueItem?.maxAttempts ?? run.maxAttempts ?? 1;

    if (currentAttempts >= maxAttempts) {
      throw new Error(`Cannot retry run: maximum attempts (${maxAttempts}) reached.`);
    }

    const validation = validateRunTransition(run, 'queued', { explicitRetry: true });
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    const nextAttempt = currentAttempts + 1;
    const ts = this.timestamp();

    const updatedRun: TestRun = {
      ...run,
      status: 'queued',
      attemptCount: nextAttempt,
      maxAttempts,
      lastError: run.failureReason,
      failureReason: undefined,
      updatedAt: ts,
    };
    const savedRun = await this.repos.runs.update(updatedRun);

    let savedQueueItem: RunQueueItem;
    if (queueItem) {
      savedQueueItem = await this.queue.update({
        ...queueItem,
        queueStatus: 'queued',
        attemptCount: nextAttempt,
        maxAttempts,
        availableAt: ts,
        leaseOwner: null,
        leaseExpiry: null,
        startedAt: null,
        completedAt: null,
        lastError: run.failureReason ?? queueItem.lastError,
        updatedAt: ts,
      });
    } else {
      savedQueueItem = await this.queue.enqueue({
        runId: run.id,
        workspaceId: run.workspaceId,
        projectId: run.projectId,
        targetId: run.targetEnvironmentId,
        journeyId: run.journeyId,
        queueStatus: 'queued',
        attemptCount: nextAttempt,
        maxAttempts,
        availableAt: ts,
        leaseOwner: null,
        leaseExpiry: null,
        startedAt: null,
        completedAt: null,
        lastError: run.failureReason ?? null,
        cancellationTimestamp: null,
        requestId: run.requestId ?? null,
        createdAt: run.createdAt,
        updatedAt: ts,
      });
    }

    await this.recordAudit(workspaceId, actorUserId, 'run.retried', 'test_run', runId, {
      attemptCount: nextAttempt,
      maxAttempts,
    });

    return { run: savedRun, queueItem: savedQueueItem };
  }

  /**
   * Retrieves queue metadata for a run within a workspace.
   */
  async getRunQueueItem(
    workspaceId: string,
    runId: string,
    actorUserId: string,
  ): Promise<RunQueueItem | null> {
    const membership = await this.getMembership(workspaceId, actorUserId);
    if (!canReadWorkspace(membership, workspaceId)) {
      throw new TenantAccessDeniedError(`Access denied to workspace "${workspaceId}".`);
    }
    return this.queue.findByRunId(workspaceId, runId);
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

  private enrichCandidateWithReproduction(
    candidate: CandidateReference,
    reproReport?: ReproductionReport | null,
  ): CandidateReference {
    if (!reproReport) {
      if (candidate.reproductionDetails && candidate.reproductionStatus) {
        return candidate;
      }
      return {
        ...candidate,
        reproductionStatus: 'not-tested',
        reproduced: false,
        reproductionRatio: 'Not tested',
        reproductionDetails: {
          state: 'not-tested',
          attemptsRequested: 0,
          attemptsCompleted: 0,
          signalsEvaluated: 0,
          signalsReproduced: 0,
          recurrenceRatio: '0/0',
          finalClassification: 'not-tested',
        },
      };
    }

    const match = reproReport.results.find((r) => {
      if (r.anomalyId && (r.anomalyId === candidate.candidateId || r.anomalyId === candidate.id)) return true;
      if (r.ruleId && r.ruleId === candidate.ruleId) return true;
      return false;
    });

    const attemptsRequested = reproReport.reproducer?.attemptsRequested ?? 3;
    const attemptsCompleted = reproReport.reproducer?.attemptsCompleted ?? 0;
    const attemptsFailed = reproReport.reproducer?.attemptsFailed ?? Math.max(0, attemptsRequested - attemptsCompleted);

    const failedRun = reproReport.runs?.find((r) => r.detail);
    const runFailureReason =
      failedRun?.detail ||
      (attemptsFailed > 0
        ? `${attemptsFailed} attempt(s) failed or were blocked.`
        : undefined);

    if (!match) {
      const state: CandidateReproductionStatus =
        attemptsCompleted > 0 ? 'not-reproduced' : 'inconclusive';
      return {
        ...candidate,
        reproductionStatus: state,
        reproduced: false,
        reproductionRatio:
          attemptsCompleted > 0 ? `0/${attemptsCompleted}` : '0/0',
        reproductionDetails: {
          state,
          attemptsRequested,
          attemptsCompleted,
          signalsEvaluated: reproReport.summary.eligibleSignals,
          signalsReproduced: reproReport.summary.reproduced,
          recurrenceRatio:
            attemptsCompleted > 0 ? `0/${attemptsCompleted}` : '0/0',
          finalClassification: state,
          operatorReason: runFailureReason || 'No matching signal evaluated during reproduction rerun.',
        },
      };
    }

    const state: CandidateReproductionStatus =
      match.classification === 'reproduced'
        ? 'reproduced'
        : match.classification === 'not-reproduced'
        ? 'not-reproduced'
        : 'inconclusive';

    const operatorReason = runFailureReason || (state !== 'reproduced' ? match.reason : undefined);

    return {
      ...candidate,
      reproductionStatus: state,
      reproduced: state === 'reproduced',
      reproductionRatio: match.reproductionRatio,
      reproductionDetails: {
        state,
        attemptsRequested,
        attemptsCompleted,
        signalsEvaluated: reproReport.summary.eligibleSignals,
        signalsReproduced: reproReport.summary.reproduced,
        recurrenceRatio: match.reproductionRatio,
        finalClassification: match.classification,
        ...(operatorReason ? { operatorReason } : {}),
      },
    };
  }

  async listCandidates(workspaceId: string, projectId: string, actorUserId: string): Promise<readonly CandidateReference[]> {
    const membership = await this.getMembership(workspaceId, actorUserId);
    if (!canViewReports(membership, { workspaceId })) {
      throw new TenantAccessDeniedError(`Access denied to view candidate reports in workspace "${workspaceId}".`);
    }
    const candidates = await this.repos.candidates.listByProject(workspaceId, projectId);
    return candidates.map((c) => this.enrichCandidateWithReproduction(c, null));
  }

  async listCandidatesByRun(workspaceId: string, runId: string, actorUserId: string): Promise<readonly CandidateReference[]> {
    const membership = await this.getMembership(workspaceId, actorUserId);
    if (!canViewReports(membership, { workspaceId })) {
      throw new TenantAccessDeniedError(`Access denied to view candidate reports in workspace "${workspaceId}".`);
    }
    const candidates = await this.repos.candidates.listByRun(workspaceId, runId);
    let reproReport: ReproductionReport | null = null;
    try {
      const run = await this.getRun(workspaceId, runId, actorUserId);
      const artifacts = await this.repos.artifacts.listByRun(workspaceId, runId);
      const reproArts = artifacts
        .filter((a) => a.type === 'reproduction')
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const targetArtId = run.reproductionReportRef || reproArts[0]?.id;
      if (targetArtId) {
        const { payload } = await this.getArtifactContent(workspaceId, targetArtId, actorUserId);
        reproReport = JSON.parse(payload.content.toString('utf8')) as ReproductionReport;
      }
    } catch {
      // Repro report lookup is best-effort enrichment
    }
    return candidates.map((c) => this.enrichCandidateWithReproduction(c, reproReport));
  }

  /**
   * Runs bounded reproduction (strict max 3 attempts) for eligible candidates in a run.
   *
   * Guarantees:
   * - Strict bounds: at most 3 attempts, fresh browser contexts for each attempt.
   * - Safe-test mode permanently active, no destructive actions.
   * - Invariants strictly preserved: confirmedBug: false, confirmed: false.
   * - Saves 'reproduction' artifact and updates candidate reproduction states.
   */
  async runBoundedReproduction(
    workspaceId: string,
    runId: string,
    actorUserId: string,
    options?: {
      attempts?: number;
      candidateId?: string;
    },
  ): Promise<{
    reproductionReport: ReproductionReport;
    candidates: readonly CandidateReference[];
  }> {
    const membership = await this.getMembership(workspaceId, actorUserId);
    if (!canRunProject(membership, { workspaceId })) {
      throw new TenantAccessDeniedError(`Access denied: Actor cannot run reproduction in workspace "${workspaceId}".`);
    }

    const run = await this.getRun(workspaceId, runId, actorUserId);
    const target = await this.getTarget(workspaceId, run.targetEnvironmentId, actorUserId);
    const journey = await this.getJourney(workspaceId, run.journeyId, actorUserId);

    const candidates = await this.repos.candidates.listByRun(workspaceId, runId);
    if (candidates.length === 0) {
      throw new Error(`No candidate findings found for run "${runId}" to reproduce.`);
    }

    // Concurrency guard: limit in-flight reproductions on API container (Requirement 7)
    if (this.activeReproductionRunId) {
      throw new ReproductionConcurrencyError(
        `A bounded reproduction is already executing for run "${this.activeReproductionRunId}". To prevent API container resource exhaustion, concurrent reproductions are limited to 1 at a time. Please wait for the active reproduction to complete.`
      );
    }
    this.activeReproductionRunId = runId;

    try {
      // Strict maximum of 3 attempts enforcement (Requirement 3)
      const requestedAttempts = options?.attempts ?? 3;
    const boundedAttempts = Math.min(3, Math.max(1, requestedAttempts));

    // Retrieve or construct anomaly report
    const artifacts = await this.repos.artifacts.listByRun(workspaceId, runId);
    const anomArtifact = artifacts.find((a) => a.type === 'anomalies');
    let anomalyReport: AnomalyReport;

    if (anomArtifact) {
      const { payload } = await this.getArtifactContent(workspaceId, anomArtifact.id, actorUserId);
      anomalyReport = JSON.parse(payload.content.toString('utf8')) as AnomalyReport;
    } else {
      // Synthesize anomaly report from candidate references
      anomalyReport = {
        schemaVersion: '1.0',
        executionReport: `runs/${runId}/execution.json`,
        journeyReport: `journeys/${journey.id}.json`,
        executionStatus: 'passed',
        goal: journey.goal,
        journeyType: 'custom',
        summary: {
          totalSignals: candidates.length,
          httpErrors: candidates.filter((c) => c.ruleId.includes('HTTP')).length,
          networkFailures: candidates.filter((c) => c.ruleId.includes('NETWORK')).length,
          consoleErrors: candidates.filter((c) => c.ruleId.includes('CONSOLE')).length,
          pageErrors: 0,
          timeouts: 0,
          navigationSignals: 0,
          uiStateSignals: 0,
          duplicateRequestSignals: 0,
          stepFailureSignals: 0,
          ruleIds: [...new Set(candidates.map((c) => c.ruleId))].sort(),
        },
        anomalies: candidates.map((c, idx) => ({
          id: c.candidateId || c.id,
          ruleId: c.ruleId as any,
          kind: (c.ruleId.includes('HTTP') ? 'network-failure' : 'console') as AnomalyKind,
          signalLevel: 'error',
          status: 'observed',
          message: `Observed candidate finding ${c.ruleId}`,
          stepId: null,
          stepOrder: null,
          source: { executionReport: `runs/${runId}/execution.json`, evidenceType: (c.ruleId.includes('HTTP') ? 'network' : 'console') as EvidenceType, eventIndex: idx },
          details: { classification: c.classification },
          possiblyExpected: false,
          confirmed: false,
          occurrences: 1,
        })),
        warnings: [],
        analyzer: { mode: 'deterministic', version: '0.1.0' },
        environment: {
          fingerprint: null,
          origin: target.targetOrigin || 'unknown',
          browserName: 'Chromium',
          browserVersion: 'unknown',
          environmentId: target.environment ?? null,
          applicationBuildId: target.appBuildId ?? null,
        },
        interpretation: { confirmedBug: false, requiresInvestigation: true, note: 'reproduction-candidate' },
      };
    }

    // Build journey plan
    const isStagingPilot =
      journey.goal.toLowerCase().includes('staging') ||
      journey.goal.toLowerCase().includes('pilot') ||
      journey.goal.toLowerCase().includes('interact');

    const allowsInteraction = journey.allowedActions.some((a) =>
      ['click', 'interact', 'probe'].includes(a.toLowerCase().trim()),
    );

    const defaultSteps: any[] = [
      {
        id: 'step-001',
        order: 1,
        intent: 'navigate_to_origin',
        action: 'navigate',
        description: `Navigate to target environment origin ${target.targetUrl}`,
        targetElementIds: [],
        locatorCandidates: [],
        expectedOutcome: 'Page loads with HTTP 200 and DOM ready',
        confidence: 1.0,
        executable: false,
        source: { report: 'synthetic', elementIds: [] },
        isFallback: false,
      },
    ];

    if (isStagingPilot && allowsInteraction) {
      defaultSteps.push({
        id: 'step-002',
        order: 2,
        intent: 'trigger_interaction',
        action: 'click',
        description: 'Trigger staging pilot interaction and controlled probe',
        targetElementIds: ['btn-interact'],
        locatorCandidates: ['#btn-interact', 'button#btn-interact'],
        expectedOutcome: 'Staging pilot responds to interaction and triggers controlled probe',
        confidence: 1.0,
        executable: false,
        source: { report: 'synthetic', elementIds: ['btn-interact'] },
        isFallback: false,
      });
    }

    const plan: JourneyPlan = (journey as any).plan ?? {
      schemaVersion: '1.0',
      goal: journey.goal,
      normalizedGoal: journey.goal.toLowerCase().trim(),
      journeyType: 'custom',
      target: {
        url: target.targetUrl,
        finalUrl: target.targetUrl,
        title: target.name,
      },
      steps: (journey as any).steps ?? defaultSteps,
      assumptions: [],
      warnings: [],
      missingInformation: [],
      planner: { mode: 'heuristic', version: '0.1.0' },
    };

    // Execute bounded reproduction with fresh browser contexts
    const reproReport = await this.reproduceSignalsFn({
      anomalies: anomalyReport,
      journey: plan,
      attempts: boundedAttempts,
      authorized: true,
      anomalyPath: `runs/${runId}/anomalies.json`,
      journeyPath: `journeys/${journey.id}.json`,
      executionPath: `runs/${runId}/execution.json`,
      includePossiblyExpected: false,
      outputDir: join(tmpdir(), `repro-${runId}-${Date.now()}`),
      provenance: {
        environmentId: target.environment,
        appBuildId: target.appBuildId,
      },
    });

    // Invariant checks: confirmedBug: false must be preserved
    if ((reproReport.interpretation as any).confirmedBug !== false) {
      throw new Error('Trust invariant violation: confirmedBug must remain false.');
    }

    // Persist reproduction artifact
    const storedArt = await this.storeArtifact(
      {
        workspaceId,
        runId,
        type: 'reproduction',
        content: Buffer.from(JSON.stringify(reproReport, null, 2), 'utf8'),
        contentType: 'application/json',
      },
      actorUserId,
    );

    // Update test_run reproduction report ref
    await this.repos.runs.update({
      ...run,
      reproductionReportRef: storedArt.artifact.id,
      updatedAt: this.timestamp(),
    });

    // Update candidate references in repository
    const updatedCandidates: CandidateReference[] = [];
    for (const cand of candidates) {
      const enriched = this.enrichCandidateWithReproduction(cand, reproReport);
      const updatedCand: CandidateReference = {
        ...cand,
        reproduced: enriched.reproduced,
        reproductionStatus: enriched.reproductionStatus,
        reproductionRatio: enriched.reproductionRatio,
        reproductionDetails: enriched.reproductionDetails,
        updatedAt: this.timestamp(),
      };
      const saved = await this.repos.candidates.update(updatedCand);
      updatedCandidates.push(saved);
    }

    // Record audit event
    await this.recordAudit(workspaceId, actorUserId, 'run.reproduced', 'test_run', runId, {
      attemptsRequested: requestedAttempts,
      attemptsCompleted: reproReport.reproducer?.attemptsCompleted ?? requestedAttempts,
      signalsEvaluated: reproReport.summary.eligibleSignals,
      signalsReproduced: reproReport.summary.reproduced,
      summary: reproReport.summary,
    });

      return {
        reproductionReport: reproReport,
        candidates: updatedCandidates,
      };
    } finally {
      this.activeReproductionRunId = null;
    }
  }

  // --- Run Artifacts ---------------------------------------------------------

  /**
   * Stores a physical artifact blob and records its metadata record transactionally.
   * Enforces:
   * 1. Workspace membership & canRunProject permission
   * 2. Secret sanitization
   * 3. Physical blob storage via BlobStore
   * 4. Relational database record creation
   * 5. Blob cleanup if database record creation fails
   * 6. Audit event recording
   */
  async storeArtifact(
    input: StoreArtifactInput,
    actorUserId: string,
  ): Promise<{ artifact: RunArtifact; blob: BlobMetadata }> {
    assertNoSecrets(input, 'StoreArtifactInput');
    const membership = await this.getMembership(input.workspaceId, actorUserId);
    if (!canRunProject(membership, { workspaceId: input.workspaceId })) {
      throw new TenantAccessDeniedError(`Access denied to store artifacts in workspace "${input.workspaceId}".`);
    }

    const run = await this.repos.runs.findById(input.workspaceId, input.runId);
    if (!run) {
      throw new EntityNotFoundError(`TestRun "${input.runId}" not found in workspace "${input.workspaceId}".`);
    }

    const artifactId = input.customArtifactId ?? this.ids.generateId('art');
    const locator: BlobLocator = {
      workspaceId: input.workspaceId,
      projectId: run.projectId,
      runId: input.runId,
      artifactId,
    };

    // 1. Write physical blob
    const blob = await this.blobs.put({
      ...locator,
      contentType: input.contentType ?? 'application/json',
      content: input.content,
    });

    const ts = this.timestamp();
    const artifactRecord: RunArtifact = {
      id: artifactId,
      schemaVersion: '1.0',
      workspaceId: input.workspaceId,
      runId: input.runId,
      type: input.type,
      storagePath: blob.safeObjectKey,
      byteSize: blob.byteLength,
      sha256: blob.checksum,
      contentType: blob.contentType,
      createdAt: ts,
    };

    let savedArtifact: RunArtifact;
    try {
      savedArtifact = await this.repos.artifacts.create(artifactRecord);
    } catch (dbErr) {
      // 2. Clean up written blob if metadata persistence fails
      try {
        await this.blobs.delete(locator);
      } catch {
        // Best-effort cleanup
      }
      throw dbErr;
    }

    await this.recordAudit(input.workspaceId, actorUserId, 'artifact.stored', 'run_artifact', artifactId, {
      runId: input.runId,
      type: input.type,
      byteSize: blob.byteLength,
      sha256: blob.checksum,
      safeObjectKey: blob.safeObjectKey,
    });

    return { artifact: savedArtifact, blob };
  }

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

  async getArtifact(workspaceId: string, artifactId: string, actorUserId: string): Promise<RunArtifact> {
    const membership = await this.getMembership(workspaceId, actorUserId);
    if (!canViewReports(membership, { workspaceId })) {
      throw new TenantAccessDeniedError(`Access denied to view artifacts in workspace "${workspaceId}".`);
    }

    const artifact = await this.repos.artifacts.findById(workspaceId, artifactId);
    if (!artifact) {
      throw new EntityNotFoundError(`Artifact "${artifactId}" not found in workspace "${workspaceId}".`);
    }

    return artifact;
  }

  async getArtifactContent(
    workspaceId: string,
    artifactId: string,
    actorUserId: string,
  ): Promise<{ artifact: RunArtifact; payload: BlobPayload }> {
    const membership = await this.getMembership(workspaceId, actorUserId);
    if (!canViewReports(membership, { workspaceId })) {
      throw new TenantAccessDeniedError(`Access denied to view artifact content in workspace "${workspaceId}".`);
    }

    const artifact = await this.repos.artifacts.findById(workspaceId, artifactId);
    if (!artifact) {
      throw new EntityNotFoundError(`Artifact "${artifactId}" not found in workspace "${workspaceId}".`);
    }

    const run = await this.repos.runs.findById(workspaceId, artifact.runId);
    if (!run) {
      throw new EntityNotFoundError(`TestRun "${artifact.runId}" not found for artifact "${artifactId}".`);
    }

    const locator: BlobLocator = {
      workspaceId,
      projectId: run.projectId,
      runId: artifact.runId,
      artifactId: artifact.id,
    };

    const payload = await this.blobs.get(locator);
    if (!payload) {
      throw new EntityNotFoundError(`Artifact content missing from storage for artifact "${artifactId}".`);
    }

    return { artifact, payload };
  }

  async deleteArtifact(workspaceId: string, artifactId: string, actorUserId: string): Promise<boolean> {
    const membership = await this.getMembership(workspaceId, actorUserId);
    if (!canManageWorkspace(membership, workspaceId) && !canRunProject(membership, { workspaceId })) {
      throw new TenantAccessDeniedError(`Access denied to delete artifacts in workspace "${workspaceId}".`);
    }

    const artifact = await this.repos.artifacts.findById(workspaceId, artifactId);
    if (!artifact) {
      throw new EntityNotFoundError(`Artifact "${artifactId}" not found in workspace "${workspaceId}".`);
    }

    const run = await this.repos.runs.findById(workspaceId, artifact.runId);
    if (!run) {
      throw new EntityNotFoundError(`TestRun "${artifact.runId}" not found for artifact "${artifactId}".`);
    }

    const locator: BlobLocator = {
      workspaceId,
      projectId: run.projectId,
      runId: artifact.runId,
      artifactId: artifact.id,
    };

    const deleted = await this.blobs.delete(locator);

    await this.recordAudit(workspaceId, actorUserId, 'artifact.deleted', 'run_artifact', artifactId, {
      runId: artifact.runId,
      type: artifact.type,
      deleted,
    });

    return deleted;
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
