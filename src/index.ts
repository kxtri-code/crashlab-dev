/**
 * CrashLab public surface.
 *
 * Build 1 is a library first and a CLI second, and Build 2 follows the same
 * rule. Everything the CLI uses is exported here so a caller - another command,
 * a job runner, an HTTP API - can consume Scout and Journey Intelligence
 * without importing CLI internals.
 *
 * Note the separation of concerns: everything under `journey/` is pure and
 * imports no Playwright, so planning works in any Node process, browser or not.
 */

export { runScout, DEFAULT_DOM_SCOPE, DEFAULT_MAX_ELEMENTS } from './scout/scout.js';
export type { ScoutOptions } from './scout/scout.js';

export { openBrowserSession, explainLaunchError } from './scout/browser.js';
export type { BrowserSession, BrowserSessionOptions } from './scout/browser.js';

export { collectDomData } from './scout/domRaw.js';
export type {
  CollectDomOptions,
  RawDomData,
  RawDomElement,
  RawDomForm,
  RawPageMeta,
  RawPageSignals,
} from './scout/domRaw.js';

export { classifyElement, suggestLocator, mapElements, mapForms, toInteractiveElement, toScoutForm, toFormField } from './scout/elements.js';

export { detectPageType, buildPageTypeRules, CONFIDENCE_THRESHOLD } from './scout/pageType.js';

export { NetworkRecorder, summarizeNetwork, markThirdParty, DEFAULT_MAX_ENTRIES } from './scout/network.js';
export { TelemetryRecorder, summarizeConsole, normalizeConsoleType } from './scout/telemetry.js';

export { buildReport, summarizeReport, countElements } from './report/build.js';
export type { BuildReportInput } from './report/build.js';
export { writeReport, resolveOutputPath, DEFAULT_OUTPUT_PATH, DEFAULT_SCOUT_OUTPUT_PATH } from './report/write.js';

// --- Build 2: Journey Intelligence ------------------------------------------
// All pure. Nothing below imports or launches Playwright.

export { loadScoutReport, validateScoutReport, extractElements, extractForms, asInteractiveElement, elementIdFor, ScoutReportError } from './journey/scoutLoader.js';
export { normalizeGoal, tokenize } from './journey/goal.js';
export { classifyGoal } from './journey/classify.js';
export type { ClassificationResult } from './journey/classify.js';
export { matchRole, matchRoles, rolesForJourney, bestLocator, requiresCredentials, requiresPayment } from './journey/match.js';
export { bestCandidate } from './journey/confidence.js';
export { decideAction, STRONG_MATCH_SCORE, AUTH_ACTION_TEXTS, PURCHASE_ACTION_TEXTS, SUBMIT_ACTION_TEXTS } from './journey/actionability.js';
export type { ActionDecision, IneligibilityReason } from './journey/actionability.js';
export type { RoleMatch, RoleSpec, ScoredElement, ElementRole } from './journey/match.js';
export { scoreConfidence, confidenceForMatch, overallConfidence, isLowConfidence } from './journey/confidence.js';
export type { ConfidenceInput } from './journey/confidence.js';
export { HeuristicJourneyPlanner, defaultJourneyPlanner, planJourney } from './journey/plan.js';
export { summarizeJourney, writeJourneyPlan, DEFAULT_JOURNEY_OUTPUT_PATH } from './journey/report.js';
export { JOURNEY_SCHEMA_VERSION, CONFIDENCE_BANDS, confidenceBand } from './journey/types.js';
export type {
  JourneyPlan,
  JourneyStep,
  JourneyStepSource,
  JourneyTarget,
  JourneyAction,
  JourneyType,
  JourneyPlanner,
  JourneyPlannerInput,
  JourneyPlannerMeta,
} from './journey/types.js';

export * from './scout/types.js';
export { BROWSER_NAME, REPORT_SCHEMA_VERSION, TOOL_NAME, TOOL_VERSION } from './version.js';

// --- Build 3: Journey Executor ----------------------------------------------
// Validation, test-data resolution and redaction are pure. Only `executor.ts`
// and the action handlers touch Playwright, and they act solely on locators the
// journey plan supplied.

export { loadJourneyPlan, validateJourneyPlan, SUPPORTED_ACTIONS } from './executor/planValidator.js';
export { loadTestData, resolveValue, semanticKeysForIntent, resolveFixturePath } from './executor/testData.js';
export { collectSecrets, createScrubber, isSensitiveTestDataKey, redactExecutionUrl, redactMessage, summarizeValue, NO_SECRETS, REDACTED } from './executor/redaction.js';
export {
  compilePlanLocator,
  compileLocatorExpression,
  isCssSelector,
  isPlaywrightLocatorExpression,
  observeLocator,
  resolveStepTarget,
} from './executor/locatorResolver.js';
export type { LocatorResolution, ResolutionIntent } from './executor/locatorResolver.js';
export { dispatchAction, supportsAction } from './executor/actionDispatcher.js';
export { ScreenshotPolicy, MAX_SCREENSHOTS } from './executor/evidence.js';
export type { ScreenshotResult, ScreenshotOmissionReason } from './executor/evidence.js';
export { executeJourney, DEFAULT_STEP_TIMEOUT_MS } from './executor/executor.js';
export { buildExecutionReport, summarizeExecution, countSteps, deriveStatus } from './executor/executionReport.js';
export { ExecutionContext } from './executor/executionContext.js';
export type { ActionOutcome } from './executor/types.js';
export {
  EXECUTION_SCHEMA_VERSION,
  SUPPORTED_JOURNEY_SCHEMA_VERSIONS,
  ExecutionRefused,
  JourneyPlanError,
} from './executor/types.js';
export type {
  ExecutionOptions,
  ExecutionReport,
  ExecutionStatus,
  BlockReason,
  StepExecutionResult,
  StepObservations,
  StepEvidence,
  RawEvidence,
  RedactionSummary,
  EvidenceConsoleEvent,
  EvidenceNetworkEvent,
  EvidencePageError,
} from './executor/types.js';
