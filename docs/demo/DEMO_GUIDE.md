# CrashLab Product Demonstration Guide

This guide walks through running and evaluating the automated local product demonstration for **CrashLab** (Build 10.5).

The demo exercises the complete CrashLab pipeline from initial page discovery to browser execution, anomaly classification, bounded reproduction, candidate defect generation, and human review triage — running entirely against a deterministic, local loopback fixture (`127.0.0.1`).

---

## 1. Prerequisites and Installation

### System Requirements
- Node.js `>= 20.11.0`
- Operating System: Windows, macOS, or Linux
- Local network access to loopback (`127.0.0.1`)

### Installation Steps
Clone or open the CrashLab repository and install dependencies:

```bash
# Install Node.js package dependencies
npm install

# Install Chromium browser for Playwright automation
npm run setup
# or: npx playwright install chromium
```

No databases, cloud services, API keys, or external credentials are required.

---

## 2. Running the Demo

The demonstration is completely automated and can be started with a single command:

```bash
npm run demo
```

### Command-Line Options

| Option | Description | Default |
| --- | --- | --- |
| `--scenario <type>` | Run a specific scenario: `healthy`, `failure`, or `all` | `all` |
| `--out-dir <path>` | Custom destination directory for demo artifacts | `reports/demo` |
| `--clean`, `--reset` | Safely delete demo artifacts and exit | — |
| `--quiet` | Suppress step-by-step progress logging | `false` |
| `--json` | Print final summary results as structured JSON | `false` |
| `-h`, `--help` | Show command usage and options | — |

### Examples

```bash
# Run only the healthy catalog journey
npm run demo -- --scenario healthy

# Run only the controlled HTTP 500 fault scenario
npm run demo -- --scenario failure

# Output machine-readable JSON summary
npm run demo -- --json

# Safely reset and clean demo reports
npm run demo -- --clean
```

---

## 3. Demonstration Scenarios

### Scenario 1: Healthy Journey & Clean Baseline
- **Target:** `http://127.0.0.1:<port>/` (Local Synthetic Widget Catalog)
- **Goal:** `"explore product catalog and view cart"`
- **Pipeline Stages:**
  1. **Scout:** Discovers catalog elements, interactive buttons, and navigation links.
  2. **Journey Planner:** Generates an ordered, immutable 2-step journey plan.
  3. **Executor:** Launches a clean headless browser context, executes clicks, and verifies safe navigation.
  4. **Anomaly Engine:** Analyzes raw evidence and classifies 0 anomaly signals.
  5. **Baseline Registry:** Registers `reports/demo/healthy/baseline.json` as a known-good reference.
  6. **Candidate Review:** Compares the run against the baseline, confirming **0 candidate defects**.

### Scenario 2: Controlled HTTP 500 Fault & Bounded Reproduction
- **Target:** `http://127.0.0.1:<port>/boom` (Synthetic server error route)
- **Goal:** `"observe server fault response"`
- **Pipeline Stages:**
  1. **Scout:** Maps the route.
  2. **Journey Planner:** Constructs the observation journey.
  3. **Executor:** Navigates to `/boom`, capturing the deterministic HTTP 500 internal server error.
  4. **Anomaly Engine:** Classifies the error under rule `HTTP_5XX` (`1 signal observed`).
  5. **Reproducer:** Executes **3 bounded reproduction attempts** across isolated browser contexts (`reproduced: 3/3`).
  6. **Candidate Review:** Emits `candidates.json` with trust invariants: `confirmed: false`, `confirmedBug: false`.
  7. **Review-State Triage:** Records initial operator triage (`status: investigating`) in the durable event store.

---

## 4. Understanding Output Reports

Demo artifacts are written to `reports/demo/` in isolated subdirectories:

```text
reports/demo/
├── healthy/
│   ├── scout.json         # DOM element inventory and page structure
│   ├── journey.json       # Pure, deterministic user journey plan
│   ├── execution.json     # Execution log, timing, and raw evidence
│   ├── anomalies.json     # Signal classifications (0 signals)
│   ├── baseline.json      # Registered known-good baseline reference
│   └── candidates.json    # Candidate findings comparison (0 candidates)
│
└── controlled-failure/
    ├── scout.json         # Discovery report on /boom
    ├── journey.json       # Fault observation journey plan
    ├── execution.json     # Execution log with HTTP 500 status code
    ├── anomalies.json     # Anomaly classification report (HTTP_5XX rule)
    ├── reproduction.json  # 3-attempt bounded reproduction results
    ├── candidates.json    # Candidate review report
    └── review-state/
        ├── events.jsonl   # Immutable append-only review event log
        └── state.json     # Deterministic projected triage state
```

### Report Definitions

- **`scout.json`:** A structural snapshot of the web interface. Identifies interactive controls, inputs, links, and forms with stable element identifiers.
- **`journey.json`:** A reproducible sequence of intent-based steps derived from natural-language goals. Immutable across runs.
- **`execution.json`:** Ground-truth runtime evidence including step statuses, console logs, page errors, HTTP network exchanges, and execution timing.
- **`anomalies.json`:** Rule-based interpretations of execution evidence (e.g., `HTTP_5XX`, `CONSOLE_ERROR`). Signals are recorded as hypotheses.
- **`reproduction.json`:** Multi-attempt validation results. Demonstrates whether a signal recurs consistently across fresh browser sessions without automatic retry loops.
- **`candidates.json`:** Candidate findings prepared for human review. Compares executions against baseline states.
- **`state.json`:** Human operator decisions (`open`, `investigating`, `accepted`, `dismissed`, `resolved`) recorded through the review-state event store.

---

## 5. Inspecting Findings in the Review UI

To explore candidate findings interactively in a visual browser dashboard:

### Step 1: Start the Review API
In your terminal, start the local read-only Review API pointing to the demo artifacts:

```bash
npm run review-api -- --candidates reports/demo/controlled-failure/candidates.json --review-state reports/demo/controlled-failure/review-state
```

The API will listen at `http://127.0.0.1:3210`.

### Step 2: Start the Review UI
In a separate terminal window, start the Review UI:

```bash
npm run review-ui
```

The interface will be accessible at:
```text
http://127.0.0.1:3211
```

### Read-Only Dashboard Capabilities
- Inspect candidate details: rule ID, trigger route, signal classification, and attempt history.
- Review reproduction stability (e.g. 3/3 attempts reproduced).
- Inspect operator audit history and revision sequences.
- All actions in the UI are strictly read-only; operator decisions must be recorded via the CLI.

---

## 6. What the HTTP 500 Represents

The HTTP 500 route (`/boom`) is a **controlled synthetic fault** embedded in the local test server. It demonstrates how CrashLab:
1. Observes transport-level failures without crashing the execution runner.
2. Formulates an anomaly hypothesis under rule `HTTP_5XX`.
3. Tests reproducibility across 3 bounded iterations.
4. Packages evidence for human engineering review.

### Why it is NOT a Confirmed Production Bug
CrashLab enforces strict non-negotiable trust invariants:
- **`confirmedBug: false`**
- **`confirmed: false`**

An automated tool cannot know product intent. What appears to be an error might be an intended negative-test response, a maintenance banner, or a rate limit. Automated evidence produces **candidates for human review**, never definitive bug verdicts.

---

## 7. What CrashLab Can and Cannot Prove

### What CrashLab Proves:
- **Deterministic Journey Execution:** Approved journeys run reliably in clean environments.
- **Consistent Evidence Capture:** Console errors, network codes, and page errors are recorded faithfully.
- **Reproducibility:** Distinguishes between one-off transient flakes and persistently recurring signals.
- **Safety Compliance:** Safe-test mode, payment blocking, and loopback restrictions are rigorously enforced.

### What CrashLab Cannot Prove:
- **Absence of Defects:** A clean run proves that the tested journey succeeded under observed conditions; it does not prove the target is bug-free.
- **Business Logic Correctness:** Automated agents cannot determine whether complex business rules or pricing calculations meet business intent without human verification.
- **Staging Readiness:** Local synthetic testing validates toolchain mechanics, not target system stability. Real staging pilots remain blocked until explicit authorization is granted.

---

## 8. Safe Cleanup & Reset

To cleanly remove generated demo reports without impacting existing project baselines or user files:

```bash
npm run demo -- --clean
```

The cleanup handler verifies that target paths are strictly demo-scoped and refuses to delete parent or workspace directories.
