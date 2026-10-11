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
- **Future UI:** The web browser interface is deferred to Build 9.2.
