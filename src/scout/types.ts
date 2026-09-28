/**
 * The CrashLab Scout report contract.
 *
 * Everything a consumer (terminal summary today, a failure engine or API
 * tomorrow) needs must be derivable from a `ScoutReport` alone, so the scout
 * runs in a fixed order and the shapes below are stable.
 *
 * Safety rules baked into these types:
 *  - No field ever holds a form value, a request body, or a response body.
 *  - `url` fields are canonicalised and credential-redacted before they reach
 *    the report (see `util/url.ts`).
 */

/** Report block describing the run itself. */
export interface ScoutReportMeta {
  tool: string;
  version: string;
  schemaVersion: number;
  createdAt: string;
  durationMs: number;
  browser: string;
  userAgent: string;
  viewport: { width: number; height: number };
  navigationTimings: PageNavigationTimings;
  config: ResolvedRunConfig;
}

/** Effective run configuration, echoed into the report for reproducibility. */
export interface ResolvedRunConfig {
  headless: boolean;
  timeoutMs: number;
  settleMs: number;
  slowMoMs: number;
  ignoreHttpsErrors: boolean;
  /** Resource types the mapper reads off the DOM. */
  domScope: string[];
}

/** Coarse navigation timing, taken after the settle window. */
export interface PageNavigationTimings {
  domContentLoadedMs: number | null;
  loadMs: number | null;
  /** `window.performance.now()` at the moment the report was built. */
  timeSinceNavigationMs: number | null;
}

/** What was requested, where the browser actually ended up, and the page title. */
export interface ScoutReportTarget {
  inputUrl: string;
  finalUrl: string | null;
  title: string;
  /** True when the input URL redirected to a different origin. */
  redirected: boolean | null;
  /** True when the page used a secure-context (https or localhost) origin. */
  secureContext: boolean | null;
}

/** A high-level guess at what kind of page this is. */
export type DetectedPageType =
  | 'login'
  | 'signup'
  | 'checkout'
  | 'form'
  | 'search'
  | 'dashboard'
  | 'list'
  | 'settings'
  | 'unknown';

/** How a page-type guess was reached, and how much the evidence supports it. */
export interface PageTypeSignal {
  value: DetectedPageType;
  confidence: number;
  reason: string;
}

/** Normalised visible text of the page body, for downstream reasoning. */
export interface ScoutReportPage {
  detectedPageType: DetectedPageType;
  pageTypeConfidence: number;
  pageTypeReason: string;
  pageTypeCandidates: PageTypeSignal[];
  visibleTextSample: string;
  visibleTextLength: number;
  /** `document.readyState` when the mapper ran. */
  readyState: string | null;
  htmlLang: string | null;
  canonicalUrl: string | null;
  metaDescription: string | null;
}

/** Coarse element taxonomy, derived from the tag plus `type`/`role`. */
export type InteractiveElementType =
  | 'button'
  | 'link'
  | 'input'
  | 'select'
  | 'textarea'
  | 'checkbox'
  | 'radio'
  | 'other';

/** A single mapped interactive element. */
export interface InteractiveElement {
  type: InteractiveElementType;
  /** Tag name, e.g. `button`, `a`, `input`. */
  tag: string;
  /** Human-visible text, or the accessible name when there is no text node. */
  text: string | null;
  label: string | null;
  name: string | null;
  id: string | null;
  placeholder: string | null;
  ariaLabel: string | null;
  role: string | null;
  href: string | null;
  inputType: string | null;
  value: string | null;
  /** Always a valid, unique CSS selector for this element. */
  selector: string;
  /** Best-practice Playwright locator, when a reliable one could be formed. */
  locator: string | null;
  visible: boolean;
  enabled: boolean;
  required: boolean;
  disabled: boolean;
  readonly: boolean;
  /** Position among same-type elements in DOM order. */
  index: number;
  /** Form this element belongs to, as an index into `forms`. */
  formIndex: number | null;
}

/** A field inside a mapped form, mirroring `InteractiveElement` but scoped. */
export interface FormField {
  type: InteractiveElementType;
  tag: string;
  name: string | null;
  id: string | null;
  label: string | null;
  placeholder: string | null;
  ariaLabel: string | null;
  inputType: string | null;
  required: boolean;
  visible: boolean;
  enabled: boolean;
  selector: string;
  locator: string | null;
}

/** A mapped `<form>`, its fields and its submit controls. */
export interface ScoutForm {
  selector: string;
  action: string | null;
  method: string | null;
  name: string | null;
  id: string | null;
  visible: boolean;
  fields: FormField[];
  /** Controls inside the form that submit it. */
  submitButtons: FormField[];
  /** Controls that submit the form but sit outside it (`form=` attribute). */
  externalSubmitButtons: FormField[];
}

/** Why a resource is interesting to a failure-hunting tool. */
export type NetworkIssueKind = 'http-error' | 'failed-request' | 'blocked-request' | 'slow-request';

/** A single captured network exchange. */
export interface NetworkEntry {
  method: string;
  /** Full canonicalised, redacted URL. */
  url: string;
  /** URL path, for grouping. */
  path: string;
  status: number | null;
  resourceType: string | null;
  /** True when the URL points at a different origin than the final page URL. */
  thirdParty: boolean;
  durationMs: number | null;
  /** Short, non-sensitive failure reason, e.g. `net::ERR_ABORTED`. */
  failure: string | null;
  issue: NetworkIssueKind | null;
}

/** One HTTP status code seen during the run. */
export interface NetworkStatusCount {
  status: number | null;
  count: number;
}

/** Aggregated view over `network`, so consumers need not re-scan the list. */
export interface NetworkSummary {
  totalRequests: number;
  failedRequests: number;
  errorResponses: number;
  slowRequests: number;
  thirdPartyRequests: number;
  byMethod: Record<string, number>;
  byResourceType: Record<string, number>;
  byStatus: NetworkStatusCount[];
}

/** Console message kinds, normalised across Chromium versions. */
export type ConsoleMessageType = 'error' | 'warning' | 'info' | 'log' | 'debug' | 'other';

/** A captured console message. */
export interface ConsoleEntry {
  type: ConsoleMessageType;
  text: string;
  /** Console method name, e.g. `error`, `warning`, `assert`. */
  method: string;
  url: string | null;
  line: number | null;
  timestamp: string;
}

/** A captured uncaught page error (`pageerror`). */
export interface PageErrorEntry {
  message: string;
  stack: string | null;
  timestamp: string;
}

/** Derived console counts, so the summary does not re-scan the array. */
export interface ConsoleSummary {
  total: number;
  byType: Record<string, number>;
}

/** An uncaught failure of the scout itself or the navigation, not a finding. */
export interface ScoutRunError {
  /** Coarse stage, e.g. `launch`, `navigate`, `map`, `network`. */
  stage: string;
  message: string;
  name: string;
  /** First few lines of the stack, for triage. */
  stack: string | null;
  timestamp: string;
}

/** A non-fatal problem worth surfacing in the terminal summary. */
export interface ScoutWarning {
  stage: string;
  message: string;
}

/** Everything the scout observed. This object is the product of Build 1. */
export interface ScoutReport {
  meta: ScoutReportMeta;
  target: ScoutReportTarget;
  page: ScoutReportPage;
  interactiveElements: InteractiveElement[];
  forms: ScoutForm[];
  network: NetworkEntry[];
  networkSummary: NetworkSummary;
  console: ConsoleEntry[];
  consoleSummary: ConsoleSummary;
  errors: PageErrorEntry[];
  /** Failures and warnings raised by the scout run itself. */
  scoutErrors: ScoutRunError[];
  warnings: ScoutWarning[];
  /** Field counts for `interactiveElements`, keyed by element type. */
  elementCounts: Record<string, number>;
}
