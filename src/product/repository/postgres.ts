/**
 * PostgreSQL Product Repositories Adapter — Build 12A: Persistence Adapter.
 *
 * Implements ProductRepositories using PostgreSQL-compatible SQL.
 * Enforces:
 * - 100% Parameterized queries ($1, $2, ...)
 * - Strict workspaceId tenant isolation on all workspace-owned entities
 * - Secret sanitization before any insert or update
 * - Append-only audit events (immutable compliance log)
 * - Safe error mapping without credential exposure
 * - Deep defensive copies returned
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
import type { PostgresPool } from './postgresPool.js';
import { PostgresRunQueueRepository } from '../queue/repository.js';
import { assertNoSecrets } from '../secrets/sanitizer.js';

function toIsoString(val: any): string {
  if (val instanceof Date) return val.toISOString();
  if (typeof val === 'string') return val;
  return new Date().toISOString();
}

function clone<T>(val: T): T {
  return JSON.parse(JSON.stringify(val)) as T;
}

function parseJsonField<T>(val: any, fallback: T): T {
  if (val === null || val === undefined) return fallback;
  if (typeof val === 'object') return val as T;
  try {
    return JSON.parse(val) as T;
  } catch {
    return fallback;
  }
}

// =============================================================================
// 1. Users Repository
// =============================================================================
export class PostgresUserRepository implements UserRepository {
  constructor(private readonly pool: PostgresPool) {}

  private mapRow(row: any): User {
    return Object.freeze({
      id: row.id,
      schemaVersion: '1.0',
      email: row.email,
      name: row.name,
      status: row.status as 'active' | 'suspended',
      createdAt: toIsoString(row.created_at),
      updatedAt: toIsoString(row.updated_at),
    });
  }

  async findById(id: string): Promise<User | null> {
    const res = await this.pool.query('SELECT * FROM users WHERE id = $1;', [id]);
    if (res.rows.length === 0) return null;
    return this.mapRow(res.rows[0]);
  }

  async findByEmail(email: string): Promise<User | null> {
    const res = await this.pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1);', [email.trim()]);
    if (res.rows.length === 0) return null;
    return this.mapRow(res.rows[0]);
  }

  async create(user: User): Promise<User> {
    assertNoSecrets(user, 'User');
    const existing = await this.findById(user.id);
    if (existing) {
      throw new Error(`User with ID "${user.id}" already exists.`);
    }

    try {
      await this.pool.query(
        `INSERT INTO users (id, schema_version, email, name, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7);`,
        [
          user.id,
          user.schemaVersion,
          user.email.toLowerCase().trim(),
          user.name.trim(),
          user.status,
          user.createdAt,
          user.updatedAt,
        ],
      );
      return clone(user);
    } catch (err: any) {
      if (err.code === '23505') {
        throw new Error(`User with email "${user.email}" already exists.`);
      }
      throw err;
    }
  }

  async update(user: User): Promise<User> {
    assertNoSecrets(user, 'User');
    const res = await this.pool.query(
      `UPDATE users
       SET email = $1, name = $2, status = $3, updated_at = $4
       WHERE id = $5;`,
      [user.email.toLowerCase().trim(), user.name.trim(), user.status, user.updatedAt, user.id],
    );
    if (res.rowCount === 0) {
      throw new Error(`User with ID "${user.id}" does not exist.`);
    }
    return clone(user);
  }
}

// =============================================================================
// 2. Workspaces Repository
// =============================================================================
export class PostgresWorkspaceRepository implements WorkspaceRepository {
  constructor(private readonly pool: PostgresPool) {}

  private mapRow(row: any): Workspace {
    return Object.freeze({
      id: row.id,
      schemaVersion: '1.0',
      name: row.name,
      slug: row.slug,
      ownerUserId: row.owner_user_id,
      createdAt: toIsoString(row.created_at),
      updatedAt: toIsoString(row.updated_at),
    });
  }

  async findById(id: string): Promise<Workspace | null> {
    const res = await this.pool.query('SELECT * FROM workspaces WHERE id = $1;', [id]);
    if (res.rows.length === 0) return null;
    return this.mapRow(res.rows[0]);
  }

  async findBySlug(slug: string): Promise<Workspace | null> {
    const res = await this.pool.query('SELECT * FROM workspaces WHERE LOWER(slug) = LOWER($1);', [slug.trim()]);
    if (res.rows.length === 0) return null;
    return this.mapRow(res.rows[0]);
  }

  async listByOwner(ownerUserId: string): Promise<readonly Workspace[]> {
    const res = await this.pool.query('SELECT * FROM workspaces WHERE owner_user_id = $1 ORDER BY created_at ASC;', [
      ownerUserId,
    ]);
    return res.rows.map((r) => this.mapRow(r));
  }

  async create(workspace: Workspace): Promise<Workspace> {
    assertNoSecrets(workspace, 'Workspace');
    const existing = await this.findById(workspace.id);
    if (existing) {
      throw new Error(`Workspace with ID "${workspace.id}" already exists.`);
    }

    try {
      await this.pool.query(
        `INSERT INTO workspaces (id, schema_version, name, slug, owner_user_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7);`,
        [
          workspace.id,
          workspace.schemaVersion,
          workspace.name.trim(),
          workspace.slug.toLowerCase().trim(),
          workspace.ownerUserId,
          workspace.createdAt,
          workspace.updatedAt,
        ],
      );
      return clone(workspace);
    } catch (err: any) {
      if (err.code === '23505') {
        throw new Error(`Workspace with slug "${workspace.slug}" already exists.`);
      }
      throw err;
    }
  }

  async update(workspace: Workspace): Promise<Workspace> {
    assertNoSecrets(workspace, 'Workspace');
    const res = await this.pool.query(
      `UPDATE workspaces
       SET name = $1, slug = $2, owner_user_id = $3, updated_at = $4
       WHERE id = $5;`,
      [workspace.name.trim(), workspace.slug.toLowerCase().trim(), workspace.ownerUserId, workspace.updatedAt, workspace.id],
    );
    if (res.rowCount === 0) {
      throw new Error(`Workspace with ID "${workspace.id}" does not exist.`);
    }
    return clone(workspace);
  }
}

// =============================================================================
// 3. Memberships Repository
// =============================================================================
export class PostgresMembershipRepository implements MembershipRepository {
  constructor(private readonly pool: PostgresPool) {}

  private mapRow(row: any): WorkspaceMember {
    return Object.freeze({
      id: row.id,
      schemaVersion: '1.0',
      workspaceId: row.workspace_id,
      userId: row.user_id,
      role: row.role as WorkspaceMember['role'],
      createdAt: toIsoString(row.created_at),
      updatedAt: toIsoString(row.updated_at),
    });
  }

  async findById(id: string): Promise<WorkspaceMember | null> {
    const res = await this.pool.query('SELECT * FROM workspace_members WHERE id = $1;', [id]);
    if (res.rows.length === 0) return null;
    return this.mapRow(res.rows[0]);
  }

  async findByWorkspaceAndUser(workspaceId: string, userId: string): Promise<WorkspaceMember | null> {
    const res = await this.pool.query(
      'SELECT * FROM workspace_members WHERE workspace_id = $1 AND user_id = $2;',
      [workspaceId, userId],
    );
    if (res.rows.length === 0) return null;
    return this.mapRow(res.rows[0]);
  }

  async listByWorkspace(workspaceId: string): Promise<readonly WorkspaceMember[]> {
    const res = await this.pool.query(
      'SELECT * FROM workspace_members WHERE workspace_id = $1 ORDER BY created_at ASC;',
      [workspaceId],
    );
    return res.rows.map((r) => this.mapRow(r));
  }

  async listByUser(userId: string): Promise<readonly WorkspaceMember[]> {
    const res = await this.pool.query(
      'SELECT * FROM workspace_members WHERE user_id = $1 ORDER BY created_at ASC;',
      [userId],
    );
    return res.rows.map((r) => this.mapRow(r));
  }

  async create(member: WorkspaceMember): Promise<WorkspaceMember> {
    assertNoSecrets(member, 'WorkspaceMember');
    const existing = await this.findById(member.id);
    if (existing) {
      throw new Error(`Member with ID "${member.id}" already exists.`);
    }

    try {
      await this.pool.query(
        `INSERT INTO workspace_members (id, schema_version, workspace_id, user_id, role, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7);`,
        [
          member.id,
          member.schemaVersion,
          member.workspaceId,
          member.userId,
          member.role,
          member.createdAt,
          member.updatedAt,
        ],
      );
      return clone(member);
    } catch (err: any) {
      if (err.code === '23505') {
        throw new Error(`User "${member.userId}" is already a member of workspace "${member.workspaceId}".`);
      }
      throw err;
    }
  }

  async delete(id: string): Promise<boolean> {
    const res = await this.pool.query('DELETE FROM workspace_members WHERE id = $1;', [id]);
    return (res.rowCount ?? 0) > 0;
  }
}

// =============================================================================
// 4. Projects Repository (Tenant isolated)
// =============================================================================
export class PostgresProjectRepository implements ProjectRepository {
  constructor(private readonly pool: PostgresPool) {}

  private mapRow(row: any): Project {
    return Object.freeze({
      id: row.id,
      schemaVersion: '1.0',
      workspaceId: row.workspace_id,
      name: row.name,
      description: row.description ?? '',
      createdAt: toIsoString(row.created_at),
      updatedAt: toIsoString(row.updated_at),
    });
  }

  async findById(workspaceId: string, id: string): Promise<Project | null> {
    const res = await this.pool.query(
      'SELECT * FROM projects WHERE workspace_id = $1 AND id = $2;',
      [workspaceId, id],
    );
    if (res.rows.length === 0) return null;
    return this.mapRow(res.rows[0]);
  }

  async listByWorkspace(workspaceId: string): Promise<readonly Project[]> {
    const res = await this.pool.query(
      'SELECT * FROM projects WHERE workspace_id = $1 ORDER BY created_at ASC;',
      [workspaceId],
    );
    return res.rows.map((r) => this.mapRow(r));
  }

  async create(project: Project): Promise<Project> {
    assertNoSecrets(project, 'Project');
    const existing = await this.findById(project.workspaceId, project.id);
    if (existing) {
      throw new Error(`Project with ID "${project.id}" already exists.`);
    }

    try {
      await this.pool.query(
        `INSERT INTO projects (id, schema_version, workspace_id, name, description, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7);`,
        [
          project.id,
          project.schemaVersion,
          project.workspaceId,
          project.name.trim(),
          project.description,
          project.createdAt,
          project.updatedAt,
        ],
      );
      return clone(project);
    } catch (err: any) {
      if (err.code === '23505') {
        throw new Error(`Project with name "${project.name}" already exists in workspace "${project.workspaceId}".`);
      }
      throw err;
    }
  }

  async update(project: Project): Promise<Project> {
    assertNoSecrets(project, 'Project');
    const res = await this.pool.query(
      `UPDATE projects
       SET name = $1, description = $2, updated_at = $3
       WHERE workspace_id = $4 AND id = $5;`,
      [project.name.trim(), project.description, project.updatedAt, project.workspaceId, project.id],
    );
    if (res.rowCount === 0) {
      throw new Error(`Project with ID "${project.id}" does not exist in workspace "${project.workspaceId}".`);
    }
    return clone(project);
  }
}

// =============================================================================
// 5. Target Environments Repository (Tenant isolated)
// =============================================================================
export class PostgresTargetRepository implements TargetRepository {
  constructor(private readonly pool: PostgresPool) {}

  private mapRow(row: any): TargetEnvironment {
    return Object.freeze({
      id: row.id,
      schemaVersion: '1.0',
      workspaceId: row.workspace_id,
      projectId: row.project_id,
      name: row.name,
      environment: row.environment,
      targetUrl: row.target_url,
      targetOrigin: row.target_origin,
      allowedOrigins: Object.freeze(parseJsonField<string[]>(row.allowed_origins, [])),
      appBuildId: row.app_build_id ?? undefined,
      authorizationReference: row.authorization_reference ?? undefined,
      testDataReference: row.test_data_reference ?? undefined,
      forbiddenActions: Object.freeze(parseJsonField<string[]>(row.forbidden_actions, [])),
      resetProcedure: row.reset_procedure ?? undefined,
      testingWindow: row.testing_window ?? undefined,
      createdAt: toIsoString(row.created_at),
      updatedAt: toIsoString(row.updated_at),
    });
  }

  async findById(workspaceId: string, id: string): Promise<TargetEnvironment | null> {
    const res = await this.pool.query(
      'SELECT * FROM target_environments WHERE workspace_id = $1 AND id = $2;',
      [workspaceId, id],
    );
    if (res.rows.length === 0) return null;
    return this.mapRow(res.rows[0]);
  }

  async listByProject(workspaceId: string, projectId: string): Promise<readonly TargetEnvironment[]> {
    const res = await this.pool.query(
      'SELECT * FROM target_environments WHERE workspace_id = $1 AND project_id = $2 ORDER BY created_at ASC;',
      [workspaceId, projectId],
    );
    return res.rows.map((r) => this.mapRow(r));
  }

  async create(target: TargetEnvironment): Promise<TargetEnvironment> {
    assertNoSecrets(target, 'TargetEnvironment');
    const existing = await this.findById(target.workspaceId, target.id);
    if (existing) {
      throw new Error(`Target with ID "${target.id}" already exists.`);
    }

    await this.pool.query(
      `INSERT INTO target_environments (
        id, schema_version, workspace_id, project_id, name, environment,
        target_url, target_origin, allowed_origins, app_build_id,
        authorization_reference, test_data_reference, forbidden_actions,
        reset_procedure, testing_window, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17);`,
      [
        target.id,
        target.schemaVersion,
        target.workspaceId,
        target.projectId,
        target.name,
        target.environment,
        target.targetUrl,
        target.targetOrigin,
        JSON.stringify(target.allowedOrigins),
        target.appBuildId ?? null,
        target.authorizationReference ?? null,
        target.testDataReference ?? null,
        JSON.stringify(target.forbiddenActions),
        target.resetProcedure ?? null,
        target.testingWindow ?? null,
        target.createdAt,
        target.updatedAt,
      ],
    );
    return clone(target);
  }

  async update(target: TargetEnvironment): Promise<TargetEnvironment> {
    assertNoSecrets(target, 'TargetEnvironment');
    const res = await this.pool.query(
      `UPDATE target_environments
       SET name = $1, environment = $2, target_url = $3, target_origin = $4,
           allowed_origins = $5, app_build_id = $6, authorization_reference = $7,
           test_data_reference = $8, forbidden_actions = $9, reset_procedure = $10,
           testing_window = $11, updated_at = $12
       WHERE workspace_id = $13 AND id = $14;`,
      [
        target.name,
        target.environment,
        target.targetUrl,
        target.targetOrigin,
        JSON.stringify(target.allowedOrigins),
        target.appBuildId ?? null,
        target.authorizationReference ?? null,
        target.testDataReference ?? null,
        JSON.stringify(target.forbiddenActions),
        target.resetProcedure ?? null,
        target.testingWindow ?? null,
        target.updatedAt,
        target.workspaceId,
        target.id,
      ],
    );
    if (res.rowCount === 0) {
      throw new Error(`Target with ID "${target.id}" does not exist in workspace "${target.workspaceId}".`);
    }
    return clone(target);
  }
}

// =============================================================================
// 6. Approved Journeys Repository (Tenant isolated)
// =============================================================================
export class PostgresJourneyRepository implements JourneyRepository {
  constructor(private readonly pool: PostgresPool) {}

  private mapRow(row: any): ProductApprovedJourney {
    return Object.freeze({
      id: row.id,
      schemaVersion: '1.0',
      workspaceId: row.workspace_id,
      projectId: row.project_id,
      targetEnvironmentId: row.target_environment_id,
      goal: row.goal,
      origin: row.origin,
      allowedActions: Object.freeze(parseJsonField<string[]>(row.allowed_actions, [])),
      forbiddenActions: Object.freeze(parseJsonField<string[]>(row.forbidden_actions, [])),
      requiresCredentials: Boolean(row.requires_credentials),
      requiresTestData: Boolean(row.requires_test_data),
      createdAt: toIsoString(row.created_at),
      updatedAt: toIsoString(row.updated_at),
    });
  }

  async findById(workspaceId: string, id: string): Promise<ProductApprovedJourney | null> {
    const res = await this.pool.query(
      'SELECT * FROM approved_journeys WHERE workspace_id = $1 AND id = $2;',
      [workspaceId, id],
    );
    if (res.rows.length === 0) return null;
    return this.mapRow(res.rows[0]);
  }

  async listByTarget(workspaceId: string, targetEnvironmentId: string): Promise<readonly ProductApprovedJourney[]> {
    const res = await this.pool.query(
      'SELECT * FROM approved_journeys WHERE workspace_id = $1 AND target_environment_id = $2 ORDER BY created_at ASC;',
      [workspaceId, targetEnvironmentId],
    );
    return res.rows.map((r) => this.mapRow(r));
  }

  async create(journey: ProductApprovedJourney): Promise<ProductApprovedJourney> {
    assertNoSecrets(journey, 'ApprovedJourney');
    const existing = await this.findById(journey.workspaceId, journey.id);
    if (existing) {
      throw new Error(`ApprovedJourney with ID "${journey.id}" already exists.`);
    }

    await this.pool.query(
      `INSERT INTO approved_journeys (
        id, schema_version, workspace_id, project_id, target_environment_id,
        goal, origin, allowed_actions, forbidden_actions,
        requires_credentials, requires_test_data, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13);`,
      [
        journey.id,
        journey.schemaVersion,
        journey.workspaceId,
        journey.projectId,
        journey.targetEnvironmentId,
        journey.goal,
        journey.origin,
        JSON.stringify(journey.allowedActions),
        JSON.stringify(journey.forbiddenActions),
        journey.requiresCredentials,
        journey.requiresTestData,
        journey.createdAt,
        journey.updatedAt,
      ],
    );
    return clone(journey);
  }
}

// =============================================================================
// 7. Test Runs Repository (Tenant isolated with revisions)
// =============================================================================
export class PostgresRunRepository implements RunRepository {
  constructor(private readonly pool: PostgresPool) {}

  private mapRow(row: any): TestRun {
    return Object.freeze({
      id: row.id,
      schemaVersion: '1.0',
      workspaceId: row.workspace_id,
      projectId: row.project_id,
      targetEnvironmentId: row.target_environment_id,
      journeyId: row.journey_id,
      status: row.status,
      safeTestMode: true,
      preflightStatus: row.preflight_status,
      preflightReportRef: row.preflight_report_ref ?? undefined,
      executionReportRef: row.execution_report_ref ?? undefined,
      anomalyReportRef: row.anomaly_report_ref ?? undefined,
      reproductionReportRef: row.reproduction_report_ref ?? undefined,
      candidatesReportRef: row.candidates_report_ref ?? undefined,
      baselineRef: row.baseline_ref ?? undefined,
      blockedReason: row.blocked_reason ?? undefined,
      failureReason: row.failure_reason ?? undefined,
      cancelReason: row.cancel_reason ?? undefined,
      createdAt: toIsoString(row.created_at),
      updatedAt: toIsoString(row.updated_at),
      startedAt: row.started_at ? toIsoString(row.started_at) : undefined,
      finishedAt: row.finished_at ? toIsoString(row.finished_at) : undefined,
    });
  }

  async findById(workspaceId: string, id: string): Promise<TestRun | null> {
    const res = await this.pool.query(
      'SELECT * FROM test_runs WHERE workspace_id = $1 AND id = $2;',
      [workspaceId, id],
    );
    if (res.rows.length === 0) return null;
    return this.mapRow(res.rows[0]);
  }

  async listByProject(workspaceId: string, projectId: string): Promise<readonly TestRun[]> {
    const res = await this.pool.query(
      'SELECT * FROM test_runs WHERE workspace_id = $1 AND project_id = $2 ORDER BY created_at DESC;',
      [workspaceId, projectId],
    );
    return res.rows.map((r) => this.mapRow(r));
  }

  async listByWorkspace(workspaceId: string): Promise<readonly TestRun[]> {
    const res = await this.pool.query(
      'SELECT * FROM test_runs WHERE workspace_id = $1 ORDER BY created_at DESC;',
      [workspaceId],
    );
    return res.rows.map((r) => this.mapRow(r));
  }

  async create(run: TestRun): Promise<TestRun> {
    assertNoSecrets(run, 'TestRun');
    const existing = await this.findById(run.workspaceId, run.id);
    if (existing) {
      throw new Error(`TestRun with ID "${run.id}" already exists.`);
    }

    await this.pool.query(
      `INSERT INTO test_runs (
        id, schema_version, workspace_id, project_id, target_environment_id,
        journey_id, status, safe_test_mode, preflight_status,
        preflight_report_ref, execution_report_ref, anomaly_report_ref,
        reproduction_report_ref, candidates_report_ref, baseline_ref,
        blocked_reason, failure_reason, cancel_reason,
        created_at, updated_at, started_at, finished_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22);`,
      [
        run.id,
        run.schemaVersion,
        run.workspaceId,
        run.projectId,
        run.targetEnvironmentId,
        run.journeyId,
        run.status,
        true,
        run.preflightStatus,
        run.preflightReportRef ?? null,
        run.executionReportRef ?? null,
        run.anomalyReportRef ?? null,
        run.reproductionReportRef ?? null,
        run.candidatesReportRef ?? null,
        run.baselineRef ?? null,
        run.blockedReason ?? null,
        run.failureReason ?? null,
        run.cancelReason ?? null,
        run.createdAt,
        run.updatedAt,
        run.startedAt ?? null,
        run.finishedAt ?? null,
      ],
    );
    return clone(run);
  }

  async update(run: TestRun): Promise<TestRun> {
    assertNoSecrets(run, 'TestRun');
    const res = await this.pool.query(
      `UPDATE test_runs
       SET status = $1, preflight_status = $2, preflight_report_ref = $3,
           execution_report_ref = $4, anomaly_report_ref = $5, reproduction_report_ref = $6,
           candidates_report_ref = $7, baseline_ref = $8, blocked_reason = $9,
           failure_reason = $10, cancel_reason = $11, updated_at = $12,
           started_at = $13, finished_at = $14
       WHERE workspace_id = $15 AND id = $16;`,
      [
        run.status,
        run.preflightStatus,
        run.preflightReportRef ?? null,
        run.executionReportRef ?? null,
        run.anomalyReportRef ?? null,
        run.reproductionReportRef ?? null,
        run.candidatesReportRef ?? null,
        run.baselineRef ?? null,
        run.blockedReason ?? null,
        run.failureReason ?? null,
        run.cancelReason ?? null,
        run.updatedAt,
        run.startedAt ?? null,
        run.finishedAt ?? null,
        run.workspaceId,
        run.id,
      ],
    );
    if (res.rowCount === 0) {
      throw new Error(`TestRun with ID "${run.id}" does not exist in workspace "${run.workspaceId}".`);
    }
    return clone(run);
  }
}

// =============================================================================
// 8. Run Artifacts Repository (Tenant isolated)
// =============================================================================
export class PostgresArtifactRepository implements ArtifactRepository {
  constructor(private readonly pool: PostgresPool) {}

  private mapRow(row: any): RunArtifact {
    return Object.freeze({
      id: row.id,
      schemaVersion: '1.0',
      workspaceId: row.workspace_id,
      runId: row.run_id,
      type: row.type,
      storagePath: row.storage_path,
      byteSize: Number(row.byte_size),
      sha256: row.sha256,
      contentType: row.content_type,
      createdAt: toIsoString(row.created_at),
    });
  }

  async findById(workspaceId: string, id: string): Promise<RunArtifact | null> {
    const res = await this.pool.query(
      'SELECT * FROM run_artifacts WHERE workspace_id = $1 AND id = $2;',
      [workspaceId, id],
    );
    if (res.rows.length === 0) return null;
    return this.mapRow(res.rows[0]);
  }

  async listByRun(workspaceId: string, runId: string): Promise<readonly RunArtifact[]> {
    const res = await this.pool.query(
      'SELECT * FROM run_artifacts WHERE workspace_id = $1 AND run_id = $2 ORDER BY created_at ASC;',
      [workspaceId, runId],
    );
    return res.rows.map((r) => this.mapRow(r));
  }

  async create(artifact: RunArtifact): Promise<RunArtifact> {
    assertNoSecrets(artifact, 'RunArtifact');
    const existing = await this.findById(artifact.workspaceId, artifact.id);
    if (existing) {
      throw new Error(`RunArtifact with ID "${artifact.id}" already exists.`);
    }

    await this.pool.query(
      `INSERT INTO run_artifacts (id, schema_version, workspace_id, run_id, type, storage_path, byte_size, sha256, content_type, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);`,
      [
        artifact.id,
        artifact.schemaVersion,
        artifact.workspaceId,
        artifact.runId,
        artifact.type,
        artifact.storagePath,
        artifact.byteSize,
        artifact.sha256,
        artifact.contentType,
        artifact.createdAt,
      ],
    );
    return clone(artifact);
  }
}

// =============================================================================
// 9. Candidate References Repository (Tenant isolated)
// =============================================================================
export class PostgresCandidateRepository implements CandidateRepository {
  constructor(private readonly pool: PostgresPool) {}

  private mapRow(row: any): CandidateReference {
    return Object.freeze({
      id: row.id,
      schemaVersion: '1.0',
      workspaceId: row.workspace_id,
      projectId: row.project_id,
      runId: row.run_id,
      candidateId: row.candidate_id,
      ruleId: row.rule_id,
      classification: row.classification,
      reproduced: Boolean(row.reproduced),
      reviewStatus: row.review_status,
      confirmed: false,
      confirmedBug: false,
      createdAt: toIsoString(row.created_at),
      updatedAt: toIsoString(row.updated_at),
    });
  }

  async findById(workspaceId: string, id: string): Promise<CandidateReference | null> {
    const res = await this.pool.query(
      'SELECT * FROM candidate_references WHERE workspace_id = $1 AND id = $2;',
      [workspaceId, id],
    );
    if (res.rows.length === 0) return null;
    return this.mapRow(res.rows[0]);
  }

  async listByRun(workspaceId: string, runId: string): Promise<readonly CandidateReference[]> {
    const res = await this.pool.query(
      'SELECT * FROM candidate_references WHERE workspace_id = $1 AND run_id = $2 ORDER BY created_at ASC;',
      [workspaceId, runId],
    );
    return res.rows.map((r) => this.mapRow(r));
  }

  async listByProject(workspaceId: string, projectId: string): Promise<readonly CandidateReference[]> {
    const res = await this.pool.query(
      'SELECT * FROM candidate_references WHERE workspace_id = $1 AND project_id = $2 ORDER BY created_at DESC;',
      [workspaceId, projectId],
    );
    return res.rows.map((r) => this.mapRow(r));
  }

  async create(candidate: CandidateReference): Promise<CandidateReference> {
    assertNoSecrets(candidate, 'CandidateReference');
    const existing = await this.findById(candidate.workspaceId, candidate.id);
    if (existing) {
      throw new Error(`CandidateReference with ID "${candidate.id}" already exists.`);
    }

    await this.pool.query(
      `INSERT INTO candidate_references (
        id, schema_version, workspace_id, project_id, run_id, candidate_id,
        rule_id, classification, reproduced, review_status, confirmed, confirmed_bug,
        created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14);`,
      [
        candidate.id,
        candidate.schemaVersion,
        candidate.workspaceId,
        candidate.projectId,
        candidate.runId,
        candidate.candidateId,
        candidate.ruleId,
        candidate.classification,
        candidate.reproduced,
        candidate.reviewStatus,
        false,
        false,
        candidate.createdAt,
        candidate.updatedAt,
      ],
    );
    return clone(candidate);
  }

  async update(candidate: CandidateReference): Promise<CandidateReference> {
    assertNoSecrets(candidate, 'CandidateReference');
    const res = await this.pool.query(
      `UPDATE candidate_references
       SET review_status = $1, updated_at = $2
       WHERE workspace_id = $3 AND id = $4;`,
      [candidate.reviewStatus, candidate.updatedAt, candidate.workspaceId, candidate.id],
    );
    if (res.rowCount === 0) {
      throw new Error(`CandidateReference with ID "${candidate.id}" does not exist in workspace "${candidate.workspaceId}".`);
    }
    return clone(candidate);
  }
}

// =============================================================================
// 10. Audit Events Repository (Append-Only & Tenant isolated)
// =============================================================================
export class PostgresAuditRepository implements AuditRepository {
  constructor(private readonly pool: PostgresPool) {}

  private mapRow(row: any): AuditEvent {
    return Object.freeze({
      id: row.id,
      schemaVersion: '1.0',
      workspaceId: row.workspace_id,
      actorUserId: row.actor_user_id,
      eventType: row.event_type,
      entityType: row.entity_type,
      entityId: row.entity_id,
      metadata: Object.freeze(parseJsonField<Record<string, unknown>>(row.metadata, {})),
      timestamp: toIsoString(row.timestamp),
    });
  }

  async findById(workspaceId: string, id: string): Promise<AuditEvent | null> {
    const res = await this.pool.query(
      'SELECT * FROM audit_events WHERE workspace_id = $1 AND id = $2;',
      [workspaceId, id],
    );
    if (res.rows.length === 0) return null;
    return this.mapRow(res.rows[0]);
  }

  async listByWorkspace(workspaceId: string, limit = 100): Promise<readonly AuditEvent[]> {
    const boundedLimit = Math.max(1, Math.min(limit, 500));
    const res = await this.pool.query(
      'SELECT * FROM audit_events WHERE workspace_id = $1 ORDER BY timestamp DESC LIMIT $2;',
      [workspaceId, boundedLimit],
    );
    return res.rows.map((r) => this.mapRow(r));
  }

  async create(event: AuditEvent): Promise<AuditEvent> {
    assertNoSecrets(event, 'AuditEvent');
    assertNoSecrets(event.metadata, 'Audit metadata');

    const existing = await this.findById(event.workspaceId, event.id);
    if (existing) {
      throw new Error(`AuditEvent with ID "${event.id}" already exists.`);
    }

    await this.pool.query(
      `INSERT INTO audit_events (id, schema_version, workspace_id, actor_user_id, event_type, entity_type, entity_id, metadata, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);`,
      [
        event.id,
        event.schemaVersion,
        event.workspaceId,
        event.actorUserId,
        event.eventType,
        event.entityType,
        event.entityId,
        JSON.stringify(event.metadata),
        event.timestamp,
      ],
    );
    return clone(event);
  }
}

/**
 * Creates a complete ProductRepositories suite backed by a PostgreSQL connection pool.
 */
export function createPostgresProductRepositories(pool: PostgresPool): ProductRepositories {
  return {
    users: new PostgresUserRepository(pool),
    workspaces: new PostgresWorkspaceRepository(pool),
    memberships: new PostgresMembershipRepository(pool),
    projects: new PostgresProjectRepository(pool),
    targets: new PostgresTargetRepository(pool),
    journeys: new PostgresJourneyRepository(pool),
    runs: new PostgresRunRepository(pool),
    artifacts: new PostgresArtifactRepository(pool),
    candidates: new PostgresCandidateRepository(pool),
    audits: new PostgresAuditRepository(pool),
    queue: new PostgresRunQueueRepository(pool),
  };
}
