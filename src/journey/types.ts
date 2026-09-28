/**
 * The Journey Intelligence plan contract.
 *
 * A journey plan is a *description* of what should be attempted, derived only
 * from a natural-language goal and a Build 1 Scout report. Nothing here is
 * executed. Every step carries `executable: false`, which Build 3 may later
 * transform into a real action.
 *
 * Determinism is a hard requirement: the same goal and Scout report must
 * produce byte-identical output. So this model deliberately has no timestamp,
 * no random identifier, and no absolute path.
 */

/** Journey plan schema version, as a string per the Build 2 spec. */
export const JOURNEY_SCHEMA_VERSION = '1.0';

/** Journey categories the planner can classify a goal into. */
export type JourneyType =
  | 'login'
  | 'registration'
  | 'checkout'
  | 'purchase'
  | 'ticket_purchase'
  | 'form_submission'
  | 'search'
  | 'contact'
  | 'upload'
  | 'navigation'
  | 'unknown';

/**
 * Descriptive action for a step.
 *
 * These are labels for Build 3, not instructions Build 2 performs. A plan may
 * say `click`; it never clicks.
 */
export type JourneyAction = 'observe' | 'navigate' | 'identify' | 'click' | 'fill' | 'select' | 'upload' | 'submit' | 'assert';

/** Target page the plan is derived from, echoed from the Scout report. */
export interface JourneyTarget {
  url: string;
  finalUrl: string | null;
  title: string;
}

/** Where a step's evidence came from, for traceability. */
export interface JourneyStepSource {
  /** The Scout report path exactly as the caller supplied it. */
  report: string;
  /** Stable Scout element ids, e.g. `element-004`. */
  elementIds: string[];
}

/**
 * Where a machine-readable expectation came from.
 *
 * Required on every structured assertion: a plan that cannot name its evidence
 * cannot be audited, and an untraceable assertion is indistinguishable from an
 * invented one.
 */
export interface AssertionSource {
  /** Where in the Scout report the expectation was read from. */
  kind:
    | 'scout-element'
    | 'scout-visible-text'
    | 'scout-href'
    | 'scout-form-action'
    | 'scout-target-url';
  /** The Scout element the expectation was read from, when it came from one. */
  elementId?: string;
  /** The Scout field the expectation was read from. */
  field?: 'href' | 'action' | 'text' | 'label' | 'value' | 'url';
}

/** Shared fields on every structured assertion. */
interface AssertionBase {
  /** Where the expectation was read from in the Scout report. */
  source: AssertionSource;
  /** How the expectation is compared. `exact` unless the type is inherently a substring match. */
  match?: 'exact' | 'substring' | 'prefix';
}

/** The target element exists in the DOM. */
export interface ElementPresentAssertion extends AssertionBase {
  type: 'element-present';
}

/** The target element exists and is visible. */
export interface ElementVisibleAssertion extends AssertionBase {
  type: 'element-visible';
}

/** The target element exists and is enabled. */
export interface ElementEnabledAssertion extends AssertionBase {
  type: 'element-enabled';
}

/** The target element's visible text contains an expected string. */
export interface TextContainsAssertion extends AssertionBase {
  type: 'text-contains';
  /** Observed in the Scout report; never invented. */
  expectedText: string;
  match: 'substring' | 'exact';
}

/** The page origin matches an expected origin. */
export interface UrlOriginAssertion extends AssertionBase {
  type: 'url-origin';
  /** Protocol, host and port. Never a path, query or fragment. */
  expectedOrigin: string;
  match: 'exact';
}

/** The page path matches an expected path. */
export interface UrlPathAssertion extends AssertionBase {
  type: 'url-path';
  /** Path only, with no query, fragment or trailing slash. */
  expectedPath: string;
  match: 'exact' | 'prefix';
}

/** Every assertion the executor knows how to evaluate. */
export type StructuredAssertion =
  | ElementPresentAssertion
  | ElementVisibleAssertion
  | ElementEnabledAssertion
  | TextContainsAssertion
  | UrlOriginAssertion
  | UrlPathAssertion;

/** One planned step. Never executed by Build 2. */
export interface JourneyStep {
  /** Deterministic id: `step-001`, `step-002`, ... */
  id: string;
  /** 1-based position. */
  order: number;
  /** Machine-readable step kind, e.g. `identify_login_form`. */
  intent: string;
  /** Descriptive action, for Build 3 to interpret. */
  action: JourneyAction;
  description: string;
  /** Scout element ids this step refers to, possibly empty when nothing matched. */
  targetElementIds: string[];
  /** Deduplicated candidate locators, in stable order. */
  locatorCandidates: string[];
  expectedOutcome: string;
  /**
   * Build 6.2: a machine-readable expectation, present only when Scout
   * evidence supported one. Its absence is the normal case and means the step
   * keeps a prose `expectedOutcome`, which the executor records as unverified.
   */
  assertion?: StructuredAssertion;
  /** 0..1, from observable Scout evidence only. */
  confidence: number;
  /** Always `false` in Build 2. */
  executable: false;
  source: JourneyStepSource;
}

/** How the plan was produced. */
export interface JourneyPlannerMeta {
  mode: 'heuristic';
  version: string;
}

/** The full plan written to `reports/journey.json`. */
export interface JourneyPlan {
  schemaVersion: string;
  goal: string;
  normalizedGoal: string;
  journeyType: JourneyType;
  target: JourneyTarget;
  steps: JourneyStep[];
  assumptions: string[];
  warnings: string[];
  missingInformation: string[];
  planner: JourneyPlannerMeta;
}

/**
 * Replaceable planner seam.
 *
 * Build 2 ships one deterministic, local, heuristic implementation. The
 * interface exists so a future optional AI-backed planner can be substituted
 * without changing callers - deliberately with no provider, key, or network
 * surface attached to it here.
 */
export interface JourneyPlanner {
  plan(input: JourneyPlannerInput): JourneyPlan;
}

/** Everything a planner is given. */
export interface JourneyPlannerInput {
  /** The goal exactly as the user typed it. */
  goal: string;
  /** A validated Scout report. */
  scout: import('../scout/types.js').ScoutReport;
  /** The Scout report path as supplied, echoed into each step's source. */
  scoutPath: string;
}

/** Confidence bands, used to decide when a plan is too shaky to trust. */
export const CONFIDENCE_BANDS = {
  strong: 0.85,
  reasonable: 0.65,
  weak: 0.4,
} as const;

/** Human-readable band label for a confidence score. */
export function confidenceBand(confidence: number): 'strong' | 'reasonable' | 'weak' | 'minimal' {
  if (confidence >= CONFIDENCE_BANDS.strong) return 'strong';
  if (confidence >= CONFIDENCE_BANDS.reasonable) return 'reasonable';
  if (confidence >= CONFIDENCE_BANDS.weak) return 'weak';
  return 'minimal';
}
