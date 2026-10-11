/**
 * Pilot Execution Runner Seam — Build 10.3.
 *
 * Implements the mandatory preflight execution gate seam.
 * Enforces the strict sequential lifecycle:
 *
 *   1. Resolve configuration
 *   2. Run pure preflight validator
 *   3. If preflightOnly: stop immediately (0 browser launches, 0 network calls)
 *   4. Assert safety gate: if status !== 'ready', refuse immediately (0 browser launches)
 *   5. Create execution plan
 *   6. Only then invoke injected runner or browser launcher
 *
 * Contains ZERO static imports of Playwright.
 */

import { loadPilotConfiguration } from '../preflight/loader.js';
import { validatePilotConfiguration, buildPreflightReport } from '../preflight/validator.js';
import { writePreflightReport, formatPreflightSummary } from '../preflight/report.js';
import type { PilotConfiguration, PreflightResult } from '../preflight/types.js';
import { assertPilotReady, createPilotExecutionPlan, PilotExecutionGateError } from './gate.js';
import type {
  PilotExecutionPlan,
  PilotRunnerDependencies,
  PilotRunnerOptions,
  PilotRunResult,
} from './types.js';

/**
 * Execute a pilot configuration through the mandatory preflight safety gate.
 *
 * Guarantees zero browser launches and zero network activity whenever preflight
 * status is not 'ready' or when dry-run (`preflightOnly`) is active.
 */
export async function runPilot(
  options: PilotRunnerOptions,
  deps: PilotRunnerDependencies = {},
): Promise<PilotRunResult> {
  let browserLaunchAttempts = 0;

  // --- Step 1: Resolve Configuration ---
  let config: PilotConfiguration;
  if (typeof options.config === 'string') {
    const loadFn = deps.loadConfig ?? loadPilotConfiguration;
    try {
      config = await loadFn(options.config);
    } catch (error) {
      return {
        exitCode: 2,
        preflightResult: {
          status: 'invalid',
          valid: false,
          targetOrigin: null,
          targetEnvironment: 'unknown',
          checks: [],
          errors: [{ code: 'CONFIG_LOAD_FAILED', message: (error as Error).message }],
          failureReasons: [(error as Error).message],
          metadata: {
            targetName: '(unreadable)',
            appBuildId: null,
            allowedOrigins: [],
            journeyCount: 0,
            journeyIds: [],
            forbiddenActionCategories: [],
            testDataConfigured: false,
            authorizationConfigured: false,
          },
        },
        preflightReport: {
          schemaVersion: '1.0',
          status: 'invalid',
          statement: 'Zero browser traffic generated. Failed to load configuration.',
          target: { url: '', origin: '', name: '', environment: 'unknown', appBuildId: null },
          allowedOrigins: [],
          journeys: [],
          forbiddenActionCategories: [],
          testDataConfigured: false,
          authorizationConfigured: false,
          safetyChecks: [],
          failureReasons: [(error as Error).message],
        },
        executed: false,
        browserLaunchAttempts: 0,
        message: `Failed to load pilot configuration: ${(error as Error).message}`,
      };
    }
  } else {
    config = options.config;
  }

  // --- Step 2: Validate Configuration ---
  const validateFn = deps.validateConfig ?? validatePilotConfiguration;
  const preflightResult = options.preflightResult ?? validateFn(config);
  const preflightReport = buildPreflightReport(config, preflightResult);

  // Write preflight report if requested
  if (options.preflightReportPath) {
    const writeFn = deps.reportWriter ?? writePreflightReport;
    await writeFn(preflightReport, options.preflightReportPath);
  }

  // Display summary if not quiet
  if (!options.quiet) {
    console.log(formatPreflightSummary(preflightReport));
  }

  // --- Step 3: Handle Dry-Run / Preflight-Only Mode ---
  if (options.preflightOnly) {
    const exitCode = preflightResult.status === 'ready' ? 0 : 1;
    const msg = preflightResult.status === 'ready'
      ? 'Preflight validation PASSED (status: ready). Preflight-only dry run complete. Zero browser traffic generated.'
      : `Preflight validation FAILED (status: ${preflightResult.status}). Execution refused. Zero browser traffic generated.`;

    return {
      exitCode,
      preflightResult,
      preflightReport,
      executionPlan: preflightResult.status === 'ready'
        ? createPilotExecutionPlan(config, preflightResult)
        : undefined,
      executed: false,
      browserLaunchAttempts: 0,
      message: msg,
    };
  }

  // --- Step 4: Enforce Mandatory Safety Gate ---
  let executionPlan: PilotExecutionPlan;
  try {
    assertPilotReady(preflightResult);
    executionPlan = createPilotExecutionPlan(config, preflightResult);
  } catch (error) {
    const gateError = error as PilotExecutionGateError;
    return {
      exitCode: 1,
      preflightResult,
      preflightReport,
      executed: false,
      browserLaunchAttempts: 0,
      message: gateError.message,
    };
  }

  // --- Step 5: Check Authorization Confirmation for Real Execution ---
  if (!options.confirmAuthorized && executionPlan.targetEnvironment !== 'local') {
    return {
      exitCode: 1,
      preflightResult,
      preflightReport,
      executionPlan,
      executed: false,
      browserLaunchAttempts: 0,
      message:
        'Refusing to execute: --confirm-authorized was not supplied for non-local target.\nCrashLab requires explicit operator confirmation before contacting authorized staging targets.',
    };
  }

  // --- Step 6: Safe Execution Seam (Only reached when status is 'ready') ---
  // In Build 10.3, external staging targets remain blocked from browser execution.
  if (executionPlan.targetEnvironment !== 'local' && !deps.journeyExecutor && !deps.browserLauncher) {
    return {
      exitCode: 1,
      preflightResult,
      preflightReport,
      executionPlan,
      executed: false,
      browserLaunchAttempts: 0,
      message:
        'Pilot execution refused: Real staging browser execution is blocked in Build 10.3. Use dependency injection or local loopback fixtures.',
    };
  }

  // Execute via injected dependencies
  if (deps.browserLauncher) {
    browserLaunchAttempts += 1;
    await deps.browserLauncher({
      targetUrl: executionPlan.targetUrl,
      targetOrigin: executionPlan.targetOrigin,
      environment: executionPlan.targetEnvironment,
    });
  }

  if (deps.journeyExecutor) {
    browserLaunchAttempts += 1;
    const report = await deps.journeyExecutor({
      journeyPath: options.journeyPath,
      safeTestMode: true,
    });

    return {
      exitCode: 0,
      preflightResult,
      preflightReport,
      executionPlan,
      executed: true,
      browserLaunchAttempts,
      message: `Pilot executed successfully against ${executionPlan.targetOrigin}.`,
      executionReport: report,
    };
  }

  // If local synthetic fixture and journeyPath provided, dynamically import executor to run
  if (executionPlan.targetEnvironment === 'local' && options.journeyPath) {
    browserLaunchAttempts += 1;
    const { executeJourney } = await import('../executor/executor.js');
    const { loadJourneyPlan } = await import('../executor/planValidator.js');
    const plan = await loadJourneyPlan(options.journeyPath);

    const execReport = await executeJourney({
      plan,
      planPath: options.journeyPath,
      safeTestMode: true,
      evidenceDir: options.reportDir ?? 'evidence',
    });

    return {
      exitCode: 0,
      preflightResult,
      preflightReport,
      executionPlan,
      executed: true,
      browserLaunchAttempts,
      message: `Pilot executed successfully against local synthetic fixture (${executionPlan.targetOrigin}).`,
      executionReport: execReport,
    };
  }

  return {
    exitCode: 0,
    preflightResult,
    preflightReport,
    executionPlan,
    executed: false,
    browserLaunchAttempts,
    message: 'Pilot preflight ready. No journey execution requested.',
  };
}
