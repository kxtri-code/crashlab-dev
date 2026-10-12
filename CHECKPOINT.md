# CrashLab — Build 2 Checkpoint

A stable, verified snapshot of the completed Build 2 state. Build 3 starts from here.

- **Checkpoint tag:** `build2-journey` — the verified Build 2 state
- **Contract tag:** `journey-plan-v1` — same commit as `build2-journey`; marks the
  `journey.json` schema version Build 3 must consume

> There is no separate Build 1 baseline tag. Build 2's changes to shared files
> (`src/cli.ts`, `src/index.ts`, `src/report/write.ts`, `package.json`) were made
> in place, so the pre-Build-2 state of those files cannot be reconstructed
> faithfully and no such tag is claimed. Build 1's behaviour is instead pinned by
> its 110 passing tests, which are part of this checkpoint.

## Verification at checkpoint time

| Check | Result |
| --- | --- |
| Full test suite | **266 passed** / 11 files |
| Build 1 tests | **110 passed** (7 files, incl. 26 browser tests) |
| Build 2 tests | **156 passed** (4 files) |
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0 |
| `journey.json` determinism | byte-identical across 3 runs for 6 different goals |
| `journey.json` schema | all 10 required top-level fields, no extras |
| Step schema | all 11 required fields present; every step `executable: false` |
| `source` traceability | mirrors `targetElementIds` on every step |
| Playwright imports in `src/journey/` | 0 |

## The `journey.json` contract (version "1.0")

Build 3 **consumes** this shape. It must not redesign it.

### Top level

| Field | Type | Notes |
| --- | --- | --- |
| `schemaVersion` | `string` | `"1.0"`. Bump only for a breaking shape change. |
| `goal` | `string` | Exactly as the user supplied it. |
| `normalizedGoal` | `string` | Lower-cased, whitespace-collapsed. |
| `journeyType` | `string` | One of the 11 supported types, or `unknown`. |
| `target` | `object` | `{ url, finalUrl, title }`, echoed from the Scout report. |
| `steps` | `array` | Ordered, 1-based. See below. |
| `assumptions` | `string[]` | What the planner assumed. |
| `warnings` | `string[]` | Uncertainty or ambiguity found. |
| `missingInformation` | `string[]` | What a later build would need. |
| `planner` | `object` | `{ mode: "heuristic", version: "0.1.0" }`. |

No timestamps, no random ids, no resolved absolute paths. The Scout report path is
echoed exactly as supplied.

### Step

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `string` | `step-001`, `step-002`, … |
| `order` | `number` | 1-based, matches array position. |
| `intent` | `string` | Machine-readable, e.g. `identify_password_field`. |
| `action` | `string` | One of `observe`, `navigate`, `identify`, `click`, `fill`, `select`, `upload`, `submit`, `assert`. **Descriptive only.** |
| `description` | `string` | Human-readable step. |
| `targetElementIds` | `string[]` | `element-NNN`, derived from the Scout element `index`. May be empty. |
| `locatorCandidates` | `string[]` | Deduplicated, stable order. May be empty. |
| `expectedOutcome` | `string` | What success would look like. |
| `confidence` | `number` | 0–1, from Scout evidence only. |
| `executable` | `false` | **Always `false` in Build 2.** |
| `source` | `object` | `{ report, elementIds }`. `elementIds` mirrors `targetElementIds`. |

### Journey types

`login`, `registration`, `checkout`, `purchase`, `ticket_purchase`, `form_submission`,
`search`, `contact`, `upload`, `navigation`, `unknown`.

### Element identity

`element-NNN` is `element-` + the Scout element's `index`, zero-padded to 3 digits, plus
one. `index: 0` → `element-001`. A journey step references Scout elements only through
these ids; the id is resolved back to a Scout element by that same arithmetic.

## Notes for Build 3

- `action` values are labels. Build 3 may interpret them; Build 2 never acted on them.
- `executable: false` is the contract boundary. A Build 3 step is a new artifact, not a
  mutation of this one.
- `confidence` is about Scout evidence quality, **not** the probability a journey passes.
  Do not read it as a pass/fail signal.
- `missingInformation` entries (test credentials, safe test payment method) are real
  blockers. An executor must refuse to run rather than invent them.
- A journey plan is **not** a finding and **not** a confirmed bug.

## Restore this state

```bash
git checkout build2-journey
```

or to compare Build 3 work against this checkpoint:

```bash
git diff build2-journey -- src/journey/
git diff build2-journey -- tests/unit/journeyPlan.test.ts
```

Any change to `src/journey/` should be a deliberate, documented decision — not an
accident of Build 3 implementation.

---

# CrashLab — Build 8 Checkpoint

A stable, verified snapshot of the completed Build 8 state: Persistent Candidate Review State.

- **Checkpoint tag:** `build8-review-state`
- **Contract tag:** `review-state-v1`
- **Schema version:** `"1.0"`

## Verification at checkpoint time

| Check | Result |
| --- | --- |
| Full test suite | **1,126 passed** / 36 files |
| Unit tests | **970 passed** (28 files) |
| Browser tests | **156 passed** (8 files) |
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0 |
| Immutability | byte-identical across execution, journey, anomalies, reproduction, candidates, and baselines |
| Working tree | clean |

## The Build 8 Contract (version "1.0")

Build 8 adds durable, file-based recording for human review decisions (`reports/review-state/`).

### Invariants and Boundaries

1. **Strict separation:** Human review records what an operator decided, never what CrashLab observed or automatically classified.
2. **No bug confirmation:** `confirmedBug: false` and `confirmed: false` remain false on every candidate, report, event, and projection.
3. **No classification upgrade:** Human review cannot change automatic classifications (`unknown`, `novel`, `reintroduced`, `persistent`, `resolved`, `changed`, `cross-environment`, `different-build`).
4. **No severity modification:** Human review cannot modify automatic severity or signal level.
5. **Evidence immutability:** `execution.json`, `journey.json`, `anomalies.json`, `reproduction.json`, `candidates.json`, and baseline files are never modified by review state.
6. **No external dependencies:** No database, no frontend, no network calls, no authentication, and no AI.

### Storage Layout

```
reports/review-state/
  events.jsonl    append-only JSONL log of review events
  state.json      deterministic projection of current candidate review states
```

### Event Record (`events.jsonl`)

| Field | Type | Notes |
| --- | --- | --- |
| `schemaVersion` | `string` | `"1.0"` |
| `eventId` | `string` | Deterministic unique id `evt-<12-hex>` |
| `candidateId` | `string` | Canonical candidate id `cand-<16-hex>` |
| `previousStatus` | `ReviewStateStatus \| null` | `null` on first event, matches previous `newStatus` |
| `newStatus` | `ReviewStateStatus` | Target status |
| `reviewer` | `string \| null` | Sanitized operator identifier (max 64 chars) |
| `note` | `string \| null` | Operator note (max 1,000 chars, no secrets) |
| `duplicateOf` | `string \| null` | Required for `duplicate`, null otherwise |
| `reason` | `string \| null` | Optional explanation |
| `timestamp` | `string` | ISO 8601 string |
| `previousRevision` | `number` | Integer revision before this event (0 on first event) |
| `revision` | `number` | `previousRevision + 1` |
| `sourceCandidate` | `object \| null` | Reference to report, signalKeyHash, ruleId |
| `automaticClassification` | `string` | Snapshot of automated classification |
| `confirmed` | `false` | **Always `false`** |

### Projected Candidate Record (`state.json`)

| Field | Type | Notes |
| --- | --- | --- |
| `schemaVersion` | `string` | `"1.0"` |
| `candidateId` | `string` | Canonical candidate id |
| `currentStatus` | `ReviewStateStatus` | Current projected status |
| `firstSeenAt` | `string` | Timestamp of initial event |
| `lastUpdatedAt` | `string` | Timestamp of latest event |
| `reviewer` | `string \| null` | Latest reviewer |
| `latestNote` | `string \| null` | Latest note |
| `duplicateOf` | `string \| null` | Target candidate id when duplicate |
| `revision` | `number` | Event revision counter |
| `eventCount` | `number` | Total events for this candidate |
| `lastEventId` | `string` | ID of latest event |
| `eventIds` | `string[]` | Ordered event IDs |
| `automaticClassification` | `string` | Snapshot of automatic classification |
| `confirmed` | `false` | **Always `false`** |
| `disclaimer` | `string` | Explicit invariant statement |

### State Transitions

- Active statuses (`open`, `investigating`, `accepted`) may transition forward to any valid status.
- Terminal statuses (`dismissed`, `duplicate`, `resolved`) must be explicitly reopened to `open`.
- Status `duplicate` requires `--duplicate-of` and rejects self-references, transitive duplicate chains, and cycles.
- Stale revisions and discontinuous event sequences are rejected.

### Known Limitations

- **Local single-process MVP:** Designed for file-based local or CI execution. Concurrency is guarded by optimistic revision continuity checks, but multi-user concurrent writes require filesystem coordination.
- **Natural-language notes:** Notes are free-text operator comments and are never parsed as evidence or automated test verdicts.
- **No ticketing integration:** Build 8 records state locally in JSON/JSONL without external ticketing or issue tracker sync.

---

# CrashLab — Build 9.1 Checkpoint

A stable, verified snapshot of the completed Build 9.1 state: Read-Only Review API.

- **Checkpoint tag:** `build9.1-review-api`
- **Contract tag:** `review-api-v1`
- **Schema version:** `"1.0"`

## Verification at checkpoint time

| Check | Result |
| --- | --- |
| Full test suite | **1,169 passed** / 39 files |
| Unit tests | **1,013 passed** (31 files) |
| Browser tests | **156 passed** (8 files) |
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0 |
| Immutability | byte-identical across execution, journey, anomalies, reproduction, candidates, baselines, and review-state |
| Determinism | byte-identical SHA-256 response bodies across 3 repeated runs for all API routes |
| Working tree | clean |

## The Build 9.1 Contract (version "1.0")

Build 9.1 exposes CrashLab's candidate defect reports, automatic classifications, human review states, event history, baseline registries, and run context over a safe, local, deterministic HTTP API (`npm run review-api`).

### Invariants and Boundaries

1. **Read-only enforcement:** Accepts only `GET` and `HEAD` requests. Any mutation attempt (`POST`, `PUT`, `PATCH`, `DELETE`) returns `405 Method Not Allowed` with an `Allow: GET, HEAD` header.
2. **Strict separation:** Automatic classification, observations, and human review status remain strictly distinct.
3. **No bug confirmation:** `confirmedBug: false` and `confirmed: false` remain false across all candidate records, summaries, baselines, and history responses.
4. **Evidence & state immutability:** Serving requests never modifies, creates, or deletes any files in `reports/` or filesystem artifacts.
5. **No execution:** The API never executes browser actions, launches journeys, or interacts with remote targets.
6. **No database or external network:** Operates solely over local JSON/JSONL reports; never calls external networks or AI models.
7. **Deterministic output:** Identical backing artifacts and request queries produce byte-identical responses via recursive key sorting.

### Implemented Routes

| Route | Method | Description |
| --- | --- | --- |
| `/health` | `GET`, `HEAD` | Health check (`ok: true`, `service: "crashlab-review-api"`, `readOnly: true`, `schemaVersion: "1.0"`) |
| `/api/summary` | `GET`, `HEAD` | Aggregated candidate summary counts, baseline summary, and provenance |
| `/api/candidates` | `GET`, `HEAD` | Paginated and filtered candidate defect list, deterministically ordered |
| `/api/candidates/:id` | `GET`, `HEAD` | Candidate detail (canonical `cand-...` or positional `candidate-NNN`) |
| `/api/candidates/:id/history` | `GET`, `HEAD` | Candidate review event history (`unreviewed: true` if unreviewed) |
| `/api/baselines` | `GET`, `HEAD` | Paginated and filtered baseline registry entries |
| `/api/baselines/:id` | `GET`, `HEAD` | Detailed baseline document projection |
| `/api/runs/current` | `GET`, `HEAD` | Current run execution context summary |
| `/api/runs/reproduction` | `GET`, `HEAD` | Reproduction run context summary |

### Security Boundaries

- Binds to `127.0.0.1` by default; requires explicit configuration for custom addresses.
- URL parameters validated against strict regexes (`[A-Za-z0-9._-]+`); path traversal sequences (`..`), slashes, backslashes, control characters, and null bytes are rejected with `400 Bad Request`.
- Redaction utilities ensure no absolute file paths, passwords, bearer tokens, or sensitive values leak into HTTP responses.
- Unknown query parameter names and invalid enum values return `400 Bad Request`.
- Structured error format: `{ "error": { "code": string, "message": string, "details"?: object } }`.

### Known Limitations

- **Local-only:** Designed for single-operator local use and headless CI environments; no multi-user sessions, authorization tokens, or rate limiting.
- **No database:** State is read directly from file-based artifacts on disk.
- **Presentation-only:** Does not accept write mutations or state transitions; state mutations remain in the CLI `review-state` command.

---

# CrashLab — Build 9.2 Checkpoint

A stable, verified snapshot of the completed Build 9.2 state: Local Browser Review UI.

- **Checkpoint tag:** `build9.2-review-ui`
- **Contract tag:** `review-ui-v1`
- **Schema version:** `"1.0"`

## Verification at checkpoint time

| Check | Result |
| --- | --- |
| Full test suite | **1,201 passed** / 44 files |
| Unit tests | **1,037 passed** (35 files) |
| Browser tests | **164 passed** (9 files) |
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0 |
| Read-only client network | zero mutation requests (`POST`, `PUT`, `PATCH`, `DELETE`); 100% `GET`/`HEAD` |
| Read-only server enforcement | 405 Method Not Allowed with `Allow: GET, HEAD` on mutation requests |
| Immutability | input reports remain 100% byte-identical before and after UI sessions |
| XSS prevention | verified via Playwright: injected script and img payloads never execute |
| Working tree | clean |

## The Build 9.2 Contract (version "1.0")

Build 9.2 provides a local, dependency-free browser interface (`npm run review-ui`) for reviewing CrashLab candidate defect findings by consuming the Build 9.1 read-only HTTP API.

### Invariants and Boundaries

1. **Read-only client guarantee:** The UI client adapter and browser runtime only issue `GET` and `HEAD` requests. Any write attempt throws immediately client-side and is rejected by the server with `405 Method Not Allowed`.
2. **File and state immutability:** The UI server and client never create, update, delete, or touch any candidate, evidence, baseline, or review-state files. Backing files remain byte-identical.
3. **No direct write operations:** The UI does not create, update, dismiss, resolve, or duplicate candidates.
4. **Copyable CLI triage workflow:** To perform human review status transitions, the UI provides an interactive snippet generator that outputs copyable `npm run review-state` commands for the operator's terminal.
5. **Strict 4-way visual separation on candidate detail:**
   - Automatic Calculated Result (classifier label, rule ID, recurrence)
   - Human Review State (triage status, reviewer, notes, timestamp)
   - Supporting Evidence & Provenance (message, selector, excerpts, URL, fingerprints)
   - Limitations & Invariants (`confirmedBug: false`, `confirmed: false`)
6. **No confirmed bug claims:** Findings remain triage leads. Invariants `confirmedBug: false` and `confirmed: false` are prominently displayed on all candidate cards and overview headers.
7. **No database, external network, or AI:** Zero runtime dependencies beyond Node.js built-ins. All assets are self-contained Semantic HTML5, Vanilla CSS, and modern ES module JavaScript.

### CLI Commands

```bash
# Start UI server with default API (http://127.0.0.1:3210) on port 3211
npm run review-ui

# Configure custom API URL, host, or port
npm run review-ui -- --api-url http://127.0.0.1:4000 --host 127.0.0.1 --port 8080

# Headless / CI mode
npm run review-ui -- --no-open
```

### Views

- `#/`: System overview, key metrics, classification breakdown, and trust invariant badges.
- `#/candidates`: Deterministically ordered table of candidate defect signals with interactive multi-filter controls.
- `#/candidates/:id`: Candidate detail with strict 4-way visual separation and CLI triage snippet generator.
- `#/candidates/:id/history`: Chronological audit trail of human triage decisions loaded from `events.jsonl`.
- `#/baselines`: Known-good baseline registry inspection.
- `#/runs`: Current execution and reproduction run telemetry and step counts.

### Known Limitations

- **Local-only:** Built for single-operator local use and headless CI inspections; no multi-user sessions, authorization tokens, or rate limiting.
- **No mutations in browser:** Human review state updates must be executed via the `review-state` CLI.

---

## Build 10 Checkpoint: Controlled End-to-End Validation

A stable, hardened, fully verified snapshot of the complete 11-stage CrashLab architecture.

- **Checkpoint tag:** `build10-validation`
- **Scope:** Complete end-to-end pipeline validation across 9 deterministic fixture scenarios (A through I) without external network, database, or AI dependencies.

### Verification at Checkpoint Time

| Check | Result |
| --- | --- |
| Full test suite | **1,219 passed** (46 files) |
| Unit test suite (`npm run test:unit`) | **1,052 passed** (36 files) |
| Browser test suite (`npm run test:browser`) | **167 passed** (10 files) |
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0 |
| Artifact chain traceability | Fully validated from candidate ID back to anomaly, journey step, reproduction, baseline, and review event |
| Input and evidence immutability | Byte-identical before and after analysis (SHA-256 verified) |
| Read-only guarantees | 100% GET/HEAD requests; 0 mutation methods |
| Trust invariants | `confirmedBug: false` & `confirmed: false` across 100% of pipeline artifacts and views |

### Architecture Contract & Invariants

1. **Unbroken 11-Stage Pipeline:**
   - Scout → Journey Plan → Execution → Anomaly Engine → Reproducer → Provenance → Baseline → Review → Review State → Read-Only API → Local Review UI.
2. **Canonical Rule ID Integrity:**
   - Strict reuse of canonical constants (`HTTP_5XX`, `HTTP_4XX`, `PAGE_ERROR`, `NETWORK_REQUEST_FAILED`, `STEP_TIMEOUT`, `UNEXPECTED_ORIGIN`, `TARGET_DISABLED_AFTER_ACTION`). Zero invented rule IDs.
3. **Deterministic Reproduction:**
   - Signals require recurrence across bounded, fresh-context attempts. Single recurrence (1 of 3) yields `inconclusive` reproduction and `unknown` classification.
4. **Historical Lineage Proof:**
   - Multi-tier ancestor traversal distinguishes `novel`, `persistent`, `resolved`, and `reintroduced` candidates without mutating baselines.
5. **No Automatic Bug Confirmation:**
   - Defect candidates remain triage leads for human review. Human transitions are performed append-only via the `review-state` CLI.
6. **Ephemeral Fixture Isolation:**
   - All tests bind strictly to `127.0.0.1` and clean up servers, browsers, pages, and temporary directories in teardown.

---

## Build 10.2 Checkpoint: Staging Pilot Configuration Validator

A deterministic, local-only preflight safety gate that verifies protected pilot configurations before any future browser execution is permitted.

- **Checkpoint tag:** `build10.2-validator`
- **Scope:** Pure preflight configuration validation for staging/QA pilots. Enforces URL safety, origin boundaries, journey safety, forbidden action coverage, test data isolation, and non-secret authorization references.
- **Safety Status:** Staging pilot remains **BLOCKED**. Zero browser execution was performed in this build.

### Verification at Checkpoint Time

| Check | Result |
| --- | --- |
| Full test suite | **1,268 passed** (47 files) |
| Unit test suite (`npm run test:unit`) | **1,101 passed** (37 files) |
| Browser test suite (`npm run test:browser`) | **167 passed** (10 files) |
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0 |
| Playwright imports in validator | **0** (strictly prohibited) |
| Network / HTTP calls in validator | **0** (`fetch`, `node:http`, `node:https` absent) |
| External database or AI dependencies | **0** |
| Report determinism | Byte-identical JSON outputs across repeated runs |
| Secret safety | Credentials never accepted in config, printed, or reported |

### Configuration Contract & Rules

| Field | Rule | Local Synthetic | Staging / QA / Demo |
| --- | --- | --- | --- |
| `TARGET_URL` | Absolute URL syntax, no credentials, no fragments | `http://127.0.0.1` or `localhost` | `https://` strictly required; production hostnames rejected |
| `TARGET_ENVIRONMENT` | Must be one of `local`, `demo`, `qa`, `staging` | `local` | `staging`, `qa`, or `demo` |
| `ALLOWED_ORIGINS` | Pure origins (`protocol://host[:port]`), non-wildcard | Includes target origin | Includes target origin |
| `ALLOWED_JOURNEYS` | Unique IDs, non-empty goals, safe actions only | 1 to 4 journeys | 2 to 4 journeys |
| `FORBIDDEN_ACTIONS` | Prohibits dangerous/destructive mutations | Optional for local | Required: must cover payment, deletion, credentials |
| `TEST_DATA_FILE` | Traversal-free path; regular file check | Optional | Checked for existence only; contents never read/printed |
| `AUTHORIZATION_REFERENCE`| Non-secret ticket/document reference | Not required | Strictly required; tokens/keys rejected |

### CLI Usage & Exit Codes

```bash
npm run pilot-preflight -- --config <path>
npm run pilot-preflight -- --config <path> --report <path>
npm run pilot-preflight -- --config <path> --json
npm run pilot-preflight -- --help
```

- **Exit Code 0:** Configuration is valid and safe (`status: ready`).
- **Exit Code 1:** Configuration parsed but blocked or invalid by safety rules (`status: blocked` or `invalid`).
- **Exit Code 2:** CLI syntax error, missing argument, or unreadable file.

### Safety Invariants

1. **Pure Execution Gate:** `validatePilotConfiguration(config)` provides an immutable gate. A future pilot runner must call this before browser creation and refuse launch unless `status === 'ready'`.
2. **Production Rejection:** Production hostnames are rejected unconditionally.
3. **No Secret Handling:** Passwords, tokens, cookies, and secret values must never be placed in configuration files or committed to Git.
4. **Zero Browser / Network Activity:** The validator contains zero Playwright or network imports.
5. **Staging Remains Blocked:** Testing an external staging application requires explicit written authorization and protected local configuration supplied by the operator.

---

## Build 10.3 Checkpoint: Enforce Preflight Gate Before Pilot Execution

A verified, hardened snapshot integrating the preflight configuration validator as a mandatory safety gate before any pilot browser execution.

- **Checkpoint tag:** `build10.3-pilot-gate`
- **Scope:** Execution gate assertion (`assertPilotReady`), execution plan factory (`createPilotExecutionPlan`), dependency-injected runner seam (`runPilot`), dry-run support (`--preflight-only`, `--check-execution-gate`), and CLI command (`npm run pilot`).
- **Central Invariant:** No browser, Playwright context, page, navigation, or external network request may be created unless preflight validation returns `status: "ready"`.
- **Safety Status:** Staging pilot remains **BLOCKED**. Zero external browser executions were performed.

### Verification at Checkpoint Time

| Check | Result |
| --- | --- |
| Full test suite | **1,294 passed** (48 files) |
| Unit test suite (`npm run test:unit`) | **1,127 passed** (38 files) |
| Browser test suite (`npm run test:browser`) | **167 passed** (10 files) |
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0 |
| Blocked configuration browser launches | **0** (strictly enforced by gate) |
| Preflight-only network requests | **0** |
| Playwright imports in preflight & gate | **0** |
| Input report immutability | Byte-identical before and after evaluation |
| Safe test mode | Payment blocking and screenshot omission preserved |

### Architecture & Call Order

```text
1. Parse CLI Options / Parameters
   ↓
2. Load Configuration (protected local storage only)
   ↓
3. Pure Preflight Validation (validatePilotConfiguration)
   ↓
4. Dry-Run Check (--preflight-only / --check-execution-gate) → If active, STOP (0 browser launches)
   ↓
5. Mandatory Safety Gate (assertPilotReady) → If not 'ready', REFUSE & STOP (0 browser launches)
   ↓
6. Execution Plan Creation (createPilotExecutionPlan)
   ↓
7. Browser Execution (Only reached when status: "ready" and approved target)
```

### CLI Commands

```bash
# Preflight-only dry run (guarantees zero browser launches)
npm run pilot -- --config <path> --preflight-only

# Execution gate clearance test via preflight validator
npm run pilot-preflight -- --config <path> --check-execution-gate

# Execute against local synthetic fixture
npm run pilot -- --config <path> --journey <path>
```

- **Exit Code 0:** Valid preflight (`status: ready`) or successful local synthetic run.
- **Exit Code 1:** Blocked or invalid safety configuration (`status: blocked` or `invalid`).
- **Exit Code 2:** CLI syntax error, missing argument, or unreadable file.

---

## Build 10.4 Checkpoint: Verify Controlled Local Pilot Pipeline

A verified, hardened snapshot verifying the complete CrashLab pipeline through the new pilot runner (`runPilot` / `npm run pilot`) using exclusively a local synthetic fixture.

- **Checkpoint tag:** `build10.4-pilot-pipeline`
- **Scope:** Complete pipeline execution orchestration (`--pipeline`), baseline candidate comparison (`--baseline`), artifact emission audit (`execution.json`, `anomalies.json`, `reproduction.json`, `candidates.json`), immutability verification, and human review triage.
- **Safety Status:** **Staging pilot remains strictly BLOCKED.** Zero external browser executions, zero outbound network calls, and zero external credentials were used.

### Verification at Checkpoint Time

| Check | Result |
| --- | --- |
| Full unit test suite (`npm run test:unit`) | **1,147 passed** (39 files) |
| Browser test suite (`npm run test:browser`) | **172 passed** (11 files) |
| Build 10.4 unit tests (`build104PilotPipeline.test.ts`) | **20 passed** |
| Build 10.4 browser tests (`build104PilotPipeline.browser.test.ts`) | **5 passed** |
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0 |
| `git diff --check` | clean (exit 0) |
| Local fixture interface | Strictly loopback (`127.0.0.1` ephemeral port) |
| External network calls | **0** |
| Blocked configuration browser launches | **0** (strictly enforced) |
| Reports & plans immutability | Byte-identical before and after evaluation |
| Safe test mode & payment guard | Preserved across all executions & reproductions |
| Candidate classification invariant | `confirmed: false`, `confirmedBug: false` strictly preserved |
| Cloud / database / AI integrations | **0** |

### Verified Flows

1. **Successful Pipeline Run:**
   - Preflight passes (`ready`) → browser launches → safe journey executes on loopback fixture → `execution.json`, `anomalies.json`, `reproduction.json`, and `candidates.json` generated in isolated directory.
2. **Controlled HTTP 500 Anomaly:**
   - Fixture endpoint `/boom` returns 500 → observed in execution → classified under `HTTP_5XX` → bounded reproducer runs 3 attempts (`reproduced: 3/3`, `confirmedBug: false`) → candidate report generated → reviewer triages via `review-state` command (`investigating` → `accepted`).
3. **Clean Baseline Flow:**
   - Healthy route run produces clean baseline with 0 anomalies → verified in isolated directory.
4. **Refusal & Safety Gate:**
   - Unapproved/staging/production-like configurations rejected at preflight with 0 browser launches, 0 network requests, and 0 evidence reports created.

---

## Build 11 Checkpoint: Hosted MVP Architecture & Productization Foundation

- **Checkpoint tag:** `build11-hosted-mvp`
- **Scope:** Provider-neutral domain contracts, tenant isolation model, repository abstractions, run lifecycle state machine, secret boundary sanitization, and minimal REST API foundation.

---

## Build 12A Checkpoint: PostgreSQL / Supabase Persistence Adapter

A fully verified, relational persistence adapter satisfying the provider-neutral repository interfaces of Build 11.

- **Checkpoint tag:** `build12a-postgres-adapter`
- **Scope:** Complete PostgreSQL repository adapter (`PostgresProductRepository`), transactional SQL migration runner (`runMigrations`), connection pool abstraction with error sanitization (`createPgPool`), parameterization verification (`MockPostgresPool`), CLI commands (`npm run db:check`, `npm run db:migrate`), and contract equivalence test suite.

### Verification at Checkpoint Time

| Check | Result |
| :--- | :--- |
| Full unit test suite (`npm run test:unit`) | **1,235 passed** (42 files) |
| Browser test suite (`npm run test:browser`) | **176 passed** (12 files) |
| Build 12A unit & regression tests (`build12aPostgresPersistence.test.ts`) | **36 passed** |
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0 |
| Real Supabase connection check (`db:check`) | Verified (`aws-0-ap-south-1.pooler.supabase.com:5432/postgres`) |
| Real Supabase schema migration (`db:migrate`) | 1 applied on first run, idempotent 0 applied on second run |
| Local demo (`npm run demo` & `--clean`) | passed cleanly, exit 0 |
| Parameterized SQL | 100% queries parameterized (`$1, $2, ...`) |
| In-memory repository equivalence | All contract tests pass identically on both adapters |
| Secret persistence attempts | 100% blocked before SQL execution |
| External database connection required for tests | **0** (tests run with mock/in-memory adapter) |
| External network calls / AI / Billing | **0** |

### Fix Summary: Real PostgreSQL Result Shape Normalization
- **Root Cause:** When running multi-statement schema migrations (e.g. `001_initial_product_schema.sql`), `node-postgres` returns an array of `QueryResult` objects (`QueryResult[]`). Direct evaluation of `res.rowCount ?? res.rows.length` failed with `TypeError: Cannot read properties of undefined (reading 'length')` because Array instances do not have `.rowCount` or `.rows` properties.
- **Resolution:** Introduced `normalizePgResult<R>(rawResult: unknown): PostgresQueryResult<R>` across `RealPgPool.query` and `RealPgPool.connect().query`. When `rawResult` is an array (multi-statement execution), rows and row counts are aggregated safely; for single statements or DDL (where `rowCount` is null), rows are normalized to `[]` and rowCount to `0`.
- **Migration Safeguards:** Enhanced `runMigrations` to compute SHA-256 with CRLF-normalization, record applied migrations transactionally, verify checksum equality on subsequent runs, refuse tampered migrations, and roll back cleanly on failure.
