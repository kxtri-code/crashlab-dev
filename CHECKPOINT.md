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
