/**
 * Journey execution.
 *
 * The one place a browser is launched for Build 3. Everything before this file
 * is pure; everything in it is orchestration.
 *
 * Execution is sequential, single-attempt, and bounded. There are no retries
 * and no reproduction loops: a step runs once, its result is recorded, and the
 * run either continues or stops. A failed execution is a record of what
 * happened, not a bug report.
 *
 * Cleanup is guaranteed. The browser, context and page are closed in a
 * `finally`, so a step failure, a timeout, an ambiguity or a report-writing
 * error all still tear the session down.
 */

import { chromium } from 'playwright';
import type { Page } from 'playwright';
import type { JourneyStep } from '../journey/types.js';
import { openBrowserSession } from '../scout/browser.js';
import { dispatchAction } from './actionDispatcher.js';
import { ExecutionContext } from './executionContext.js';
import { createEvidenceRecorder, ScreenshotPolicy } from './evidence.js';
import { buildExecutionReport } from './executionReport.js';
import { collectSecrets, createScrubber, redactMessage } from './redaction.js';
import { isSensitiveTestDataKey } from './redaction.js';
import type {
  ExecutionOptions,
  ExecutionReport,
  RedactionSummary,
  StepExecutionResult,
} from './types.js';

/** Default per-step budget. */
export const DEFAULT_STEP_TIMEOUT_MS = 15_000;

/** Default navigation budget. */
const NAVIGATION_TIMEOUT_MS = 30_000;

/** Default viewport, matching Build 1. */
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

/** Build a step result for a step that never ran. */
function skippedResult(step: JourneyStep, reason: string): StepExecutionResult {
  const now = new Date().toISOString();
  return {
    id: step.id,
    order: step.order,
    intent: step.intent,
    action: step.action,
    status: 'skipped',
    startedAt: now,
    finishedAt: now,
    durationMs: 0,
    selectedLocator: null,
    targetElementIds: [...step.targetElementIds],
    urlBefore: null,
    urlAfter: null,
    observations: null,
    evidence: {
      screenshot: null,
      screenshotOmitted: true,
      screenshotOmittedReason: 'skipped-step',
      consoleEvents: [],
      pageErrors: [],
      networkEvents: [],
      dialogObserved: false,
      pageChanged: false,
    },
    error: {
      // A skip records why, but is not a failure, so no structured reason.
      reason: 'action-failed',
      message: reason,
      attemptedLocators: [],
      missingDataKey: null,
    },
    description: step.description,
    planConfidence: step.confidence,
  };
}

/**
 * Execute a validated journey plan.
 *
 * @param options the plan, optional test data, and run configuration.
 * @returns the execution report. The plan is never mutated.
 */
export async function executeJourney(options: ExecutionOptions): Promise<ExecutionReport> {
  const plan = options.plan;
  const timeoutMs = options.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  const evidenceDir = options.evidenceDir ?? 'evidence';
  // Safe test mode is the default and cannot be turned off in this milestone.
  // A live payment path does not exist in CrashLab.
  const safeTestMode = options.safeTestMode !== false;
  // One policy for the whole run, told up front whether screenshots are on.
  const screenshotPolicy = new ScreenshotPolicy({ enabled: options.screenshots !== false });

  // Secrets from test data are known before anything can echo them, so the
  // scrubber is in place for the very first console message.
  const secrets = collectSecrets(options.testData);
  const scrub = createScrubber(secrets);
  const evidence = createEvidenceRecorder(scrub);

  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const warnings: string[] = [];

  const stepResults: StepExecutionResult[] = [];
  const screenshots: string[] = [];
  let aborted = false;
  let stoppedOnFailure = false;
  let finalUrl: string | null = null;
  let redactedValueCount = 0;
  let omittedAfterSensitiveData = false;

  const browserSession = await openBrowserSession({
    headless: options.headed !== true,
    slowMoMs: 0,
    ignoreHttpsErrors: false,
    viewport: DEFAULT_VIEWPORT,
  });

  const { page, context, browser } = browserSession;

  try {
    evidence.attach(page);
    page.setDefaultTimeout(timeoutMs);
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);

    const executionContext = new ExecutionContext({
      plan,
      page,
      evidence,
      scrub,
      timeoutMs,
      safeTestMode,
      testData: options.testData,
    });
    executionContext.installDialogHandler();

    // --- reach the target -------------------------------------------------
    if (!executionContext.isSameOrigin(plan.target.url)) {
      throw new Error(
        `Refusing to execute: the plan target ${plan.target.url} is not a navigable absolute URL on the authorized origin.`,
      );
    }

    try {
      await page.goto(plan.target.url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
    } catch (error) {
      warnings.push(
        `Initial navigation did not complete cleanly: ${redactMessage((error as Error).message, scrub)}. ` +
          'Steps were still attempted against whatever loaded.',
      );
    }

    const initialShot = await evidence.screenshot(page, 'initial', evidenceDir, screenshotPolicy);
    if (initialShot.path) screenshots.push(initialShot.path);

    // --- run the steps ---------------------------------------------------
    for (const step of plan.steps) {
      if (aborted) {
        stepResults.push(skippedResult(step, 'execution stopped after an earlier failure'));
        continue;
      }

      const urlBefore = executionContext.currentUrl();
      const stepStartedMs = Date.now();
      const stepStartedAt = new Date(stepStartedMs).toISOString();

      const outcome = await dispatchAction(step, executionContext);
      const urlAfter = executionContext.currentUrl();

      // A skipped step is an observation, not a failure, so it gets no error
      // object and no failure screenshot naming.
      const evidenceSuffix = outcome.status === 'passed' || outcome.status === 'skipped' ? 'after' : 'failure';
      const shotName = `${step.id}-${evidenceSuffix}`;

      // Mark the page sensitive *before* screenshotting this step. The value is
      // already in the DOM the moment the fill returned, so capturing first
      // would photograph it.
      if (outcome.notes?.some((note) => note.includes('valueRedacted=true'))) {
        redactedValueCount += 1;
        screenshotPolicy.markSensitive();
      }

      const stepEvidence = await evidence.stepEvidence(
        page,
        shotName,
        evidenceDir,
        screenshotPolicy,
        urlBefore,
        urlAfter,
      );
      if (stepEvidence.screenshot) screenshots.push(stepEvidence.screenshot);
      if (stepEvidence.screenshotOmitted && stepEvidence.screenshotOmittedReason === 'sensitive-data-entered') {
        omittedAfterSensitiveData = true;
      }

      stepResults.push({
        id: step.id,
        order: step.order,
        intent: step.intent,
        action: step.action,
        status: outcome.status,
        startedAt: stepStartedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - stepStartedMs,
        // The exact plan string that was used, so a run can be audited without
        // re-running it. The dispatcher already rejected anything ambiguous.
        selectedLocator: outcome.selectedLocator ?? null,
        targetElementIds: [...step.targetElementIds],
        urlBefore,
        urlAfter,
        observations: outcome.observations ?? null,
        evidence: stepEvidence,
        error:
          outcome.status === 'passed' || outcome.status === 'skipped'
            ? null
            : {
                reason: outcome.reason ?? 'action-failed',
                message: redactMessage(outcome.message ?? 'no reason recorded', scrub),
                attemptedLocators: step.locatorCandidates,
                missingDataKey: null,
              },
        description: step.description,
        planConfidence: step.confidence,
      });

      // Stop on a required-step failure unless explicitly told to continue. A
      // skipped step is not a failure: the planner found no target, so there
      // was nothing to attempt, and later steps may still be actionable.
      if (outcome.status === 'failed' || outcome.status === 'blocked') {
        if (options.continueOnFailure !== true) {
          aborted = true;
          stoppedOnFailure = true;
          warnings.push(
            `Execution stopped after step "${step.id}" ${outcome.status}. ` +
              'Re-run with --continue-on-failure to attempt the remaining steps.',
          );
        }
      }
    }

    finalUrl = executionContext.currentUrl();
    const finalShot = await evidence.screenshot(page, 'final', evidenceDir, screenshotPolicy);
    if (finalShot.path) screenshots.push(finalShot.path);
    if (finalShot.omitted && finalShot.omittedReason === 'sensitive-data-entered') {
      omittedAfterSensitiveData = true;
    }

    evidence.settle();

    const redaction: RedactionSummary = {
      sensitiveValuesRedacted: true,
      redactedValueCount,
      dataProvided: options.testData !== undefined,
      dataProvidedKeys: Object.keys(options.testData ?? {}).filter((key) => isSensitiveTestDataKey(key)).sort(),
      screenshotsOmittedAfterSensitiveData: omittedAfterSensitiveData,
    };

    return buildExecutionReport({
      plan,
      options,
      steps: stepResults,
      rawEvidence: {
        consoleEvents: evidence.allConsole(),
        pageErrors: evidence.allPageErrors(),
        networkEvents: evidence.allNetwork(),
        screenshots,
      },
      redaction,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAtMs,
      finalUrl,
      aborted,
      stoppedOnFailure,
      warnings,
    });
  } finally {
    evidence.settle();
    // Close in reverse order of creation. Each is independently guarded so one
    // failure cannot prevent the rest from being closed.
    await page.close().catch(() => undefined);
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}
