/**
 * Product Foundation Rehearsal Demonstration — Build 11.
 *
 * Demonstrates the complete tenant flow without launching a browser:
 *  1. Create a fake workspace.
 *  2. Create a fake project.
 *  3. Add a local synthetic target.
 *  4. Add an approved safe journey.
 *  5. Run preflight validation.
 *  6. Create a TestRun with status 'created'.
 *  7. Transition it to 'preflight'.
 *  8. Refuse or allow it based on preflight.
 *  9. Record an audit event.
 *  10. Return a safe JSON result.
 */

import { ProductService } from './productService.js';
import { createInMemoryProductRepositories } from '../repository/inMemory.js';
import { DeterministicIdGenerator } from '../util/id.js';
import type { TestRun } from '../types/run.js';
import type { PreflightResult } from '../../preflight/types.js';
import type { AuditEvent } from '../types/audit.js';

export interface ProductRehearsalResult {
  readonly success: boolean;
  readonly workspace: { readonly id: string; readonly name: string };
  readonly project: { readonly id: string; readonly name: string };
  readonly target: { readonly id: string; readonly origin: string; readonly environment: string };
  readonly journey: { readonly id: string; readonly goal: string };
  readonly preflight: PreflightResult;
  readonly run: TestRun;
  readonly auditEvents: readonly AuditEvent[];
}

export interface ProductRehearsalOptions {
  /** If true, creates a target with invalid origins or missing authorization to demonstrate refusal. */
  readonly forceRefusal?: boolean;
  readonly targetUrl?: string;
}

export async function runProductFoundationRehearsal(
  options: ProductRehearsalOptions = {},
): Promise<ProductRehearsalResult> {
  const repos = createInMemoryProductRepositories();
  const ids = new DeterministicIdGenerator('rehearsal');
  const service = new ProductService({ repositories: repos, idGenerator: ids });

  // 1. Create a fake owner user & workspace
  const user = await service.createUser({
    name: 'Alice Owner',
    email: 'alice@example.test',
  });

  const { workspace } = await service.createWorkspace({
    name: 'Acme QA Workspace',
    slug: 'acme-qa',
    ownerUserId: user.id,
  });

  // 2. Create a fake project
  const project = await service.createProject(
    {
      workspaceId: workspace.id,
      name: 'Storefront Web App',
      description: 'Customer-facing e-commerce storefront',
    },
    user.id,
  );

  // 3. Add a local synthetic target
  const targetUrl = options.targetUrl ?? (options.forceRefusal ? 'https://staging.example.com/shop' : 'http://127.0.0.1:4040/shop');
  const allowedOrigins = options.forceRefusal ? ['https://staging.example.com'] : ['http://127.0.0.1:4040'];
  const environment = options.forceRefusal ? 'staging' : 'local';

  const target = await service.createTarget(
    {
      workspaceId: workspace.id,
      projectId: project.id,
      name: 'Synthetic Fixture',
      environment,
      targetUrl,
      allowedOrigins,
      appBuildId: 'build-rehearsal-01',
      forbiddenActions: ['payment', 'checkout', 'delete_account', 'change_password'],
    },
    user.id,
  );

  // 4. Add approved safe journey(s) - staging requires 2 journeys
  const journey = await service.approveJourney(
    {
      workspaceId: workspace.id,
      projectId: project.id,
      targetEnvironmentId: target.id,
      goal: 'explore catalog and view cart',
      origin: target.targetOrigin,
      allowedActions: ['navigate', 'click', 'view'],
      forbiddenActions: ['payment', 'checkout'],
    },
    user.id,
  );

  if (options.forceRefusal) {
    await service.approveJourney(
      {
        workspaceId: workspace.id,
        projectId: project.id,
        targetEnvironmentId: target.id,
        goal: 'view shipping policies',
        origin: target.targetOrigin,
        allowedActions: ['navigate', 'view'],
        forbiddenActions: ['payment', 'checkout'],
      },
      user.id,
    );
  }

  // 5. Create a TestRun with status 'created'
  const run = await service.createRun(
    {
      workspaceId: workspace.id,
      projectId: project.id,
      targetEnvironmentId: target.id,
      journeyId: journey.id,
    },
    user.id,
  );

  // 6. Transition to 'preflight' and evaluate preflight validation
  const { run: evaluatedRun, preflightResult } = await service.evaluateRunPreflight(
    workspace.id,
    run.id,
    user.id,
  );

  // 7. Collect recorded audit events
  const auditEvents = await service.listAuditEvents(workspace.id, user.id);

  return {
    success: evaluatedRun.status === 'queued',
    workspace: { id: workspace.id, name: workspace.name },
    project: { id: project.id, name: project.name },
    target: { id: target.id, origin: target.targetOrigin, environment: target.environment },
    journey: { id: journey.id, goal: journey.goal },
    preflight: preflightResult,
    run: evaluatedRun,
    auditEvents,
  };
}
