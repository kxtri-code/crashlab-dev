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
export {
  ASSERTION_TYPES,
  generatePostActionAssertion,
  generateTargetElementAssertion,
  generateVisibleTextAssertion,
  isSafeExpectedText,
  isStablePath,
  normalizeOrigin,
  normalizePath,
  normalizeText,
  validateStructuredAssertion,
} from './journey/structuredAssertion.js';
export type { AssertionGeneration, AssertionCandidate, AssertionType } from './journey/structuredAssertion.js';
export {
  deriveFormPostcondition,
  formForElement,
  validatePostconditions,
} from './journey/postcondition.js';
export type {
  Postcondition,
  PostconditionGeneration,
  PostconditionDeclineReason,
} from './journey/postcondition.js';
export {
  coversExpectedOutcome,
  describePostconditionOutcome,
  isGenericPlaceholderAssertion,
  planAssertionCleanup,
  rewordExpectedOutcome,
} from './journey/assertionCleanup.js';
export type { RetentionReason } from './journey/assertionCleanup.js';
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
  StructuredAssertion,
  AssertionSource,
  ElementPresentAssertion,
  ElementVisibleAssertion,
  ElementEnabledAssertion,
  TextContainsAssertion,
  UrlOriginAssertion,
  UrlPathAssertion,
} from './journey/types.js';

export * from './scout/types.js';
export { BROWSER_NAME, REPORT_SCHEMA_VERSION, TOOL_NAME, TOOL_VERSION } from './version.js';

// --- Build 3: Journey Executor ----------------------------------------------
// Validation, test-data resolution and redaction are pure. Only `executor.ts`
// and the action handlers touch Playwright, and they act solely on locators the
// journey plan supplied.

export { loadJourneyPlan, validateJourneyPlan, SUPPORTED_ACTIONS } from './executor/planValidator.js';
export { loadTestData, resolveValue, semanticKeysForIntent, resolveFixturePath } from './executor/testData.js';
export { collectSecrets, createScrubber, isSensitiveTestDataKey, redactExecutionUrl, redactMessage as redactExecutionMessage, summarizeValue, NO_SECRETS, REDACTED } from './executor/redaction.js';
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
export { classifyAssertion, isUnverifiableAssertion, skipReasonFor } from './executor/assertionClassifier.js';
export type { AssertionVerdict } from './executor/assertionClassifier.js';
export { evaluateStructuredAssertion } from './executor/structuredAssertionRunner.js';
export type { AssertionOutcome, AssertionResultKind } from './executor/structuredAssertionRunner.js';
export { evaluatePostconditions, worstOutcome } from './executor/postconditionRunner.js';
export type { PostconditionOutcome, PostconditionResult } from './executor/postconditionRunner.js';
export { buildVerification, deriveExecutionStatus, isFullyVerified } from './executor/verification.js';
export { buildExecutionReport, summarizeExecution, countSteps, deriveStatus } from './executor/executionReport.js';
export { ExecutionContext } from './executor/executionContext.js';
export type { ActionOutcome } from './executor/types.js';
// Build 6.5: operator-declared expectations for SPA/JS flows.
export {
  EXPECTATIONS_SCHEMA_VERSION,
  OPERATOR_DECLARED_SOURCE,
  REJECTED_SOURCES,
  EXPECTATION_BEARING_ACTIONS,
  URL_PATH_MATCH_MODES,
  URL_ORIGIN_MATCH_MODES,
  validateExpectationsFile,
  parseExpectationsFile,
  loadExpectationsFile,
  canonicalizeExpectations,
  hashExpectationsFile,
  evaluateExpectations,
  worstExpectationOutcome,
} from './executor/expectations.js';
export type {
  OperatorExpectation,
  ExpectationsFile,
  ExpectationResult,
  ExpectationOutcome,
  ExpectationValidationResult,
} from './executor/expectations.js';
export {
  EXECUTION_SCHEMA_VERSION,
  SUPPORTED_JOURNEY_SCHEMA_VERSIONS,
  ExecutionRefused,
  JourneyPlanError,
} from './executor/types.js';export type {
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
  SkipReason,
  StepVerification,
  ExecutionVerification,
  VerificationStatus,
  VerificationCoverage,
} from './executor/types.js';

// --- Build 4: Anomaly Engine ----------------------------------------------
// Pure analysis. Nothing below imports Playwright, opens a browser, or makes a
// network call; it reads two local JSON artifacts and writes a third.

export {
  ANOMALY_SCHEMA_VERSION,
  SUPPORTED_EXECUTION_SCHEMA_VERSIONS,
  SUPPORTED_ANOMALY_JOURNEY_SCHEMA_VERSIONS,
  RULE_IDS,
  AnomalyInputError,
} from './anomaly/types.js';
export type {
  Anomaly,
  AnomalyKind,
  AnomalySource,
  AnomalyStatus,
  AnomalySummary,
  AnalyzerMeta,
  EvidenceType,
  Interpretation,
  RuleId,
  SignalLevel,
} from './anomaly/types.js';
export { loadAnalysisInputs, validateExecutionReport, validateJourneyReport, orderedSteps } from './anomaly/validator.js';
export { classifySignals, sanitizeUrl } from './anomaly/classifier.js';
export { collectSignals } from './anomaly/rules.js';
export type { RawSignal, RuleContext } from './anomaly/rules.js';
export {
  redactMessage,
  redactStack,
  sanitizeFailure,
  sanitizePath,
  sanitizeUrl as sanitizeAnomalyUrl,
} from './anomaly/redaction.js';export {
  buildAnomalyReport,
  summarizeAnomalies,
  summarizeAnomalyReport,
  writeAnomalyReport,
  DEFAULT_ANOMALY_OUTPUT_PATH,
  INTERPRETATION_NOTE,
} from './anomaly/report.js';
export type { AnomalyReport } from './anomaly/report.js';

// --- Build 5.1: Environment Provenance --------------------------------------
// Pure. No browser, no network, no inspection of the target. Fingerprinting
// and comparison are testable without Playwright.

export { PROVENANCE_SCHEMA_VERSION, MAX_IDENTIFIER_LENGTH, UnsafeIdentifierError } from './provenance/types.js';
export type {
  EnvironmentProvenance,
  EnvironmentReference,
  EnvironmentComparison,
  EnvironmentComparisonResult,
  ProvenanceInput,
  FingerprintInput,
  RuntimeProvenance,
  BrowserProvenance,
  ConfigurationProvenance,
  SourceProvenance,
  ApplicationProvenance,
  TestDataProvenance,
  TargetProvenance,
} from './provenance/types.js';
export {
  sanitizeIdentifier,
  sanitizeEnvironmentId,
  sanitizeAppBuildId,
  sanitizeDataId,
  safeTargetOrigin,
  safeVersion,
} from './provenance/redaction.js';
export {
  computeFingerprint,
  canonicalizeFingerprintInputs,
  fingerprintPayload,
  nodeMajorMinor,
  hashFixture,
  FINGERPRINT_FIELDS,
} from './provenance/fingerprint.js';
export { compareEnvironments, describeComparison } from './provenance/comparison.js';
export type { AttemptEnvironment, OriginalEnvironment } from './provenance/comparison.js';
export {
  buildEnvironmentProvenance,
  collectRuntimeProvenance,
  collectPlaywrightVersion,
  hashTestDataFixture,
  toEnvironmentReference,
  provenanceFromReport,
} from './provenance/reportMetadata.js';
export type { ProvenanceFacts } from './provenance/reportMetadata.js';

// --- Build 6: Baseline Registry and Candidate Review -----------------------
// Pure. No browser, no network, no database. Baseline and review read local
// reports and write new ones; neither mutates an input.

export { BASELINE_SCHEMA_VERSION, BaselineError, DEFAULT_BASELINE_DIR, BASELINE_REGISTRY_FILE } from './baseline/types.js';
export type {
  Baseline,
  BaselineConfirmation,
  BaselineIdentity,
  BaselineSafety,
  BaselineSignal,
  BaselineSource,
  BaselineStatus,
  BaselineRegistry,
} from './baseline/types.js';
export { buildBaselineIdentity, canonicalJourneyContent, journeyHash, signalKeyHash, toBaselineSignal } from './baseline/identity.js';
export { validateBaselineCandidate, assertBaselineCandidate } from './baseline/validator.js';
export type { BaselineValidationInput, BaselineValidationResult } from './baseline/validator.js';
export { buildBaseline, readBaseline, writeBaseline, readRegistry, baselinePathFor, validateBaselineDocument } from './baseline/writer.js';
export type { BaselineCreationRequest } from './baseline/writer.js';

export { REVIEW_SCHEMA_VERSION, DEFAULT_CANDIDATE_OUTPUT_PATH } from './review/types.js';
export type {
  Candidate,
  CandidateEvidence,
  CandidateReport,
  CandidateSummary,
  CandidateClassification,
  ReviewComparison,
  ReviewStatus,
} from './review/types.js';
export { checkCompatibility } from './review/compatibility.js';
export type { CompatibilityResult } from './review/compatibility.js';
export { classifyCandidates, toCandidates } from './review/classifier.js';
export type { ClassificationContext } from './review/classifier.js';
export { buildCandidateReport, summarizeCandidateReport, summarizeCandidates, writeCandidateReport } from './review/candidateReport.js';
export type { ReviewInput } from './review/candidateReport.js';

// --- Build 5: Controlled Reproducer ---------------------------------------
// Matching, eligibility and classification are pure. Only `attemptRunner.ts`
// reaches the browser, and it does so by calling the existing Build 3 executor
// in process: no duplicated action logic, no child processes.

export {
  REPRODUCTION_SCHEMA_VERSION,
  SUPPORTED_ANOMALY_SCHEMA_VERSIONS,
  SUPPORTED_REPRODUCER_JOURNEY_SCHEMA_VERSIONS,
  DEFAULT_ATTEMPTS,
  MIN_ATTEMPTS,
  MAX_ATTEMPTS,
  REPRODUCTION_THRESHOLD,
  ReproductionInputError,
} from './reproducer/types.js';
export type {
  ReproductionInput,
  ReproductionReport,
  ReproductionResult,
  ReproductionRun,
  ReproductionClassification,
  ReproductionSummary,
  ReproducerMeta,
  SafetySummary,
  ReproductionEvidence,
  ReproductionInterpretation,
  IneligibilityReason as ReproductionIneligibilityReason,
  AttemptStatus,
} from './reproducer/types.js';
export {
  loadReproductionInputs,
  validateAnomalyReport,
  validateJourneyReport as validateReproducerJourney,
  validateAttempts,
  signalsOf,
} from './reproducer/inputLoader.js';
export { matchingKeyFor, normalizeMessage, normalizeUrl, signalsMatch } from './reproducer/normalization.js';
export { partitionEligible, ineligibilityFor, hasEligibleSignals, DEFAULT_ELIGIBLE_RULES, DEFAULT_INELIGIBLE_RULES } from './reproducer/eligibility.js';
export { classifyReproduction, formatRatio, ineligibleOutcome } from './reproducer/resultClassifier.js';
export { runAttempt, attemptName, attemptPaths } from './reproducer/attemptRunner.js';
export { reproduceSignals, ReproductionRefused, assertAttemptsValid } from './reproducer/reproducer.js';
export {
  buildReproductionReport,
  buildResults,
  summarizeResults,
  summarizeReproductionReport,
  writeReproductionReport,
  DEFAULT_REPRODUCTION_OUTPUT_PATH,
  REPRODUCTION_NOTE,
} from './reproducer/reproductionReport.js';
