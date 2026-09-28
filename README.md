# CrashLab

CrashLab is a usage-based autonomous software QA platform. The long-term goal is to
let a developer point it at an authorized web app, describe a goal like *"try to
complete checkout"*, set a budget, and have it discover failures before real users do.

This repository currently contains three builds:

- **Build 1 — Scout** (`npm run scout`): opens an authorized page, maps it, captures
  telemetry, and writes a deterministic local JSON report.
- **Build 2 — Journey Intelligence** (`npm run journey`): turns a natural-language goal
  plus a Scout report into a structured, deterministic journey plan.
- **Build 3 — Journey Executor** (`npm run execute`): attempts a journey plan in a
  browser and records what happened, in a separate report.

Each build is a separate artifact:

```
reports/scout.json      what is on the page          (Build 1)
reports/journey.json    what should be attempted     (Build 2) - immutable input
reports/execution.json  what happened when attempted (Build 3)
```

Build 2 **plans only** and Build 3 **only attempts**. An execution result is not a
confirmed bug: anomaly detection is Build 4 and reproduction is Build 5.

---

## Build 1: Scout

Given a URL, Scout opens it in Chromium and records:

| Area | Captured |
| --- | --- |
| Target | Input URL, final URL, page title, cross-origin redirect flag |
| Page | Visible-text sample, detected page type, language, canonical URL, description |
| Interactive elements | Buttons, links, inputs, textareas, selects, checkboxes, radios, ARIA-role controls, `contenteditable`, `contenteditable="true"` |
| Element attributes | Text, label, `name`, `id`, `placeholder`, `aria-label`, `role`, `href`, `input` type, static `value` attribute |
| Per element | A unique CSS `selector`, a suggested Playwright `locator`, and `visible` / `enabled` / `required` / `disabled` / `readonly` flags |
| Forms | Selector, action, method, every field, submit buttons (including `form=` controls outside the form) |
| Network | Method, URL, path, status, resource type, duration, third-party flag, failure reason |
| Console | Every console message, typed and capped |
| Page errors | Uncaught JavaScript exceptions with stacks |

It then writes `reports/scout.json` and prints a readable terminal summary.

**Detected page types:** `login`, `signup`, `checkout`, `form`, `search`, `dashboard`,
`list`, `settings`, or `unknown`. A guess is only reported when it clears a confidence
bar; otherwise Scout says `unknown` rather than guessing. The report keeps the
near-missed candidates and the reason, so a later planner can revisit them.

## What Scout does **not** do yet

Deliberately out of scope for Build 1:

- No AI of any kind — no planner, no investigator, no failure analysis
- No dashboard, web UI, or backend API
- No database, authentication, billing, wallet, or usage metering
- No reproduction, test generation, or CI/CD integration
- No penetration testing, credential stuffing, or auth bypass
- No crawling, multi-step journeys, or interaction beyond a single page load

Scout **observes**. It does not click, submit, or authenticate.

---

## Build 2: Journey Intelligence

Build 2 answers one question: **"what steps should be attempted for this goal?"**

It takes a natural-language goal and an existing Scout report, and produces an ordered,
deterministic journey plan. It does **not** answer "can the browser execute these steps?" —
that is Build 3.

### Usage

```bash
# Scout a page first (Build 1)
npm run scout -- https://staging.example.com/checkout

# Then plan a journey against it (Build 2)
npm run journey -- \
  --goal "Try to complete checkout" \
  --scout reports/scout.json
```

```bash
# Example: a ticket purchase
npm run journey -- \
  --goal "Try to purchase a ticket" \
  --scout reports/scout.json
```

| Flag | Default | Purpose |
| --- | --- | --- |
| `--goal "<text>"` | — | The user goal in natural language (required) |
| `--scout <path>` | `reports/scout.json` | Path to a Build 1 Scout report |
| `-o, --out <path>` | `reports/journey.json` | Journey plan output path |

Output goes to **`reports/journey.json`**.

### Input requirements

- A non-empty goal. A blank or missing goal exits `1`.
- A readable, structurally valid Scout report. A missing file, invalid JSON, or a
  report missing required metadata or elements exits `1`.
- A *valid* report that happens to contain no matching controls still produces a
  valid, low-confidence journey with warnings. It does not fail.

Validation rejects reports that would make planning meaningless: no `meta`, no
`target`, no `interactiveElements` array, an element without an integer `index` or a
`selector` string, duplicate element indices (which would make step-to-element
references ambiguous), and malformed `forms`.

### Journey types

`login`, `registration`, `checkout`, `purchase`, `ticket_purchase`, `form_submission`,
`search`, `contact`, `upload`, `navigation`, `unknown`.

Classification is keyword-based, case-insensitive, and whitespace-normalised, with an
explicit priority order so the most specific intent wins: login (100) → registration
(95) → ticket_purchase (90) → upload (85) → checkout (80) → contact (70) → search
(60) → form_submission (50) → navigation (20). When several categories match, the
winner is recorded in `assumptions` and a warning names the losers. When nothing
matches, the type is `unknown` and the plan is generic.

### Planning heuristics

Scout elements are matched against the control roles the journey type cares about
(email field, password field, submit control, add-to-cart control, and so on). Each
match is scored from observable Scout evidence only:

| Evidence | Score |
| --- | --- |
| Exact label match | 60 |
| Partial label match | 40 |
| Exact element text match | 46 |
| Partial element text match | 30 |
| Descriptive `name` or `id` | 30 |
| Placeholder match | 26 |
| `aria-label` match | 24 |
| Matching `input` type | 22 |
| Shares a term with the goal | 12 |
| Element belongs to a form | 10 |
| A stable locator exists | 8 |
| Visible | 6 |
| Enabled | 4 |

Element tag and `input` type act as **filters**, not bonuses: a `select` is never a
password field, and a bare type match must not make every button a candidate for every
role. A role that declares text patterns requires text evidence. Negative patterns stop
a "Sign out" button matching a "sign in" goal.

Hidden and disabled elements are **never** planned as controls. They are reported in
warnings, because a control that exists but cannot be interacted with is itself a
signal — a hidden "Checkout" button can mean the page is mid-flow.

### Journey plan format

```jsonc
{
  "schemaVersion": "1.0",
  "goal": "Try to complete checkout",
  "normalizedGoal": "try to complete checkout",
  "journeyType": "checkout",
  "target": { "url": "...", "finalUrl": "...", "title": "..." },
  "steps": [
    {
      "id": "step-001",
      "order": 1,
      "intent": "identify_purchase_target",
      "action": "identify",
      "description": "Identify the relevant product, event, or ticket.",
      "targetElementIds": ["element-002"],
      "locatorCandidates": ["#buy-now"],
      "expectedOutcome": "A relevant purchase target is identified.",
      "confidence": 0.43,
      "executable": false,
      "source": { "report": "reports/scout.json", "elementIds": ["element-002"] }
    }
  ],
  "assumptions": ["..."],
  "warnings": ["..."],
  "missingInformation": ["..."],
  "planner": { "mode": "heuristic", "version": "0.1.0" }
}
```

Actions are descriptive labels from a fixed vocabulary — `observe`, `navigate`,
`identify`, `click`, `fill`, `select`, `upload`, `submit`, `assert` — for Build 3 to
interpret. **Every step sets `"executable": false`.** A plan may say `click`; it never
clicks.

`elementIds` are derived deterministically from the Scout element's `index`
(`element-001`, `element-002`, …) and every step repeats the same ids in its `source`
block, so each step traces back to a specific Scout element.

### Determinism

The same goal and Scout report produce **byte-identical** output. There is no
timestamp, no random id, and no resolved absolute path anywhere in the plan — the
Scout report path is echoed exactly as supplied, so a plan produced on one machine
matches one produced on another. Candidates are sorted by relevance, then visibility,
then enabled state, then document order, then element id. Locator candidates are
deduplicated in stable order, as are warnings and missing-information entries.

### Confidence

Every score is between 0 and 1, computed from Scout evidence only, under a
deliberately conservative policy:

| Band | Range | Meaning |
| --- | --- | --- |
| strong | 0.85–1.00 | Strong evidence |
| reasonable | 0.65–0.84 | Reasonable evidence with limitations |
| weak | 0.40–0.64 | Weak or incomplete evidence |
| minimal | 0.00–0.39 | Mostly unknown or unsupported |

Confidence **rises** with clear goal keywords, matching text or labels, visibility,
enabled state, form membership, and a stable locator. It **falls** when candidates tie
(×0.75), a hidden equivalent exists (×0.85), a disabled equivalent exists (×0.9), or
no locator is available (×0.6). A perfect match tops out below 1.0, because no Scout
evidence can prove a journey will actually succeed. A plan below 0.65 always carries a
warning.

### Warnings and missing information

These are different things, and both are explicit arrays of strings:

- **Warnings** describe uncertainty or ambiguity — several controls matching equally
  well, a control present but hidden or disabled, a goal matching more than one
  category, the expected outcome not being inferable.
- **Missing information** describes what a later build would need — test credentials
  for a login journey, a safe test payment method for a checkout journey, the intended
  product or ticket, the post-submission application state.

Missing information is never offset by a strong match elsewhere, and the planner never
silently guesses. A low-confidence journey says so.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Plan written |
| `1` | Empty goal, or the Scout report was missing, unreadable, or invalid |
| `2` | Bad arguments |

### What Build 2 does **not** do

- No browser launch, navigation, click, form fill, or submission
- No Playwright import anywhere in `src/journey/` — the planner is a pure function and
  runs in any Node process
- No AI provider, API key, or network call. The `JourneyPlanner` interface is a
  replaceable seam, but the only implementation is local and heuristic
- No login automation, payment automation, or auth bypass
- No penetration testing, credential guessing, or secret extraction
- No invented credentials, payment data, or personal information
- No confirmation that a journey is a bug — a plan is not a finding

A journey plan is **not** a confirmed bug. Build 2 says what to attempt; whether it
fails, and whether that failure is a real defect, is Build 3 and beyond.

---

## Build 3: Journey Executor

Build 3 answers one question: **"what happened when we attempted this journey?"**

It reads a `journey.json` produced by Build 2, validates it, opens the authorized
target, attempts each step in order, records every step's result, captures bounded
raw evidence, and writes a separate `reports/execution.json`.

### Usage

```bash
# Execute a journey plan
npm run execute -- \
  --journey reports/journey.json \
  --confirm-authorized

# With test data for fill / select / upload steps
npm run execute -- \
  --journey reports/journey.json \
  --data tests/fixtures/executor-test-data.json \
  --confirm-authorized
```

| Flag | Default | Purpose |
| --- | --- | --- |
| `--journey <path>` | `reports/journey.json` | The plan to attempt |
| `--confirm-authorized` | **required** | Confirm you are authorized to test the target |
| `--data <path>` | — | JSON test data for `fill` / `select` / `upload` |
| `-o, --out <path>` | `reports/execution.json` | Execution report path |
| `--timeout <ms>` | `15000` | Per-step timeout |
| `--continue-on-failure` | off | Attempt later steps after a failure instead of stopping |
| `--headed` | off | Run with a visible browser window |
| `--safe-test-mode` | off | Permit payment-adjacent actions. See the warning below. |
| `--no-screenshots` | off | Do not capture screenshots |

### Authorization is mandatory

`--confirm-authorized` is required. Without it the executor **does not launch a
browser, does not navigate, and writes no report** — it prints an explanation and
exits `1`. This gate is checked *before* the journey plan is even read, so an
unauthorized invocation cannot touch a target.

Only run CrashLab against applications you own or are explicitly authorized to test,
and start with staging and local test apps.

### Execution is safe by default

- **No retries.** Every step is attempted exactly once. `executor.retries` is a
  structural `0`, not a setting.
- **No reproduction.** A failure is recorded, not re-run.
- **No anomaly classification.** Evidence is collected raw; interpreting it is
  Build 4's job.
- **No bug confirmation.** A failed or blocked step is an observation about this
  run, not a defect in the product.
- **Stop on required failure.** Execution halts and remaining steps are marked
  `skipped`, unless `--continue-on-failure` is given.

### Payment safety

Build 3 cannot tell a sandbox from production, so a `click` or `submit` step that
looks payment-adjacent (its intent, description, expected outcome or locators
mention paying, ordering, card, CVV and similar) is **blocked by default**:

```
step-004  blocked  submit  identify_payment_submission
      reason=payment-blocked
```

`--safe-test-mode` permits it. Only use that flag when you are certain the target
is a test environment, because it removes the last guard before a real charge.

### Supported actions

| Action | Behaviour |
| --- | --- |
| `observe` | Resolves the target and records existence, visibility and enabled state. Does not touch the page. |
| `identify` | Records the selected element. Ambiguity blocks rather than choosing. |
| `navigate` | Navigates to a URL the plan already represents. Never derives one from free text. |
| `click` | Clicks a unique, visible, enabled control. Records URL before/after. |
| `fill` | Types an explicit test value. **Blocks without one.** Never invents a value. |
| `select` | Selects an explicit option by label. Never picks the first option. |
| `upload` | Attaches an explicit local fixture inside the allowed directory. |
| `submit` | Submits through the designated control. Records what happened; draws no conclusion. |
| `assert` | Checks a target the plan identified is present. Prose is never interpreted. |

### Test data

`fill`, `select` and `upload` require explicit data. A step with no matching entry is
**blocked** — not guessed, not defaulted, and never filled with an empty string.

```json
{
  "element-004": "qa@example.test",
  "email": "qa@example.test",
  "password": "SafeFixturePassword123!",
  "country": "Germany",
  "file": "tests/fixtures/upload-fixture.txt"
}
```

Resolution order:

1. exact target element id (`element-004`)
2. a semantic key derived from the step intent (`identify_password_field` → `password`)
3. a stable field `name`, when the caller supplies it

There is deliberately **no blanket fallback** over a generic vocabulary. Handing
`email` to a country field would type the wrong data into the wrong control, which
is worse than refusing — an unrecognised intent blocks so you can add a key that
means something for that field.

Only `.test`, `.invalid` and clearly fake values belong in a test-data file. The
committed fixture uses fake addresses only. Real credentials go in an untracked
local file (`test-data.local.json` and `*.test-data.json` are gitignored).

### Locator resolution

A step may only be acted on through a locator the **plan** supplied. The executor:

1. tries `locatorCandidates` in order,
2. compiles each one — Playwright `getBy*` / `locator(...)` expressions and CSS
   selectors, read as **literals** so a plan string can never execute code,
3. requires a unique match,
4. requires a visible and enabled element for any interactive action,
5. records which locator was used,
6. never falls back to an element the planner did not name.

A locator matching several elements **blocks** as `locator-ambiguous` rather than
picking one, because choosing would make the run depend on document order. A
locator matching nothing blocks as `locator-not-found`. A form the executor does
not understand blocks as `locator-unsupported` — it is never half-supported or
guessed at.

### Execution report

Written to `reports/execution.json`.

```jsonc
{
  "schemaVersion": "1.0",
  "journeyPlanSchemaVersion": "1.0",
  "journeyReport": "reports/journey.json",
  "goal": "Try to log in",
  "journeyType": "login",
  "target": { "url": "...", "finalUrl": "...", "title": "..." },
  "status": "aborted",
  "startedAt": "...", "finishedAt": "...", "durationMs": 1234,
  "stepCounts": { "total": 5, "passed": 4, "failed": 0, "blocked": 1, "skipped": 0 },
  "steps": [
    {
      "id": "step-002", "order": 2, "intent": "identify_username_field",
      "action": "identify", "status": "passed",
      "startedAt": "...", "finishedAt": "...", "durationMs": 9,
      "selectedLocator": "page.getByRole('textbox', { name: 'username' })",
      "targetElementIds": ["element-001"],
      "urlBefore": "...", "urlAfter": "...",
      "observations": { "exists": true, "visible": true, "enabled": true, "tag": "input", "matchCount": 1 },
      "evidence": {
        "screenshot": "step-002-after.png",
        "consoleEvents": [], "pageErrors": [], "networkEvents": [],
        "dialogObserved": false, "pageChanged": false
      },
      "error": null,
      "description": "...", "planConfidence": 0.99
    }
  ],
  "rawEvidence": { "consoleEvents": [], "pageErrors": [], "networkEvents": [], "screenshots": [] },
  "warnings": [], "blockedSteps": ["step-005: unsupported-assertion - ..."],
  "redaction": { "sensitiveValuesRedacted": true, "redactedValueCount": 1, "dataProvided": true, "dataProvidedKeys": ["password"] },
  "executor": { "mode": "deterministic", "version": "0.1.0", "retries": 0,
                "stoppedOnFailure": true, "continueOnFailure": false, "safeTestMode": false }
}
```

### Status meanings

| Step status | Meaning |
| --- | --- |
| `passed` | The step's action was performed and its observation succeeded |
| `failed` | The action was attempted and did not succeed |
| `blocked` | The step could not be attempted safely: no target, ambiguity, hidden, disabled, missing data, payment guard, or an external-origin navigation |

| Overall status | Meaning |
| --- | --- |
| `passed` | Every step passed |
| `partial` | Some steps passed, others blocked, and the run continued |
| `failed` | A step failed, and the run continued past it |
| `aborted` | Execution stopped early after a failure |

None of these means a bug. There is no "confirmed bug" status, by design.

### Redaction

Two mechanisms, and the first is the real guarantee:

1. **A value is never recorded.** A `fill` step writes only that a value was
   supplied and that it was redacted. The report may state a value's length, which
   is enough to diagnose a wrong test-data entry without disclosing it.
2. **Page-derived text is scrubbed.** Console messages, page errors, URLs and error
   strings come from the target and can echo a value back — the login fixture
   writes the submitted password into the DOM, and that value never reaches the
   report. Sensitive query values and URL credentials are redacted as well.

No request or response bodies, and no request or response headers, are ever
captured. The report states `redaction.sensitiveValuesRedacted: true` and lists
which *keys* were provided, never their values.

### Screenshots and evidence

Screenshots are captured only where useful and are bounded to 40 per run:

`initial.png`, `step-NNN-after.png` (or `step-NNN-failure.png`),
`final.png`, written to `evidence/`.

The `evidence/` directory is gitignored, because a screenshot shows whatever was on
the page. Network evidence is metadata only — method, URL, status, resource type,
duration, third-party flag — never headers or bodies.

### Build 3 does **not** do

- No anomaly detection or failure classification (Build 4)
- No reproduction or retry loops (Build 5)
- No AI investigation or provider
- No bug confirmation or severity scoring
- No login automation or credential guessing
- No payment automation, and no payment action without `--safe-test-mode`
- No penetration testing or security scanning
- No dashboard, backend, database, or billing

It also never mutates `journey.json`. The plan is an immutable input; the result is
a new artifact.

### Build 2 compatibility note

Build 2's planner emits only `identify` and `assert` steps. Its "define the expected
outcome" steps carry no target and a prose `expectedOutcome`, so Build 3 correctly
blocks them as `unsupported-assertion` — it will not interpret natural language. In
practice a generated login plan runs its identification steps and then stops on the
final assertion.

The full nine-action dispatcher is implemented and tested, because a hand-authored
`journey-plan-v1` document may legitimately contain `click`, `fill`, `submit` and
the rest. This is a property of the Build 2 planner's output, not a contract change:
`src/journey/` is unmodified by Build 3.

## Requirements

- Node.js **20.11+** (Node 22 recommended)
- Chromium via Playwright

## Install

```bash
npm install
npx playwright install chromium
```

(`npm run setup` is a shortcut for the second command.)

## Usage

```bash
# Scout a page (Build 1)
npm run scout -- https://example.com

# Plan a journey from that report (Build 2)
npm run journey -- --goal "Try to complete checkout" --scout reports/scout.json

# Or run the entry point directly
npx tsx src/cli.ts scout https://example.com
npx tsx src/cli.ts journey --goal "Try to complete checkout" --scout reports/scout.json
```

```
CRASHLAB SCOUT v0.1.0

  Target:     https://staging.example.com/checkout
  Final URL:  https://staging.example.com/checkout
  Page title: Checkout
  Page type:  checkout (85% confidence)

INTERACTIVE ELEMENTS
  Buttons:        4
  Links:          12
  Inputs:         6
  Checkboxes:     2
  Forms:          1

NETWORK
  Requests captured: 18
  HTTP errors:       1
  Failed requests:   0
  Third party:       3

CONSOLE
  Warnings:       1
  Errors:         0
  Other messages: 4
  Page errors:    0

Scout complete.
Report: reports/scout.json
```

### Options

Scout (`npm run scout -- <url>`):

| Flag | Default | Purpose |
| --- | --- | --- |
| `--url <url>` | — | Target URL (alternative to the positional argument) |
| `-o, --out <path>` | `reports/scout.json` | Report output path |
| `--timeout <ms>` | `30000` | Navigation timeout |
| `--settle <ms>` | `1000` | Extra wait after load, for late-rendering content |
| `--slow-mo <ms>` | `0` | Slow every action down, to watch a run |
| `--viewport <WxH>` | `1280x800` | Viewport size |
| `--insecure` | off | Accept invalid TLS certificates (local/staging self-signed certs) |
| `--visible` | off | Run Chromium with a window |
| `--headless` | on | Run Chromium headless |
| `-h, --help` | — | Usage |
| `-v, --version` | — | Build version |

Journey (`npm run journey -- --goal "<text>"`):

| Flag | Default | Purpose |
| --- | --- | --- |
| `--goal "<text>"` | — | The user goal in natural language (required) |
| `--scout <path>` | `reports/scout.json` | Path to a Build 1 Scout report |
| `-o, --out <path>` | `reports/journey.json` | Journey plan output path |

Execute (`npm run execute -- --journey <path> --confirm-authorized`):

| Flag | Default | Purpose |
| --- | --- | --- |
| `--journey <path>` | `reports/journey.json` | The plan to attempt |
| `--confirm-authorized` | **required** | Confirm authorization for the target |
| `--data <path>` | — | JSON test data for `fill` / `select` / `upload` |
| `-o, --out <path>` | `reports/execution.json` | Execution report path |
| `--timeout <ms>` | `15000` | Per-step timeout |
| `--continue-on-failure` | off | Continue after a failure |
| `--headed` | off | Visible browser window |
| `--safe-test-mode` | off | Permit payment-adjacent actions |
| `--no-screenshots` | off | Skip screenshots |

### Configuration

CLI flags win over environment variables, which win over defaults.
Copy `.env.example` to `.env` and run `npm run scout:env -- scout <url>` to load it
(Node's native `--env-file`; no dotenv dependency).

```
CRASHLAB_HEADLESS     CRASHLAB_TIMEOUT_MS   CRASHLAB_SETTLE_MS
CRASHLAB_OUTPUT       CRASHLAB_SLOW_MO_MS   CRASHLAB_INSECURE
CRASHLAB_VIEWPORT
```

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Report written, no scout errors |
| `1` | Report written **but** the run had a scout error (e.g. navigation failed) |
| `2` | Bad arguments; nothing was run |

A navigation failure still produces a report — "the page was broken" is a finding,
not a crash. A request that never completes is recorded as a `failed-request`
rather than dropped, for the same reason.

## Where the report is saved

Default: `reports/scout.json`, resolved against the current working directory.
The directory is created if it does not exist. Reports are gitignored.

### Report shape

```jsonc
{
  "meta": { "tool": "CrashLab Scout", "version": "0.1.0", "schemaVersion": 1,
            "createdAt": "2026-09-27T10:00:00.000Z", "durationMs": 1830,
            "browser": "chromium", "userAgent": "...", "viewport": { ... },
            "navigationTimings": { ... }, "config": { ... } },
  "target":   { "inputUrl": "...", "finalUrl": "...", "title": "...",
                "redirected": false, "secureContext": true },
  "page":     { "detectedPageType": "checkout", "pageTypeConfidence": 0.85,
                "pageTypeReason": "...", "pageTypeCandidates": [ ... ],
                "visibleTextSample": "...", "visibleTextLength": 812,
                "readyState": "complete", "htmlLang": "en", ... },
  "interactiveElements": [
    { "type": "button", "tag": "input", "text": "Place order", "label": null,
      "name": "submit", "id": "checkout-form", "placeholder": null,
      "ariaLabel": null, "role": null, "href": null, "inputType": "submit",
      "value": null, "selector": "#place-order",
      "locator": "page.getByTestId('place-order')",
      "visible": true, "enabled": true, "required": false, "disabled": false,
      "readonly": false, "index": 12, "formIndex": 0 }
  ],
  "forms":   [ { "selector": "#checkout-form", "action": "...", "method": "POST",
                 "fields": [ ... ], "submitButtons": [ ... ],
                 "externalSubmitButtons": [ ... ] } ],
  "network": [ { "method": "GET", "url": "...", "path": "/api/orders",
                 "status": 200, "resourceType": "xhr", "thirdParty": false,
                 "durationMs": 84, "failure": null, "issue": null } ],
  "networkSummary": { "totalRequests": 18, "errorResponses": 1, "byStatus": [ ... ], ... },
  "console": [ { "type": "error", "text": "...", "method": "error",
                 "url": "...", "line": 42, "timestamp": "..." } ],
  "consoleSummary": { "total": 5, "byType": { "error": 1, "warning": 1, "log": 3 } },
  "errors":     [ { "message": "...", "stack": "...", "timestamp": "..." } ],
  "scoutErrors": [ { "stage": "navigate", "name": "Error", "message": "...", ... } ],
  "warnings":   [ { "stage": "map", "message": "..." } ],
  "elementCounts": { "button": 4, "link": 12, "input": 6, ... }
}
```

`meta.schemaVersion` increments when the shape changes in a way consumers must
notice. `scoutErrors` records failures of the *scout run*; `errors` records uncaught
exceptions in the *target page* — they are different things and are kept apart.

### Selector and locator strategy

Each element gets two identifiers:

- **`selector`** — a CSS selector guaranteed to resolve to exactly that element.
  Prefers a stable `#id`, then a test-id attribute, then `name`, then a structural
  path using `:nth-of-type`. Generated CSS-module hashes (`css-1a2b3c`) are skipped.
- **`locator`** — a best-practice Playwright string, when one can be formed with
  confidence: `getByTestId` → `getByRole(role, { name })` → `getByLabel` →
  `getByPlaceholder`. `null` when nothing stable is available; fall back to
  `selector` in that case.

Locator generation is intentionally simple in Build 1. It is not yet a full
selector engine — it does not disambiguate repeated names or verify uniqueness
at runtime.

## Safety

**Only run CrashLab against applications you own or are explicitly authorized to
test.** Start with staging and local test apps. CrashLab performs no penetration
testing and makes no attempt to bypass authentication.

What the report deliberately does **not** contain:

- No form values. The live `value` property is never read. The static `value`
  *attribute* is read only for **visible** controls — an invisible control's
  attribute is where a hidden CSRF token or prefilled secret lives, so it is
  dropped rather than recorded.
- No request or response bodies, and no request or response headers.
- No credentials: URL userinfo (`https://user:pass@…`) is replaced, and sensitive
  query values (`token`, `password`, `api_key`, `signature`, `session`, …) are
  replaced with `REDACTED`.
- Console text is whatever the target page logged; long messages are capped.

URL redaction is a safety net, not a guarantee. A report can still contain
sensitive information if the target page puts it in a URL path, a heading, or a
console message. Review reports before sharing them.

## Development

```bash
npm run typecheck    # tsc --noEmit over src and tests
npm run build        # compile to dist/
npm test             # all tests
npm run test:unit    # pure-function tests only, no browser needed
npm run test:browser # browser-backed tests (skips if Chromium is missing)
npm run test:watch   # watch mode
```

### Layout

```
src/
  cli.ts              command dispatcher + the Build 1 scout command
  index.ts            public surface for future callers
  version.ts          tool name / version / schema version
  cli/
    args.ts           shared flag scanner (--flag value and --flag=value)
    journeyCommand.ts the Build 2 `journey` command
    executeCommand.ts the Build 3 `execute` command
  scout/              Build 1 - browser-backed
    types.ts          the Scout report contract
    browser.ts        Chromium launch and teardown
    domRaw.ts         in-page DOM extraction (runs inside the browser)
    elements.ts       PURE: raw DOM -> report elements, selectors, locators
    pageType.ts       PURE: page-type inference with confidence
    network.ts        network capture + PURE summarisation
    telemetry.ts      console and page-error capture + PURE summarisation
    scout.ts          runScout() orchestration
  journey/            Build 2 - pure, no Playwright import anywhere
    types.ts          the journey plan contract + the JourneyPlanner seam
    scoutLoader.ts    Scout report loading, validation, element extraction
    goal.ts           PURE: goal normalisation and tokenisation
    classify.ts       PURE: goal -> journey type, with ambiguity reporting
    match.ts          PURE: Scout elements -> scored role candidates
    confidence.ts     PURE: evidence -> 0..1 confidence
    plan.ts           PURE: composition into ordered steps + diagnostics
    report.ts         plan persistence + terminal summary
  executor/           Build 3 - only executor.ts and the action handlers
    types.ts               the execution report contract
    planValidator.ts       PURE: plan loading and contract validation
    testData.ts            PURE: test-data resolution and fixture-path limits
    redaction.ts           PURE: scrubbing and redacted value summaries
    locatorResolver.ts     plan locator strings -> Playwright locators
    executionContext.ts    per-step budget, origin and payment guards
    actionDispatcher.ts    the nine actions
    evidence.ts            evidence capture, reusing Build 1 recorders
    executionReport.ts     PURE: report assembly + terminal summary
    executor.ts            the one place a browser is launched
  report/
    build.ts          PURE: Scout report assembly + terminal summary
    write.ts          shared JSON persistence
  util/
    url.ts            PURE: redaction, canonicalisation, config parsing
    text.ts           PURE: text normalisation
tests/
  unit/               pure-function tests (no browser)
  browser/            Chromium integration tests against local fixtures
  fixtures/           static HTML, a node:http fixture server, Scout report fixtures
```

The rule: **anything that can be a pure function is a pure function.** Browser
access is confined to `browser.ts`, `domRaw.ts`, the event handlers in
`network.ts`/`telemetry.ts`, and the `page.*` calls in `scout.ts`. That is what
keeps the majority of the logic unit-testable without launching a browser.

Build 2 extends the rule: **the whole of `src/journey/` is pure.** It imports no
Playwright, opens no browser, and makes no network call, so the planner can run in a
CI job or a backend process. The only I/O is reading the Scout report and writing the
plan, both in the CLI command.

Build 3 keeps that separation in both directions: `src/journey/` still imports no
Playwright, and Build 3 adds no planning logic. Validation, test-data resolution and
redaction are pure and unit-testable; only `executor.ts` and the action handlers
touch a browser, and they act solely on locators the plan supplied.

### One trap worth knowing about

`collectDomData` runs *inside the page* via `page.evaluate`, so Playwright
serializes it and evaluates it with no access to this module's scope. Two rules
follow, and breaking either fails at runtime rather than at compile time:

1. The function body may not reference module-level constants or helpers.
2. The TS toolchain (`tsx`, and `vitest`) compiles with `keepNames`, which
   rewrites function declarations to `var f = __name(function f() {...}, "f")`.
   That `__name` helper is undefined in the page, producing
   `ReferenceError: __name is not defined` and an empty element map.

`installSerializationShim()` installs a no-op `globalThis.__name` as *script text*
(via `addInitScript`) before navigation, which closes the second gap without
being serialized itself. A mapping failure is reported as a `map` scout error
rather than silently yielding an empty report.

### Extending Scout

`runScout()` takes a URL and a config and returns a `ScoutReport`. It has no CLI
coupling — no `process.argv`, no `console.log` — so a job runner or API can call it
directly. `planJourney()` is the same for Build 2, and takes an optional planner:

```ts
import { runScout, writeReport, planJourney, writeJourneyPlan } from 'crashlab';

const scout = await runScout({ url: 'https://staging.example.com', headless: true });
await writeReport(scout, 'reports/checkout.json');

const plan = planJourney('Try to complete checkout', scout, 'reports/scout.json');
await writeJourneyPlan(plan, 'reports/checkout-journey.json');
```

`JourneyPlanner` is a one-method interface, so an alternative implementation can be
substituted without touching callers. The only implementation shipped is local and
heuristic; adding an AI-backed planner later would be an additive change with no
provider, key, or network surface attached to Build 2.

## Known limitations

### Build 1 (Scout)

- Single page only. Nothing is clicked, and redirects beyond the initial
  navigation are not followed as separate scouts.
- No SPA route changes are tracked. A client-side route change after load is
  captured in the final URL, but the DOM is mapped only once, at the end.
- Element map is capped at 2000 elements; a truncation warning is recorded.
- Page-type inference is keyword- and structure-based. It reports `unknown` rather
  than guessing, so many real pages will land there.
- Locators are not verified for uniqueness at runtime, and repeated accessible
  names are not disambiguated. For an input, a `label` doubles as its accessible
  name, so `getByRole(role, { name })` usually wins over `getByLabel`.
- Navigation waits for `domcontentloaded` plus a fixed settle delay. There is no
  idle-network or animation wait, so very late content can be missed.
- One run, one report. No comparison against a baseline.

### Build 2 (Journey Intelligence)

- Classification is keyword-based. A goal phrased in a way none of the keyword
  groups anticipate is classified `unknown` and gets a generic plan.
- The plan reflects the page as scouted. If state changes between the Scout run
  and execution — a modal, a redirect, a login wall — the plan will be stale. There
  is no re-validation, because there is no browser.
- Only controls visible and enabled *at Scout time* are planned. A control that
  appears later is not known to the planner.
- Element matching is heuristic and English-keyword-based. A button labelled only
  with an icon and an `aria-label` in another language will not match.
- Confidence is a heuristic, not a probability. It reflects how well the Scout
  evidence supports a step, not how likely the journey is to pass.
- At most three candidates per step are carried, so a step with many equivalent
  controls shows only the first three. Warnings report when a tie was detected.
- A journey plan is **not** a finding. Nothing here says whether a flow is broken.

### Build 3 (Journey Executor)

- The payment guard is a text check on the plan's own wording, not an
  understanding of the target. A payment flow that avoids that vocabulary is not
  caught by it, which is why `--safe-test-mode` should be used only knowingly.
- Locator support covers the forms Build 2 emits plus plain CSS. A hand-written
  plan using chained or `nth()` locators is refused as unsupported rather than
  half-executed.
- `assert` only checks presence. A Build 2 step whose expected outcome is prose is
  blocked, so generated plans usually stop on their final assertion.
- Test-data resolution requires a semantic key or an element id. There is no
  blanket fallback, so a step with an unrecognised intent needs an explicit key.
- The executor does not verify the page still matches the Scout report. A stale
  plan executes against whatever is now at that URL.
- Screenshots are captured unredacted. A page showing a value at the moment of
  capture will show it in the PNG; redaction applies to the JSON report.
- A single run is a single sample. Nothing here distinguishes a flaky step from a
  consistently broken one — that requires Build 5.

## Next build

**Build 4: Anomaly Engine** — read the raw evidence in `execution.json` and
classify it: HTTP errors, duplicate requests, JavaScript exceptions, unexpected
redirects, timeouts, and broken UI state, reported as observations about the run
rather than confirmed bugs. Not started.

Reproduction belongs to Build 5. A failed execution is not automatically a product
bug, and a single observation is not yet evidence of anything.
