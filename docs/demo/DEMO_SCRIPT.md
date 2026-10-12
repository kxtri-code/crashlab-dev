# CrashLab Demo Presentation Script

This script provides an interactive, narrative walkthrough for presenting CrashLab (Build 10.5) to stakeholders, engineers, or QA leads.

---

## Presentation Overview

| Section | Focus | Duration |
| --- | --- | --- |
| **1. Introduction** | Problem statement, CrashLab principles, safety architecture | ~2 min |
| **2. Running the Demo** | Live execution of `npm run demo` | ~1 min |
| **3. Healthy Flow Analysis** | Journey execution, evidence capture, clean baseline registration | ~2 min |
| **4. Controlled Fault Flow** | Synthetic HTTP 500 fault, classification, 3x bounded reproduction | ~3 min |
| **5. Interactive Review UI** | Inspecting candidate findings and recording triage decisions | ~2 min |
| **6. Q&A and Safety Boundaries** | Trust invariants, synthetic vs real evidence, staging gate | ~2 min |

---

## 1. Introduction

### Speaker Talking Points
> *"Traditional end-to-end testing tools either break fragile locators on minor UI changes, or they emit noisy alerts that leave engineers guessing what actually happened. Even worse, many autonomous QA tools hallucinate issues or jump to conclusions, declaring false bugs.*
>
> *CrashLab is built on three strict foundational principles:*
> 1. *Deterministic Journey Planning:* Intent-driven journeys that remain immutable and reproducible.
> 2. *Evidence-First Reproducibility:* When an anomaly occurs, CrashLab runs bounded, independent reproductions to establish recurrence before alerting.
> 3. *Non-Negotiable Trust Invariants:* Automated agents never claim a finding is a confirmed bug. CrashLab generates candidate leads with complete provenance for human operator triage.*
>
> *Today we'll run a completely local, self-contained demonstration of CrashLab's end-to-end pipeline."*

---

## 2. Live Execution

### Action
Open a terminal in the CrashLab repository and execute:

```bash
npm run demo
```

### Speaker Talking Points
> *"With a single command, CrashLab starts an isolated loopback fixture server on an ephemeral local port, maps the application, and executes two distinct scenarios: a clean happy path, and a controlled fault scenario.*
>
> *Notice that CrashLab connects strictly to loopback (`127.0.0.1`). There are zero outbound network calls, zero external databases, and zero credential dependencies."*

---

## 3. Scenario 1: Healthy Catalog Journey

### Action
Observe terminal output for Scenario 1:
```text
Scenario 1: Healthy Catalog Journey & Baseline Eligibility Gate
  [1/6] Scouting target catalog page...
  [2/6] Planning safe user journey: "explore product catalog and view cart"...
  [3/6] Executing journey plan in headless browser...
  [4/6] Classifying evidence signals for unexpected anomalies...
  [5/6] Evaluating baseline eligibility & known-good rules...
  [6/6] Reviewing findings against baseline state...
```

### Key Talking Points
- **Scout Mapping:** Scout analyzes the DOM and accessibility tree to identify real, clickable elements without brittle XPath or hard-coded CSS paths.
- **Journey Immutability:** The planned journey is written to `reports/demo/healthy/journey.json`. It is byte-identical across runs and never mutated during execution.
- **Safe Test Mode:** Payment controls and destructive actions are automatically blocked by the execution engine.
- **Baseline Eligibility & Trust Invariant:**
  > *"Notice what happens at step 5: CrashLab's baseline validator checks whether meaningful steps passed. Because the generated journey steps were observational/skipped (0/6 steps passed), CrashLab explicitly REFUSES baseline creation. In CrashLab, 'absence of signals is not evidence of health.' An unexercised run cannot establish a known-good baseline, and CrashLab will never pretend it is a confirmed clean baseline. The review finishes honestly without a baseline, reporting 0 defects and unconfirmed health."*

---

## 4. Scenario 2: Controlled Fault & Bounded Reproduction

### Action
Observe terminal output for Scenario 2:
```text
Scenario 2: Controlled HTTP 500 Fault & Bounded Reproduction
  [1/6] Scouting controlled fault route (/boom)...
  [2/6] Planning journey: "observe server fault response"...
  [3/6] Executing journey and capturing server response...
  [4/6] Classifying evidence signals via Build 4 rule engine...
  [5/6] Running bounded reproduction (3 attempts, fresh browser contexts)...
  [6/6] Generating candidate report & recording review-state triage...
```

### Key Talking Points
- **Controlled Fault Route (`/boom`):** The synthetic fixture intentionally serves a 500 Internal Server Error. CrashLab observes the network response without crashing or failing silently.
- **Rule Engine Classification:** The Build 4 anomaly engine evaluates raw network events and tags the error under rule `HTTP_5XX`.
- **Bounded Reproduction:** Instead of blindly retrying in a loop, CrashLab launches **exactly 3 independent browser sessions** to test whether the fault is persistent or intermittent.
- **Result:** The signal reproduced in all 3 attempts (`reproduced: 3/3`).
- **The Core Invariant:**
  > *"Notice the terminal output: `confirmedBug: false`. Even though the server returned a 500 error in all 3 reproduction runs, CrashLab does not claim this is an application bug. An automated harness cannot know if this endpoint is an intentional error response or a defect. It packages the finding as a candidate defect for human review."*

---

## 5. Interactive Review UI

### Action
Open two terminal tabs:

**Terminal 1:**
```bash
npm run review-api -- --candidates reports/demo/controlled-failure/candidates.json --review-state reports/demo/controlled-failure/review-state
```

**Terminal 2:**
```bash
npm run review-ui
```

Open your browser to `http://127.0.0.1:3211`.

### Key Talking Points
- **Read-Only Architecture:** The web dashboard connects to a read-only HTTP API. It cannot mutate files, leak secrets, or alter findings.
- **Candidate Details:** View the exact rule (`HTTP_5XX`), the trigger URL, and the 3/3 reproduction timeline.
- **Human Review Triage:** Show the initial status: `investigating`.
- **Explain CLI-First Decisions:**
  > *"Human triage decisions are recorded using the CLI (`npm run review-state`), creating an immutable, append-only event log (`events.jsonl`) that can be audited by engineering leads."*

---

## 6. Wrap-Up and Common Questions

### "Can CrashLab test our live production app right now?"
> *"No, and that is by design. CrashLab enforces strict preflight gates that block unapproved external targets and production hostnames. Real staging pilots require explicit written authorization references and protected credentials before browser execution can ever be initiated."*

### "What does running this demo prove?"
> *"It proves that the entire CrashLab harness — from DOM discovery through headless execution, signal classification, bounded reproduction, candidate reporting, and review management — works reliably end-to-end without external dependencies."*

### Clean Up Action
```bash
npm run demo -- --clean
```
Show that `reports/demo/` is removed cleanly without touching any other files.
