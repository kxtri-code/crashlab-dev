# CrashLab

CrashLab is a usage-based autonomous software QA platform. The long-term goal is to
let a developer point it at an authorized web app, describe a goal like *"try to
complete checkout"*, set a budget, and have it discover failures before real users do.

This repository contains five builds, with two integration milestones layered on Build 3:

- **Build 1 — Scout** (`npm run scout`): opens an authorized page, maps it, captures
  telemetry, and writes a deterministic local JSON report.
- **Build 2 — Journey Intelligence** (`npm run journey`): turns a natural-language goal
  plus a Scout report into a structured, deterministic journey plan.
- **Build 3 — Journey Executor** (`npm run execute`): attempts a journey plan in a
  browser and records what happened, in a separate report.
- **Build 3.1 — Execution Readiness**: generated plans carry real actions, safe-test
  mode is the default, and screenshots stop once test data has entered the page.
- **Build 4 — Anomaly Engine** (`npm run anomalies`): reads a completed execution
  report and classifies deterministic evidence signals.
- **Build 5 — Controlled Reproducer** (`npm run reproduce`): reruns a journey a bounded
  number of times and reports whether a signal recurred.
- **Build 5.1 — Environment Provenance**: records *where* each run happened, so a
  reproduction can be compared against the environment it was observed in.
- **Build 6 — Baseline & Candidate Review** (`npm run baseline`, `npm run review`):
  records an explicit known-good state, then compares a later run against it.
- **Build 6.1 — Complete Run Semantics**: a generated journey finishes in a reviewable
  state instead of aborting on an assertion nobody can evaluate.
- **Build 7 — Baseline Continuity and Lineage**: tracks baseline ancestry and detects
  reintroduced defects across application versions.
- **Build 8 — Persistent Candidate Review State** (`npm run review-state`): records
  human triage decisions separately in an append-only event log and deterministic projection.

Each build is a separate artifact, and no build rewrites another's:

```
reports/scout.json          what is on the page          (Build 1)
reports/journey.json        what should be attempted     (Build 2) - immutable input
reports/execution.json      what happened when attempted (Build 3) - immutable input
reports/anomalies.json      what looked abnormal         (Build 4) - immutable input
reports/reproduction.json   did it happen again          (Build 5)
reports/candidates.json     what was compared vs baseline (Build 6/7) - immutable input
reports/baselines/<id>.json known-good baseline records   (Build 6/7)
reports/review-state/
  events.jsonl              append-only human review log  (Build 8)
  state.json                deterministic projection      (Build 8)
```

Build 2 **plans only** and Build 3 **only attempts**. An execution result is not a
confirmed bug: anomaly detection is Build 4 and reproduction is Build 5.

### The full local pipeline

Every stage is real, and none needs a network or a model:

```bash
# 1. a natural-language goal
GOAL="Try to complete checkout"

# 2. map the authorized page                      -> reports/scout.json
npm run scout -- https://staging.example.com/checkout

# 3. plan the journey                             -> reports/journey.json
npm run journey -- --goal "$GOAL" --scout reports/scout.json

# 4. attempt the journey                          -> reports/execution.json
npm run execute -- --journey reports/journey.json --confirm-authorized

# 4b. with test data, for fill / select / upload steps
npm run execute -- \
  --journey reports/journey.json \
  --data tests/fixtures/executor-test-data.json \
  --confirm-authorized
```

`journey.json` is an immutable input. The executor reads its bytes, runs, and reads
them again; the integration test asserts they are byte-identical. The same holds for
Build 4: it reads `execution.json` and `journey.json` and writes only
`anomalies.json`.

---

## Build 4: Anomaly Engine

Build 4 answers one question: **"what suspicious or abnormal signals were observed
during this execution?"**

It reads a completed execution report and the journey it came from, applies
deterministic rules, and writes structured observations. It does **not** answer
"is this a software bug?" — confirming that requires reproduction, which is Build 5.

```bash
npm run anomalies -- \
  --execution reports/execution.json \
  --journey reports/journey.json
```

| Flag | Default | Purpose |
| --- | --- | --- |
| `--execution <path>` | `reports/execution.json` | The execution report to analyse |
| `--journey <path>` | `reports/journey.json` | The journey it came from, for origin context |
| `-o, --out <path>` | `reports/anomalies.json` | Anomaly report path |
| `--include-console-warnings` | off | Also report console warnings |

### A signal is not a bug

Three fields carry the meaning, and the distinction matters:

- **`status: "observed"`** — a deterministic rule matched recorded evidence. It
  happened; it is not diagnosed.
- **`confirmed: false`** — always false, on every signal and on the report as a
  whole. Build 4 never confirms a bug.
- **`possiblyExpected: true`** — the signal may be legitimate given context. A 401
  on a protected resource, a 404 for a probe, a repeated analytics beacon.

`signalLevel` (`info` / `warning` / `error`) describes how direct the observation
is. It is **not** product severity, and Build 4 assigns no defect ranking.

### Statuses are not equivalent

The single most important behaviour in this build: the engine distinguishes a step
that *did something wrong* from one that CrashLab *declined to do*.

| Situation | Anomaly? |
| --- | --- |
| Step `passed` | no |
| Step `skipped` — observational, nothing to act on | **no** |
| Step `blocked` by the payment guard | **no** — a safety policy, not an application fault |
| Step `blocked` for missing test data | **no** — the operator supplied nothing |
| Step `blocked` for an ambiguous locator | **no** — CrashLab would not choose arbitrarily |
| Step `blocked` for off-origin navigation | **no** — already refused, so re-reporting double-counts |
| Step `failed` with a real reason | yes, when the reason is not a refusal |

A step that never touched the page cannot tell you anything about the page. A
refusal is a policy outcome, not a finding.

### Rule IDs

Stable identifiers, part of the output contract:

| Rule ID | Raised when |
| --- | --- |
| `HTTP_5XX` | A 5xx response was recorded. `error` level. |
| `HTTP_4XX` | A 4xx response was recorded. `warning`, and `possiblyExpected` for common statuses (400/401/403/404/409/410/422/429). |
| `NETWORK_REQUEST_FAILED` | A request produced no response at all. Distinct from an HTTP error: there is no status, so the transport failure reason is recorded. |
| `CONSOLE_ERROR` | A console `error`. `possiblyExpected` — a page logging its own error is common. |
| `CONSOLE_WARNING` | A console `warning`, only with `--include-console-warnings`. Off by default because warnings are frequently expected. |
| `PAGE_ERROR` | An uncaught exception. `error` level. |
| `STEP_TIMEOUT` | A step's `error.reason` is `timed-out`. **Never inferred** from a long duration. |
| `UNEXPECTED_ORIGIN` | A non-skipped, non-blocked step moved to an origin other than the authorized target. Marked `possiblyExpected`, since an identity-provider redirect is routine. |
| `TARGET_MISSING_AFTER_ACTION` | An *attempted* action found no target. |
| `TARGET_DISABLED_AFTER_ACTION` | An *attempted* action found the target unusable. |
| `DUPLICATE_REQUEST` | The same method + URL + resource type appeared 2+ times. `info`, and `possiblyExpected` for asset-like types. |
| `EXECUTION_ACTION_FAILED` | A step was attempted and failed, with a reason that is not a refusal and is not owned by another rule. |

Each failure reason belongs to exactly one rule, so a single event is never counted
twice.

### Redaction

Build 3 already redacts before writing `execution.json`, but Build 4 cannot assume
that — it may be pointed at a report produced elsewhere. So it re-redacts on the way
out, matching secret *shapes* rather than known values (the analyzer is
deliberately given no test data): bearer/basic authorization values, JWTs, provider
tokens, `key=value` secret pairs, and card-number-shaped digit runs. URLs are
sanitized, console text is scrubbed, and a page-error stack is reduced to its first
line.

A message made *entirely* of secret material is reported as omitted rather than as a
bare `REDACTED`, which a reader could mistake for the original content. There is no
OCR or model-based redaction, and images are referenced by path only.

### Determinism

Analysing the same two inputs produces byte-identical output. There is no
timestamp, no random id, and no resolved absolute path. Signals are ordered by step
order, then evidence index, then a fixed rule-priority table, then rule id, then a
normalized event key.

**Dedup policy:** one signal per distinct (rule, step, event, key), with an
occurrence count. The same event appearing twice yields one signal, not two
indistinguishable rows.

### Build 4 does **not** do

- No browser, no Playwright, no network call. It reads two local files and writes a
  third.
- No AI, no model, no external API.
- No retries and no reproduction of any failure.
- No bug confirmation, severity ranking, root-cause analysis, or fix suggestions.
- No modification of `journey.json` or `execution.json`.

A finding reads "HTTP 500 response observed during execution", never "checkout is
definitely broken".

---

## Build 5: Controlled Reproducer and Confirmation

Build 5 answers one question: **"did this observed signal occur again under
controlled repeat execution?"**

It reads `anomalies.json` and `journey.json`, reruns the journey a bounded number of
times, re-classifies each rerun with the Build 4 rules, and reports whether each
signal recurred. It does **not** answer "is this a bug".

```bash
npm run reproduce -- \
  --anomalies reports/anomalies.json \
  --journey reports/journey.json \
  --attempts 3 \
  --confirm-authorized

# With test data, used unchanged for every attempt
npm run reproduce -- \
  --anomalies reports/anomalies.json \
  --journey reports/journey.json \
  --data tests/fixtures/executor-test-data.json \
  --attempts 3 \
  --confirm-authorized
```

| Flag | Default | Purpose |
| --- | --- | --- |
| `--anomalies <path>` | `reports/anomalies.json` | Signals to test |
| `--journey <path>` | `reports/journey.json` | The journey to rerun |
| `--data <path>` | — | Test data, identical for every attempt |
| `-o, --out <path>` | `reports/reproduction.json` | Reproduction report |
| `--attempts <n>` | `3` | Controlled attempts, 1–5 |
| `--timeout <ms>` | executor default | Per-step executor timeout |
| `--headed` | off | Visible browser window |
| `--include-possibly-expected` | off | Also rerun signals excluded by default |
| `--confirm-authorized` | **required** | Confirms authorization for the target |

### Reproduced is not broken

```
Observed signal
  ↓
Controlled reruns
  ↓
Reproduced or not reproduced
  ↓
Candidate for investigation
  ↓
Human or later investigation confirms meaning
```

Every result carries `confirmed: false`, and the report carries
`interpretation.confirmedBug: false`. A recurring signal is a *lead*. A page that
reliably returns 500 on a health-check probe reproduces perfectly and is not a defect.

| Classification | Meaning |
| --- | --- |
| `reproduced` | Seen in at least 2 completed attempts (the threshold) |
| `not-reproduced` | Absent from every completed attempt |
| `inconclusive` | One hit out of three, a run with no stable key, or attempts that could not settle it |
| `blocked` | No attempt could run — browser failure, unusable target |
| `ineligible` | Excluded before any attempt, with the reason recorded |

The threshold of two exists because one hit out of three is a coincidence far more
often than a fault. `reproductionRatio` is a count like `2/3`, never a probability.

### Eligibility

Reproduced by default: `HTTP_5XX`, `NETWORK_REQUEST_FAILED`, `CONSOLE_ERROR`,
`PAGE_ERROR`, `STEP_TIMEOUT`, `TARGET_MISSING_AFTER_ACTION`,
`TARGET_DISABLED_AFTER_ACTION`, `EXECUTION_ACTION_FAILED`.

Excluded by default, each with a recorded reason: `HTTP_4XX`, `CONSOLE_WARNING`,
`DUPLICATE_REQUEST`, `UNEXPECTED_ORIGIN` — all commonly expected, and all of which
reproduce perfectly while meaning nothing. Also never reproduced: any `info`-level
signal, and any signal with no stable comparison key.

`--include-possibly-expected` opts the rule-excluded group in. It never turns one into
a confirmed bug.

### Attempt limits

Default 3, minimum 1, **maximum 5**. Out-of-range values are rejected, not clamped, so
asking for 50 tells you rather than silently running 5. These are declared reproduction
attempts under an explicit budget, not hidden retry logic: `automaticRetries` is always
`false`, and every attempt is written to its own report and counted.

### Strategy

One journey rerun per attempt, not one per anomaly. Every signal is therefore evaluated
under identical conditions, which is what makes the comparison meaningful. Each attempt
uses a fresh browser context and page, the same plan, the same test data, the same
target, and the same executor settings.

### Safety

`--confirm-authorized` is required and is checked *before* anything is read or opened.
Safe test mode is inherited from the executor and stays unconditional; there is no
live-payment flag and the payment guard is not weakened. Rerun execution reports keep
the executor's screenshot omission: once test data enters the page, later screenshots
are omitted with a recorded reason.

The journey, execution and anomaly reports are read and left byte-identical. Rerun
artifacts go to `reports/reproduction/attempt-NNN/` and never overwrite them.

### Matching

Two runs of the same journey never produce byte-identical evidence: ports, ids and
timestamps differ. Signals are compared on a normalized key that strips run-to-run noise
while preserving what identifies the signal — 404 never matches 500, GET never matches
POST, and a console error never matches a page error.

Stack traces are reduced to their first line before comparison, so an unstable path
cannot cause a miss and a value inside it cannot leak.

---

## Build 5.1: Environment-Aware Evidence and Provenance

Build 5 could say a signal recurred, but not *where*. That gap matters: a signal
that reproduces against production-like data and one that reproduces only against a
local fixture are very different leads, and the report could not tell them apart.

Build 5.1 records **where and how** each run happened, using only safe values. It
adds provenance to all three reports and changes nothing about what the system
concludes: no anomaly rule, reproduction threshold, eligibility rule, payment guard
or screenshot rule is altered.

```bash
npm run execute -- \
  --journey reports/journey.json \
  --environment-id local-shop \
  --app-build-id shop-build-001 \
  --data-id fake-login-fixture-v1 \
  --confirm-authorized

npm run reproduce -- \
  --anomalies reports/anomalies.json \
  --journey reports/journey.json \
  --environment-id local-shop \
  --app-build-id shop-build-001 \
  --attempts 3 \
  --confirm-authorized
```

All three flags are optional, on `execute` and `reproduce`.

### What is stored

`execution.json` gains an `environment` object:

| Section | Contents |
| --- | --- |
| `fingerprint` | `sha256:...` over the canonical safe fields |
| `fingerprintInputs` | The exact values hashed, so a mismatch can be explained |
| `target` | Origin only — never a path, query or fragment |
| `runtime` | Node version, platform, architecture |
| `browser` | Name and version, read from the session that actually ran |
| `configuration` | Headless, safe-test mode, timeout |
| `source` | Journey schema version, planner and executor versions |
| `application` | Optional `buildId` and `environmentId` |
| `testData` | Optional `fixtureId` and opt-in `fixtureHash` |

`anomalies.json` carries a compact `environment` reference, and
`reproduction.json` carries a per-attempt environment plus a comparison per result.

### What is never stored

No username, home directory, absolute path, process id, environment-variable dump,
or installed-package list beyond version metadata. No password, token, cookie,
authorization header, payment value, or raw test data — in any of the three
reports. A `file://` target is reduced to `file://`, so a local path never leaks.

A caller-supplied identifier is **rejected**, not trimmed, when it looks like a
credential, a URL, or a path. A quiet trim would half-write a secret into a
durable report; a refusal tells you immediately.

### The environment fingerprint

`fingerprint` is `sha256` over a canonical, fixed-order serialization of the safe
fields. Two runs of the same configuration produce the same value.

**Excluded from the hash**, because each would make otherwise-identical runs
differ: timestamps, attempt number, duration, report paths, temporary directories
and random ids.

**A fingerprint is an identity aid, not proof.** A matching fingerprint means the
recorded safe fields agree. It does **not** prove two systems are the same system:
the same Chromium build against two different application versions produces
identical fingerprints unless the caller supplies `--app-build-id`. That is why the
build and environment IDs are inputs when supplied, and why the fingerprint is
documented as an aid rather than a guarantee.

### Same / different / unknown

Every reproduction result carries an environment comparison:

| Value | Meaning | Reported as |
| --- | --- | --- |
| `same` | The recorded safe inputs match | "Reproduced in the same recorded environment." |
| `different` | At least one recorded input differs | "Reproduced across different recorded environments (differing: applicationBuildId)." |
| `unknown` | A report lacks provenance | "Reproduction occurred, but provenance was incomplete." |

**The comparison never changes the classification.** A signal that reproduces across
different environments is still `reproduced`; the difference is recorded alongside
so a reader can weigh it. Letting provenance overturn a verdict would make the two
contradict each other, and the classification is the one backed by evidence.

### Test-data identity

`--data-id` records an opaque fixture identifier. `--hash-test-data` additionally
records a SHA-256 of the fixture **bytes** — opt-in, and the file is only read when
the flag is present.

A plain hash is an identity marker, **not** secret protection: someone who already
knows the possible input can compare against it. That is why hashing is opt-in and
why an explicit `--data-id` is the preferred mechanism. Neither the fixture path nor
its contents is ever written to a report.

### Legacy reports

Reports written before Build 5.1 have no `environment` object. They load normally:

- a missing provenance reads as `unknown`, never as an invented fingerprint
- `anomalies.json` adds the warning *"Environment provenance is unavailable for this
  execution report."*
- no existing classification changes

Absent is never invented. A fabricated fingerprint would corrupt the very
comparison it exists to support.

### Environment identity is not bug confirmation

Provenance says **where** a signal reproduced. It says nothing about whether that is
a defect, and `confirmed: false` is unchanged on every result. Knowing a signal
reproduces in `build-002` but not `build-001` narrows an investigation; it does not
conclude one.

---

## Build 6: Baseline Registry and Candidate-Defect Review

Build 5 could say a signal recurred. It could not say whether that signal was *new*.

Build 6 adds the missing half: an explicit **known-good baseline** that a later run is
compared against.

> **No baseline means unknown, not novel.**

That principle is the reason a baseline is never inferred. A run that produced no
signals may simply have collected no evidence, and treating its absence of signals as
"known good" would make every future signal look novel — the exact failure a baseline
is meant to prevent. So a baseline is created **only** when a human says so.

### Creating a baseline

```bash
npm run baseline -- \
  --execution reports/execution.json \
  --anomalies reports/anomalies.json \
  --journey reports/journey.json \
  --baseline-id local-shop-good-v1 \
  --name "Local shop known-good baseline" \
  --confirm-known-good
```

`--confirm-known-good` is required. Without it nothing is created, nothing is read,
and the command exits `1`.

The run is also refused when it is not a safe, meaningful state: an aborted or
blocked execution, a run without safe-test mode, a run where every step was skipped
or blocked, or unresolved error-level signals.

To record a state where a signal is *expected*, accept it explicitly:

```bash
npm run baseline -- ... --accept-signal anomaly-001 --accept-signal anomaly-003 --confirm-known-good
```

`--accept-signal` is repeatable, is never inferred, and is stored in the baseline so
the record is auditable. An id that matches no present anomaly is refused.

Baselines are **immutable**: a duplicate id is refused rather than overwritten. A new
state gets a new id, because the old record is the only thing that makes "changed"
detectable.

### Running a review

```bash
npm run review -- \
  --baseline reports/baselines/local-shop-good-v1.json \
  --execution reports/execution.json \
  --anomalies reports/anomalies.json \
  --reproduction reports/reproduction.json \
  --journey reports/journey.json
```

Output goes to `reports/candidates.json`. Both `--baseline` and `--reproduction` are
optional: without a baseline everything is `unknown`, and without a reproduction
nothing has been shown to recur, so nothing can be a candidate. Use
`--no-reproduction` to skip reading that report.

### Baseline identity

A baseline records target origin, journey hash, journey schema version, journey type,
environment fingerprint, and the build and environment ids when supplied. Two runs are
comparable only when those agree.

The **journey hash** covers canonical plan content — goal, journey type, and each
step's id, order, action, targets and locators. A reworded description does not change
it; a changed action or locator does. That is what makes "the plan changed" detectable
without churning a baseline over cosmetics.

### Compatibility

| Comparison | Meaning |
| --- | --- |
| `same-environment` | Compatible, and the environment fingerprint matches |
| `different-environment` | Compatible target and journey, different environment |
| `unknown-environment` | Provenance is missing on either side |
| `different-build` | Application build ids differ |
| `incompatible-journey` | Journey hash, type, schema, or target origin differs |
| `no-baseline` | Nothing to compare against |

A different target origin, a different journey, or a different application build means
the signal sets are **not compared**. Reporting signals from two different
applications as "novel" would be actively misleading.

### Classifications

| Classification | Meaning | Review status |
| --- | --- | --- |
| `novel` | Reproduced, and absent from a compatible baseline | `needs-review` |
| `persistent` | Present in both; already expected | `known-existing` |
| `resolved` | In the baseline, absent now | `not-present` |
| `changed` | A related signal exists in both but a safe detail differs | `needs-review` |
| `cross-environment` | Reproduced, but in a different recorded environment | `needs-review` |
| `different-build` | Reproduced, but against a different application build | `needs-review` |
| `unknown` | No baseline, incompatible, or not reproduced | `inconclusive` |

**Reproduction gates every real verdict.** A signal becomes `novel` only if Build 5
classified it `reproduced` *and* a compatible baseline did not contain it. An
unreproduced, inconclusive or blocked signal is `unknown` with a stated reason — a
one-off observation is as likely transient as it is a fault, and promoting it would
train a reviewer to ignore the queue.

**`novel` does not mean `defective`.** It means "not present in this baseline". A
signal may be entirely expected behaviour the baseline predates.

### Immutability and redaction

Baseline creation and review read their inputs and write only new files. `journey.json`,
`execution.json`, `anomalies.json`, `reproduction.json` and existing baselines are never
mutated. Candidate reports reference those artifacts by path rather than inlining
them, and carry no raw evidence, no absolute path, and no test-data value.

### Build 6 does **not** do

- No AI, model, or external API.
- No dashboard, backend, database, or billing — storage is a directory of JSON files.
- No automatic bug confirmation, severity ranking, root-cause analysis, or fix
  suggestion. `confirmed: false` is structural, not a default.
- No change to any existing classification: `passed`, `failed`, `blocked`, `skipped`,
  `observed`, `reproduced`, `not-reproduced` and `inconclusive` all mean what they
  meant before.
- No browser execution and no network calls.

### Build 5 does **not** do

- No AI, model, or external API.
- No root-cause analysis, severity ranking, or fix suggestions.
- No unlimited retries or hidden retry loop.
- No journey mutation, plan repair, or automatic retry of a step.
- No modification of `journey.json`, `execution.json`, or `anomalies.json`.

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
| `--no-screenshots` | off | Do not capture screenshots |

There is deliberately **no `--safe-test-mode` flag**. Safe test mode is always on and
cannot be turned off, so a live payment path cannot be enabled from the CLI.

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

### Safe test mode is always on

Safe test mode is the default and has no opt-out. A payment-adjacent step is
**blocked before any browser interaction**, recorded with reason `payment-blocked`,
and no payment data is read, filled, or submitted.

The guard is deliberately over-inclusive and checks several independent signals, so
it is not defeated by a single wording choice:

| Layer | Example |
| --- | --- |
| Journey type | any `submit` inside a `checkout` / `purchase` / `ticket_purchase` journey |
| Step intent | `identify_payment_control`, `place_order` |
| Step prose | "payment", "card number", "CVV", "billing", "checkout" |
| Provider names | Stripe, PayPal, Razorpay, Adyen, Klarna, UPI, netbanking |
| **The live control's text** | a plan worded neutrally that lands on a "Pay now" button |

A `fill` is guarded too: typing a card number is a step toward a charge even if the
submit is never reached.

Navigation inside a checkout journey is *not* blocked — only the terminal submission
is. Blocking every click in a checkout journey would make the tool useless, and the
safety property that matters is that no charge can be placed.

### Screenshot omission after sensitive data

The initial screenshot is captured before anything is typed. Once a `fill`, `select`
or `upload` has put a value on the page, **every later screenshot is omitted**,
including the one for the step that typed it, the failure screenshots, and the final
one. Each omission is recorded:

```jsonc
"screenshot": null,
"screenshotOmitted": true,
"screenshotOmittedReason": "sensitive-data-entered"
```

The run summary also reports
`redaction.screenshotsOmittedAfterSensitiveData: true`.

This is omission, not masking, and the choice is deliberate. Playwright's `mask`
covers elements you name, but a page can echo a value anywhere — a confirmation
banner, a URL, a hidden input — and JSON redaction cannot reach inside a bitmap.
Omitting is honest; masking would imply a guarantee that cannot be made. There is no
OCR or AI-based screenshot scanning.

The `evidence/` directory is gitignored, because a screenshot shows whatever was on
the page.

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
committed fixture (`tests/fixtures/executor-test-data.json`) uses fake addresses and
a deliberately fake password. Real credentials go in an untracked local file
(`test-data.local.json` and `*.test-data.json` are gitignored).

A generated plan's `fill` step carries only its target — an element id and a locator.
The value is never in the plan, so the plan can be committed, shared, or replayed
without leaking anything. Supplying the value is always a separate, deliberate act at
execution time.

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
| `blocked` | The step could not be attempted safely: ambiguous, hidden, disabled, missing data, payment guard, or an external-origin navigation |
| `skipped` | There was nothing to act on — the planner produced no target for this step |

`skipped` is distinct from `blocked` on purpose. A plan step the planner matched
nothing against is a legitimate observation, not a safety refusal, and it does not
stop the run. `blocked` means CrashLab *declined* to act.

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

### Build 3.1: generated plans are now actionable

Build 2 originally emitted only `identify` and `assert`, so a generated plan could
never actually do anything. The planner now decides, from Scout evidence alone,
whether a matched control is specific enough to carry a real action.

A step becomes a real action only when **all** of these hold:

- exactly one candidate, so the target is unambiguous,
- it is visible and enabled,
- the match score clears a strength threshold,
- for controls, the element's own visible text matches an approved phrase **exactly**,
- a stable locator exists.

Anything else stays `identify` and records a warning explaining why. In practice:

| Situation | Result |
| --- | --- |
| One visible, enabled `Add to cart` button | `click` |
| One labelled email or password input | `fill` (no value, ever) |
| A labelled quantity `<select>` | `select` |
| A `Help` or `View cart` navigation link | stays `identify` — not an exact purchase phrase |
| Two identical `Buy` buttons | stays `identify`, warning: ambiguous match |
| A hidden or disabled control | stays `identify`, never an action |
| A payment or order-placement control | stays `identify`, **always** |

That last row is a hard rule: the planner never plans a payment submission as an
action, so a generated plan cannot reach a charge even before the executor's guard
sees it.

The planner remains pure and imports no Playwright, output remains deterministic, and
`schemaVersion` stays `1.0`. Confidence still measures evidence quality, not the
probability that a step will succeed.

### Build 3.1: a step with no target is skipped, not blocked

A Build 3 executor that had only ever seen hand-authored plans treated a step with no
locator candidates as `blocked`, which aborted the run. That was wrong: a plan step the
planner matched nothing against is a legitimate observation, and later steps may still
be actionable. Such steps are now `skipped`, and only `failed` or `blocked` stop a run.

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
    anomalyCommand.ts the Build 4 `anomalies` command
    reproduceCommand.ts the Build 5 `reproduce` command
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
    actionability.ts  PURE (3.1): is a match specific enough to act on?
    structuredAssertion.ts PURE (6.2): assertion types, validation, generation
    postcondition.ts     PURE (6.3): form-action postcondition derivation
    assertionCleanup.ts  PURE (6.4): redundant terminal-assertion detection
    confidence.ts     PURE: evidence -> 0..1 confidence
    plan.ts           PURE: composition into ordered steps + diagnostics
    report.ts         plan persistence + terminal summary
  executor/           Build 3 - only executor.ts and the action handlers
    types.ts               the execution report contract
    planValidator.ts       PURE: plan loading and contract validation
    testData.ts            PURE: test-data resolution and fixture-path limits
    redaction.ts           PURE: scrubbing and redacted value summaries
    assertionClassifier.ts PURE: structured vs prose-only vs targeted-prose
    structuredAssertionRunner.ts  evaluates a structured assertion (6.2)
    postconditionRunner.ts       evaluates submit postconditions (6.3)
    verification.ts        PURE: the completion model and verification record
    locatorResolver.ts     plan locator strings -> Playwright locators
    executionContext.ts    per-step budget, origin and payment guards
    actionDispatcher.ts    the nine actions
    evidence.ts            evidence capture, reusing Build 1 recorders
    executionReport.ts     PURE: report assembly + terminal summary
    executor.ts            the one place a browser is launched
  anomaly/           Build 4 - pure, no Playwright and no network
    types.ts         the anomaly report contract + stable rule ids
    validator.ts     PURE: structural validation of both input artifacts
    redaction.ts     PURE: shape-based scrubbing of text, URLs and stacks
    rules.ts         PURE: the deterministic rules
    classifier.ts    PURE: dedup, stable ordering, stable ids
    report.ts        PURE: report assembly + terminal summary
  reproducer/        Build 5 - matching and classification are pure
    types.ts         the reproduction contract and its limits
    inputLoader.ts   PURE: validation of the anomaly and journey inputs
    normalization.ts PURE: run-to-run noise removal and matching keys
    eligibility.ts   PURE: which signals are worth rerunning
    resultClassifier.ts PURE: reproduced / not-reproduced / inconclusive
    attemptRunner.ts runs one attempt via the existing executor
    reproductionReport.ts PURE: report assembly + terminal summary
    reproducer.ts    orchestration and the safety gates
  provenance/        Build 5.1 - pure, no browser and no network
    types.ts         the provenance contract
    redaction.ts     PURE: identifier validation and target-origin extraction
    fingerprint.ts   PURE: canonical serialization and SHA-256
    comparison.ts    PURE: same / different / unknown
    reportMetadata.ts  safe fact collection and record assembly
  baseline/         Build 6 - pure, file-based storage
    types.ts         the baseline contract
    identity.ts      PURE: journey hash and signal projection
    validator.ts     PURE: may this run be a known-good state?
    writer.ts        immutable file storage and the registry index
  review/           Build 6 - pure, no browser and no network
    types.ts         the candidate contract
    compatibility.ts PURE: may these two runs be compared at all?
    classifier.ts    PURE: novel / persistent / resolved / changed / unknown
    candidateReport.ts  report assembly + terminal summary
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

Build 4 extends the boundary one step further: **the whole of `src/anomaly/` is
pure.** It imports no Playwright, opens no browser, and makes no network call. Its
only I/O is reading `execution.json` and `journey.json` and writing
`anomalies.json`.

Build 5 inverts the browser boundary: the reproducer *is* allowed a browser, but it
reaches one only by calling the existing Build 3 executor in process. It duplicates
no action logic and no anomaly rules — `attemptRunner.ts` reuses the executor, and each
attempt's signals come from re-running the same Build 4 classifier. Everything
deciding *what* to compare — normalization, eligibility, classification — is pure
and unit-tested without a browser.

Build 5.1 keeps that split even inside a build that does touch a browser: everything
that *decides* provenance — validation, fingerprinting, comparison — is pure. Only
the browser version is read from the live session, and the Playwright version from
local package metadata, so no provenance work launches a browser or makes a network
call of its own.

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

- The payment guard reads the live control's text, so it depends on the page being
  reachable and readable. A control whose visible text is empty (an icon-only
  button with no accessible name) is caught only by the other layers.
- Locator support covers the forms Build 2 emits plus plain CSS. A hand-written
  plan using chained or `nth()` locators is refused as unsupported rather than
  half-executed.
- `assert` only checks presence, so generated plans stop on their final prose
  assertion. This is a Build 3.1 consequence: the terminal step of most generated
  plans is observational, and prose is never interpreted.
- Test-data resolution requires a semantic key or an element id. There is no
  blanket fallback, so a step with an unrecognised intent needs an explicit key.
- The executor does not verify the page still matches the Scout report. A stale
  plan executes against whatever is now at that URL.
- Screenshot omission is a blunt instrument: after any fill, *every* later
  screenshot is dropped, including useful ones. That is the intended trade.
- A single run is a single sample. Nothing here distinguishes a flaky step from a
  consistently broken one — that requires Build 5.
- Action generation depends on an element's *own* visible text matching an
  approved phrase. A well-labelled control with an icon and no text stays
  observational, which is the conservative side of the trade.

### Build 4 (Anomaly Engine)

- Signals are classified per event, not correlated. A 500 and a page error during
  the same request are two signals; deciding they are one incident is Build 5's
  job with reproduction to support it.
- Attribution is coarse. `rawEvidence` is a run-level array with no per-step
  window in the report, so most evidence-based signals carry a step id of `null`
  and point at an event index instead. Per-step evidence exists but does not
  always cover the whole run.
- `DUPLICATE_REQUEST` keys on method + URL + resource type, so a legitimate retry
  with the same body looks identical to a bug. It is reported at `info` and marked
  `possiblyExpected` for asset types, but a reviewer must judge it.
- `UNEXPECTED_ORIGIN` compares against the execution target's origin. A journey
  whose own steps are *supposed* to leave the target will always raise it; there is
  no per-step expected-origin field in the current schema to consult.
- Console warnings are off by default, so a warning-only regression is invisible
  unless `--include-console-warnings` is passed.
- Redaction is pattern-based, not exhaustive. An unusual secret format could pass
  through; the engine scrubs known shapes and relies on Build 3 having already
  redacted at the source.

## Build 6.2: Structured Assertions

Build 6.1 made an unevaluable expectation honest. Build 6.2 makes it *checkable* —
but only where Scout already observed the evidence.

### What a structured assertion is

An optional `assertion` field on a journey step, holding an expectation a browser can
actually check:

```jsonc
{
  "action": "assert",
  "expectedOutcome": "The declared destination is reached: the path is /cart.",
  "assertion": {
    "type": "url-path",
    "expectedPath": "/cart",
    "match": "exact",
    "source": { "kind": "scout-href", "elementId": "element-001", "field": "href" }
  }
}
```

Every assertion names its `source` — the Scout element or field it was read from. An
assertion that cannot name its evidence is dropped rather than carried, so the
executor treats it as prose. That is the same safe outcome as having none.

### Supported types

| Type | Checks | Example source |
| --- | --- | --- |
| `url-path` | The page path matches | a link's `href` |
| `url-origin` | The page origin matches | a link's `href` |
| `element-present` | The target exists | a Scout element |
| `element-visible` | The target is visible | a Scout element |
| `element-enabled` | The target is enabled | a Scout element |
| `text-contains` | The target's text contains a string | Scout-visible text |

### The planner's conservatism

**A structured assertion may only restate what Scout observed.** Nothing is inferred
from the goal's wording, and no expected value is ever invented. Concretely, the
planner declines when:

- the clicked control is a bare button, which declares no destination
- the destination's path contains a generated id — `/orders/550e8400-e29b-…` is
  data-dependent, so asserting on it would fail spuriously or pass for the wrong reason
- the expected text would be secret-bearing, overlong, or not directly observed
- the target is a hidden or secret-bearing control, or is ambiguous
- the journey is payment-adjacent and the control is a form submission

So a login journey, whose form declares no postcondition, keeps its prose
expectation and stays partially verified. That is the correct answer: **a confident
assertion that cannot fail is worse than an honest one that was not made.**

### Prose remains the fallback

The prose path is unchanged and still first-class:

```jsonc
{
  "action": "assert",
  "expectedOutcome": "The expected post-login state is not represented in the Scout report and must be observed at execution time."
}
```

Existing `journey-plan-v1` documents without an `assertion` field are valid and
execute exactly as they did in Build 6.1: skipped, unverified, partial verification.
`schemaVersion` is unchanged — an optional field is not a breaking contract change.

### Executor behaviour

| Case | Result |
| --- | --- |
| Valid assertion, expectation met | `passed`, with `assertion.result: "matched"` |
| Valid assertion, expectation not met | `failed`, with `assertion.result: "not-matched"` |
| Unevaluable or unsupported | `skipped` and unverified — never a failure |
| No assertion (legacy or declined) | Build 6.1's prose behaviour, unchanged |

**A failed assertion is not a confirmed bug.** It means the expectation did not hold
this time. Whether that is a defect, a timing artefact, or a changed page is not
decided here.

### Verification impact

A journey whose assertions are all evaluated reaches `complete` / `full-plan` and is
eligible for a **normal** baseline. One that keeps a prose expectation still reaches
`partial` / `executed-steps-only` and needs `--allow-unverified-assertions`, exactly
as in Build 6.1. The planner cannot claim full-plan verification by merely *adding*
an assertion object — only the executor's evaluation can.

### Redaction

An assertion result records the type, the match outcome, and for URL assertions the
actual origin or path. It never records a password, token, cookie, payment value,
form value, secret URL, or full sensitive page text. Text assertions report *whether*
the expected string was found, never the page's own text — a page can echo back a
value the executor typed moments earlier.

Build 6.2 adds no AI. The planner remains a pure, deterministic function of the goal
and the Scout report, with no Playwright import and no model call.

---

## Build 6.3: Stateful Form Postconditions

Most generated journeys still ended partially verified, because a form submission's
outcome is not visible when Scout first runs. Build 6.3 closes that gap for the
common case: a form that declares its own destination.

### A postcondition is not a business outcome

> **CrashLab can verify that a form reached a declared destination. It cannot
> infer that the business operation succeeded unless a separate, evidence-backed
> assertion exists.**

`<form action="/thank-you">` proves the browser was told to go there. It proves
nothing about whether the order was placed, the payment cleared, or the message was
delivered. A matched postcondition means **navigation happened** — nothing more.

### Why it attaches to the submit step

```jsonc
{
  "id": "step-005",
  "action": "submit",
  "postconditions": [
    {
      "type": "url-path",
      "expectedPath": "/thank-you",
      "match": "exact",
      "source": { "kind": "scout-form-action", "elementId": "contact-form", "field": "action" }
    }
  ]
}
```

The postcondition lives **on the action that causes it**, not on a detached final
assertion. That means the executor checks it immediately after the submit that can
influence it, rather than after unrelated steps. A detached assertion would be
evaluated against state the submit never touched.

Only `url-path` and `url-origin` qualify. An element or text expectation is a
journey assertion, not a postcondition, and the validator drops it if it appears here.

### Derivation rules

Scout already captures `forms[].action`, `forms[].id` and each element's
`formIndex`, so **no Scout change was needed**. A postcondition is derived only when
every one of these holds:

| Rule | On failure |
| --- | --- |
| The form declares a non-empty `action` | `no-action-attribute` / `empty-action` |
| The action is not a `javascript:` or `data:` URL | `javascript-destination` |
| The action has no unresolved `{id}` / `:id` placeholder | `unresolvable-destination` |
| The action is **not** payment-adjacent | `payment-form` |
| The destination is same-origin | `cross-origin` |
| The path holds no secret-bearing word | `secret-bearing-path` |
| The path contains no generated id | `dynamic-path` |

A refusal is always silent in the plan's structure but explicit in its reasoning: the
prose fallback stands and no postcondition is invented. **A form action such as
`/payment-success` does not make payment execution safe** — it is a reason for extra
caution, so no postcondition is derived from it at all.

### Execution behaviour

| Case | Result |
| --- | --- |
| Destination reached | step `passed`, postcondition `matched` |
| Destination not reached | step `failed`, postcondition `not-matched` |
| URL unreadable | step `skipped` and unverified — never `failed` |
| No postcondition available | unchanged Build 6.1 submit behaviour |

Navigation is awaited with the run's **existing timeout** and `domcontentloaded`; there
are no arbitrary sleeps. A fixed delay would be a guess about the target's speed, and
a guess becomes a false "not-matched" on a slow machine.

A failed postcondition means the action was attempted and the declared navigation did
not occur. It does **not** mean a confirmed application bug, a confirmed backend
failure, or a confirmed business failure. Verification stays out of `complete`, so the
run cannot become a fully verified baseline.

### Safety controls are unchanged

The payment guard runs **before** the postcondition, so a payment submit is refused
and no postcondition is ever evaluated. Screenshot omission after sensitive data, the
cross-origin policy, test-data requirements, and safe-test mode are all untouched. No
new payment path exists, and no postcondition can launder an action failure into
success.

### Scout compatibility

No Scout change was needed — `action` and `formIndex` were already recorded. Old
`scout.json` files work unchanged, and a plan with no `postconditions` field executes
exactly as it did in Build 6.2.

---

## Build 6.4: Removing Redundant Prose Assertions

Build 6.3 could attach a structured postcondition to a submit step, but the planner
still appended a placeholder — "Define the expected successful outcome" — that no
executor can evaluate. That placeholder was skipped, recorded as unverified, and
held the whole run at `partial` forever, even when the postcondition beside it had
already verified the outcome.

> **A structured postcondition may replace a generic expectation only when it
> measures the same observable outcome.**

### What qualifies as redundant

A terminal assertion is removed only when **all** of these hold:

1. it is an `assert` step
2. it has no structured `assertion` object
3. it has no `targetElementIds`
4. it has no usable `locatorCandidates`
5. it is a **planner-generated placeholder** — matched by the planner's own intent
   name (`define_form_success`, `define_login_success`, …) *and* generic prose
6. an **earlier** `submit` or `click` step carries an evaluable postcondition
7. that postcondition covers the same observable outcome

The planner-intent match is what makes this reliable. It is not string-guessing:
the planner generated these steps, so it knows their names. A hand-authored plan
carrying a real expectation will not have one, and is therefore never a candidate.

### What must be preserved

The default is to **keep** the assertion. A placeholder nobody can check is
annoying; a real expectation quietly deleted is a lie. So it survives when it has a
structured assertion, a target, a usable locator, concrete prose under a planner
intent ("The order total is exactly 42.00 USD."), or refers to a separate outcome
the postcondition says nothing about ("The confirmation message says the request was
received."). Payment and safety information is never removed.

The postcondition must also appear **earlier** in the journey. A later action cannot
justify deleting an assertion that runs before it.

### Navigation is not business success

When a placeholder is removed, the surviving action's `expectedOutcome` is rewritten
to describe exactly what the postcondition checked:

> The page reaches the declared path /thank-you. This confirms navigation, not
> that the operation succeeded.

A URL check never becomes a claim about payment, orders, accounts, email, or
persistence. No postcondition is ever added to hide a failure, and a failed one stays
a failure.

### Verification and baselines

| Plan shape | Result |
| --- | --- |
| Submit with a postcondition, placeholder removed | `complete`, `unverifiedAssertions: 0` — eligible for a normal baseline, no flag |
| No declared destination | `partial` — the placeholder is kept and still needs `--allow-unverified-assertions` |
| Postcondition fails | `incomplete`/`failed` — ineligible for a verified baseline |

Removal is deterministic, uses no module-level state, and every decision is recorded
in the plan's assumptions, so a reader can tell a *removed* placeholder from an
*overlooked* one.

Build 6.4 adds no AI. The decision is a pure rule over the plan's own steps, with
no natural-language interpretation.

## Build 6.5: Operator-Declared Expectations for SPA/JS Flows

Modern JavaScript and single-page applications often do not expose destinations to
Scout. A form may have no `action` attribute, JavaScript may intercept submission,
`fetch` or `XMLHttpRequest` may send data without navigation, `history.pushState`
may change the URL without a page load, and success may be a DOM state change
rather than a route. In all of these cases, CrashLab cannot honestly derive a
postcondition from Scout evidence.

Build 6.5 adds an external, typed expectation configuration
(`reports/expectations.json`) where operators explicitly declare postconditions
for these flows. This is a **separate trust model** from Scout-observed evidence:
operator-declared expectations are never merged with, or presented as, Scout
observations.

### File format

```json
{
  "schemaVersion": "1.0",
  "journeyPlanHash": "sha256:...",
  "expectations": [
    {
      "id": "exp-001",
      "afterStepId": "step-1",
      "type": "url-path",
      "expectedPath": "/success",
      "match": "exact",
      "source": "operator-declared",
      "reason": "SPA success route after form submission"
    }
  ]
}
```

### Supported types

- `url-path` — checks the page path after the step. Supports `exact` and
  `starts-with` match modes.
- `url-origin` — checks the page origin after the step. Supports only `exact`.

### Validation rules

- Only `source: "operator-declared"` is accepted. Scout-observed, evidence-backed,
  automatically-derived, and confirmed sources are rejected.
- Expectations bind to the exact journey hash (`journeyHash(journey.json)`).
- Each expectation must reference an actionable step (`click`, `submit`, or
  `navigate`).
- Rejected paths: UUID/ULID paths, date-generated paths, long random tokens,
  secret-bearing paths, unresolved placeholders, credentials, cross-origin
  destinations, and payment-related expectations.

### CLI integration

```bash
# Execute with operator-declared expectations
npm run execute -- --journey reports/journey.json --expectations reports/expectations.json --confirm-authorized

# Reproduce with the same expectations across all attempts
npm run reproduce -- --anomalies reports/anomalies.json --journey reports/journey.json --expectations reports/expectations.json --confirm-authorized

# Create a baseline from a run that used declared expectations
npm run baseline -- --execution reports/execution.json --anomalies reports/anomalies.json --journey reports/journey.json --baseline-id spa-baseline --confirm-known-good --allow-declared-expectations
```

### Baseline behavior

A baseline created from a run that used operator-declared expectations requires
both `--confirm-known-good` and `--allow-declared-expectations`. The baseline
status becomes `known-good-declared`, and coverage is recorded as
`operator-declared`, never `full-plan`. This honestly reflects that the
verification came from operator declaration, not from Scout-derived evidence.

### Reproduction behavior

When `--expectations` is supplied to the reproduce command, the same expectations
file is used for every attempt, so conditions are held constant across reruns.
The reproduction report records the expectations metadata (journey plan hash,
expectation count, and source) so a reader can verify which configuration was
used.

### Safety rules

An expectation is an observation target, not permission to execute an action.
Operator-declared expectations do not authorize any new behavior: they only
describe what to check after an action the journey plan already performs. The
executor still enforces all existing safety guards (safe test mode, payment
blocks, origin policy) regardless of what expectations declare.

### Provenance and redaction

The execution report records `expectationFileHash` (SHA-256 over the canonical
expectations content) for provenance and reproduction consistency. The hash is
deterministic and order-independent due to canonicalization. No expectation
content is inlined into the report; only the hash and count are recorded.

## Build 8: Persistent Candidate Review State

Build 8 adds durable, file-based recording for human review decisions (`npm run review-state`).

### Separation of Concerns

The architecture strictly separates three concerns:

1. **What CrashLab observed:** raw execution events, console logs, network activity, and page errors (`execution.json`, `anomalies.json`).
2. **What CrashLab automatically classified:** deterministic candidate defects derived from baseline comparison and reproduction (`candidates.json`, `reproduction.json`).
3. **What a human decided:** operator triage, investigation progress, duplicate links, notes, and resolution (`reports/review-state/`).

A human review state **never** rewrites or upgrades an automatic classification. A candidate classified as `unknown` remains `unknown`. `confirmedBug: false` and `confirmed: false` remain strictly false on every report and projection.

### Non-Negotiable Storage Principles

- `execution.json`, `journey.json`, `anomalies.json`, `reproduction.json`, `candidates.json`, and baseline files are **strictly immutable**.
- Review state is stored in an independent directory: `reports/review-state/`.
- No database, no frontend, no network calls, no authentication, and no AI are added.

### Storage Architecture

Review state uses an append-only event log with a deterministic derived projection:

```
reports/review-state/
  events.jsonl   append-only stream of review events
  state.json     deterministic current-state projection
```

- **`events.jsonl`:** Each review decision appends an immutable JSON record with `schemaVersion`, `eventId`, `candidateId`, `previousStatus`, `newStatus`, `reviewer`, `note`, `duplicateOf`, `timestamp`, `previousRevision`, `revision`, `sourceCandidate`, `automaticClassification`, and `confirmed: false`.
- **`state.json`:** A pure projection computed from the event history. Contains all candidates sorted deterministically by candidate ID, their current status, timestamps, revision count, latest note, reviewer, and explicit disclaimers.

### Candidate Identity

Review state depends on stable candidate identity. A candidate's ID must not shift when reports are reordered or other signals appear.

CrashLab derives a canonical candidate identity (`cand-<16-hex>`) deterministically from:
- Target origin (sanitized)
- Canonical journey plan hash (`journeyHash`)
- Application build identity (when present)
- Anomaly rule ID (`ruleId`)
- Normalized signal key (`signalKey` via `matchingKeyFor`)
- Step ID (when step-scoped)

This identity is invariant to:
- Array position and report ordering
- Timestamp and execution duration
- Temporary paths and output filenames
- Unrelated candidates in the same run

For backward compatibility, candidates in `candidates.json` retain their sequential `id` (`candidate-001`, `candidate-002`) while carrying `candidateId` (`cand-...`). The `review-state` CLI accepts either format.

### Statuses and Transitions

Supported review statuses:
- `open` — unreviewed or reopened candidate.
- `investigating` — actively being investigated by a reviewer.
- `accepted` — human operator acknowledges the issue as genuine (does not alter automatic severity or confirm a bug).
- `dismissed` — reviewed and discarded as expected behavior or not actionable.
- `duplicate` — duplicates an existing candidate (`--duplicate-of` required).
- `resolved` — issue has been resolved/handled.

#### Transition Matrix

- `open`, `investigating`, `accepted` can transition forward to any valid status.
- Terminal statuses (`dismissed`, `duplicate`, `resolved`) must be explicitly reopened to `open` before any further transition is permitted.
- Invalid transitions are rejected before writing, leaving files untouched.

### Duplicate Handling

- Status `duplicate` requires `--duplicate-of <candidate-id>`.
- Self-duplication (`A -> A`) is rejected.
- Transitive duplicate chains (`A -> B` where `B` is already a duplicate) are rejected.
- Cyclic duplicate loops are detected and rejected.

### Reviewer and Note Safety

- **Reviewer Identity:** Validated as a safe identifier (letters, digits, dot, underscore, hyphen; max 64 chars). Control characters, path separators, tokens, and passwords are rejected.
- **Notes:** Bounded to 1,000 characters. Control characters and embedded credentials (bearer tokens, basic auth, JWTs, card numbers, passwords) are rejected.

### Recovery and Rebuilding

If `state.json` is missing or tampered with:
- Consistency checks detect any mismatch between `events.jsonl` and `state.json` and refuse unsafe writes.
- `npm run review-state -- --rebuild` deterministically re-projects `state.json` directly from `events.jsonl`.

### CLI Commands

```bash
# Set status to investigating with reviewer and note
npm run review-state -- \
  --candidate cand-ab5442b3310b9b4d \
  --status investigating \
  --reviewer kamal \
  --note "Reproduced locally; checking the checkout service"

# Using positional candidate alias
npm run review-state -- \
  --candidate candidate-001 \
  --status accepted \
  --reviewer kamal \
  --note "Confirmed issue in checkout error handling"

# Mark candidate as duplicate of another
npm run review-state -- \
  --candidate candidate-002 \
  --status duplicate \
  --duplicate-of candidate-001 \
  --reviewer kamal

# Reopen a dismissed or resolved candidate
npm run review-state -- \
  --candidate candidate-001 \
  --status open \
  --note "Reopened after finding in staging"

# List candidates and review states
npm run review-state -- --list

# Show full history of a candidate
npm run review-state -- --show candidate-001

# Rebuild projection
npm run review-state -- --rebuild
```
