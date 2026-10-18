# Build 10.1 — Local Pilot Rehearsal

**Evaluation Date:** October 11, 2026  
**Operator Role:** Independent Validation & Pilot Analyst  
**Platform Version:** CrashLab v0.1.0 (Commit `62f6546`)  
**Target Environment:** Local synthetic fixture server (`http://127.0.0.1:4040`)  
**Application Build ID:** `local-rehearsal-v1`  
**Evaluation Scope:** Synthetic local rehearsal to validate pipeline mechanics before any real-world external testing  

---

## 1. Executive Summary

This evaluation represents a **synthetic local rehearsal** of CrashLab across its 11-stage pipeline:
**Scout → Journey Planning → Browser Execution → Anomaly Classification → Controlled Reproduction → Environment Provenance → Baseline Comparison → Candidate Review → Persistent Review State → Read-Only Review API → Local Browser Review UI**.

The target was a locally spawned fixture server at `127.0.0.1:4040` serving controlled fixture HTML pages. **No external staging or production application was tested.** All test cases and observed behaviors were entirely synthetic fixture exercises designed to rehearse pipeline mechanics safely.

**Key Findings:**
1. **Safety & Redaction:** Zero sensitive credentials entered reports, screenshots, or logs. Screenshot capture stopped immediately once test data entered the page. Safe-test mode remained unconditional (`confirmedBug: false` invariant preserved across all 11 stages).
2. **Deterministic Classification:** Absence of a baseline correctly yielded `unknown` rather than false `novel` defects. Comparing against an incompatible journey plan reported `incompatible-journey` without inflating findings.
3. **Reproducibility:** Controlled reproduction executed bounded attempts (3 attempts) with zero hidden retries, confirming stable signals (`3/3`) against the controlled fixture endpoint.
4. **Controlled Fixture Error:** The HTTP 500 scenario was **controlled fixture evidence**, not a confirmed bug or production defect.
5. **Human Review Separation:** The read-only Review API and browser Review UI enforced a strict visual and functional separation between automated findings and human review state. All triage state transitions were performed append-only via the `review-state` CLI.
6. **Readiness Assessment:** **Ready for additional controlled local rehearsals; real-world pilot still pending.**

---

## 2. Safety Gate & Preflight Verification

Before initiating browser traffic, all safety gate constraints were verified:

| # | Safety Requirement | Status | Verification Detail |
|---|---|---|---|
| 1 | Explicit target authorization | **Verified** | Operator-approved local synthetic fixture server on loopback |
| 2 | Safe environment | **Verified** | Isolated loopback (`127.0.0.1:4040`), zero external network traffic |
| 3 | Permitted routes understood | **Verified** | Restricted to `/shop`, `/contact`, `/boom`, and `/plain` |
| 4 | No real payment submission | **Verified** | Safe-test mode unconditionally blocks payment actions |
| 5 | No destructive action | **Verified** | Non-destructive synthetic fixture actions only |
| 6 | No customer records / PII | **Verified** | Synthetic test data only (`pilot@example.test`) |
| 7 | Test credentials available | **Verified** | Dedicated local test identity used |
| 8 | No credentials in chat | **Verified** | Passwords and secrets omitted from prompts and logs |
| 9 | Credentials via protected local file | **Verified** | Local scratch test-data fixture (`j2_test_data.json`) |
| 10 | Safe-test mode enabled | **Verified** | Always active, cannot be bypassed via CLI flags |
| 11 | Target reset capability | **Verified** | Local Node HTTP server stopped and reset on demand |
| 12 | Target owner notification | **Verified** | Local execution only |

---

## 3. Evaluated Rehearsal Journeys

### Journey 1: E-Commerce Catalog & Cart Flow (Healthy Baseline)
- **Goal:** `"add widget to cart"`
- **Starting URL:** `http://127.0.0.1:4040/shop`
- **Allowed Actions:** Identify product, click `#add-to-cart`, verify cart status text
- **Forbidden Actions:** Checkout, payment submission, interaction with disabled/hidden controls
- **Execution Outcome:** `COMPLETED` (2 passed, 0 failed, 4 skipped)
- **Anomalies Observed:** 0 signals
- **Reproduction:** 0 eligible signals
- **Baseline Established:** `pilot-shop-baseline-v1` (`known-good-partial`, executed-steps-only)
- **Candidate Findings:** 0 novel, 0 persistent, 0 confirmed bugs

### Journey 2: Safe Inquiry Contact Form (Data Ingestion & Postconditions)
- **Goal:** `"submit contact form"`
- **Starting URL:** `http://127.0.0.1:4040/contact`
- **Test Data:** Synthetic fixture (`name`, `email`, `message`)
- **Allowed Actions:** Locate fields, fill inputs, identify submit control
- **Forbidden Actions:** External form submission (`https://external.invalid`), payment form submission
- **Execution Outcome:** `COMPLETED` (3 passed, 0 failed, 1 skipped)
- **Data Redaction Audit:** Values never logged; screenshot capture halted as soon as test data touched DOM
- **Anomalies Observed:** 0 signals
- **Reproduction:** 0 eligible signals
- **Candidate Findings:** Clean review

### Journey 3: Controlled Server Error Handling (Failure Path & Triage)
- **Goal:** `"observe status"`
- **Starting URL:** `http://127.0.0.1:4040/boom` (controlled fixture 500 endpoint)
- **Execution Outcome:** `COMPLETED` (HTTP 500 captured in network telemetry)
- **Nature of Error:** **Controlled synthetic fixture evidence**, NOT a confirmed bug
- **Anomalies Classified:** 2 signals (`HTTP_5XX` [error], `CONSOLE_ERROR` [warning])
- **Controlled Reproduction:** 3 of 3 attempts completed; both signals reproduced (`3/3`)
- **Baseline Comparison (No Baseline):** Classified as `unknown` with note: *"No baseline was supplied, so nothing can be compared. Absence of a baseline means unknown, not novel."*
- **Baseline Comparison (Cross-Journey):** Compared against `pilot-shop-baseline-v1` → accurately classified as `incompatible-journey`
- **Candidate Findings:** 2 candidates (`candidate-001`, `candidate-002`)
- **Human Review Triage:** Candidate `cand-838697d1f0d3dc55` transitioned from unreviewed → `investigating` (rev 1) → `accepted` (rev 2) with audit note

---

## 4. Pipeline Component Quality Assessment

### 4.1 Scout Quality: **PASS**
- Discovered interactive controls, input tags, form actions, and hidden/disabled buttons accurately on local fixture pages.
- Settle times and navigation functioned reliably on loopback without hanging.

### 4.2 Planner Quality: **PASS**
- Generated step sequences referencing Scout element IDs.
- Correctly issued warnings for hidden controls (`element-004`), disabled controls (`element-005`), and payment-adjacent actions.

### 4.3 Executor Quality: **PASS**
- Safe-test mode blocked payment pathways; executed with `--confirm-authorized` safety gate.
- Successfully stopped capturing screenshots immediately after test data entered form fields.

### 4.4 Anomaly Classification Quality: **PASS**
- Fired canonical rule IDs (`HTTP_5XX`, `CONSOLE_ERROR`) without invented IDs.
- Differentiated between hard error (`HTTP_5XX`) and possible warning (`CONSOLE_ERROR` marked `may be expected`).

### 4.5 Controlled Reproduction Quality: **PASS**
- Adhered strictly to requested 3 attempts; zero hidden retries.
- Verified signal recurrence across fresh contexts (`3/3` reproduced).
- `confirmedBug: false` invariant strictly upheld.

### 4.6 Baseline & Candidate Review Quality: **PASS**
- Immutable baseline storage under `reports/baselines/`.
- Accurately reported `incompatible-journey` when comparing different journey hashes.
- Required `--allow-unverified-assertions` to record `known-good-partial` baseline.

### 4.7 Persistent Review State Quality: **PASS**
- Append-only logging to `events.jsonl` with deterministic projection in `state.json`.
- Enforced valid status transitions (`investigating` → `accepted`).

### 4.8 Read-Only Review API Quality: **PASS**
- 100% read-only GET/HEAD endpoints bound to `127.0.0.1:3210`. Zero write endpoints.
- Merged candidate report data with current human review state.

### 4.9 Local Browser Review UI Quality: **PASS**
- Verified via browser subagent across all views (`#/`, `#/candidates`, `#/candidates/:id`, `#/candidates/:id/history`).
- 4-way visual separation between Automatic Classification, Human Review State, Supporting Evidence, and Invariants.
- Zero web mutation; CLI triage snippets generated for operator execution.

### 4.10 Safety & Data Redaction: **PASS**
- Automated secret scan confirmed zero sensitive credentials in artifacts.
- Post-input screenshot omission verified.

---

## 5. Artifact Immutability Audit

SHA-256 digests of all rehearsal artifacts were verified and remain immutable:

| Artifact Path | SHA-256 Digest | Status |
|---|---|---|
| `reports/pilot/j1_scout.json` | `3F45E9AE5D12756BEB4A7B8A71EE254EFFDB5D613CD50384BC4B2E0F8D1A93F5` | Immutable |
| `reports/pilot/j1_journey.json` | `700BA9C7D4A2406BC1215B4086F607F916A16A5970B627C93ADB789D1C1EEDF2` | Immutable |
| `reports/pilot/j1_execution.json` | `7E4F81A7A7F4525113077759F327D599E16D2C81C618D62D6A871C5A7F976AB9` | Immutable |
| `reports/pilot/j1_anomalies.json` | `F40692CA3227AD344A3CE271F763D7577BFDC6D2F632DCE54DB9E80269D2AAD6` | Immutable |
| `reports/pilot/j1_reproduction.json` | `7CE64446DF3D6DF25424FDEDB5DB28C2802712D22D97A4CC22303A11B285BE8E` | Immutable |
| `reports/pilot/j1_candidates.json` | `A6F0B0B7FEC526CF321806BC3C2A4A7E5E007EB73277D6B94213F81119DCEBE6` | Immutable |
| `reports/pilot/j2_scout.json` | `BA9380502E0D4813EAE7171556DB25408C697C9283F4F82951CAEFA9581DC769` | Immutable |
| `reports/pilot/j2_journey.json` | `6FCF3B40D656E5996942CE1334D386EB8FD36724B0A98B69BA608E52769417BC` | Immutable |
| `reports/pilot/j2_execution.json` | `F6CF152950C67F90BD54ED909921148D583CE6C3C99EEFB088696CA80963D6DB` | Immutable |
| `reports/pilot/j2_anomalies.json` | `3991AF6E939DB3F14675ACE2DAFF4081F3E37AE4BEB6D4BC021D6D26727C889B` | Immutable |
| `reports/pilot/j2_reproduction.json` | `6CB32751529D71FF054F534F4B6498381D96FDB5975C28AE7470681F1EF6B6A3` | Immutable |
| `reports/pilot/j3_scout.json` | `5443624A04EFC111DA3374912AC1DAB46686186DDC69DE391B973639BEFBD3D1` | Immutable |
| `reports/pilot/j3_journey.json` | `171C3BD28AB706E99AC5C23ABFFF4A83CCA544891DC29CE3C3B44D71F2468A06` | Immutable |
| `reports/pilot/j3_execution.json` | `12DEDD07D19BF2E325421A1EB595C3B9E55493AC7245278C54327DC8490D42C3` | Immutable |
| `reports/pilot/j3_anomalies.json` | `178BFD6CA668BCC8834FC88F5666067224A7051B3748D9AE78AB2289F639D71A` | Immutable |
| `reports/pilot/j3_reproduction.json` | `2C0720B2CEF876209D7D6C17648DFBE3B6BD2F2B2D06E6B4B3C4BCD94A815A27` | Immutable |
| `reports/pilot/j3_candidates.json` | `8FEFC202C5606B1B053A68E308F03330119EB6FB35AA5EA84B9CBAE688492ED0` | Immutable |
| `reports/baselines/pilot-shop-baseline-v1.json` | `13F7C0B97BA5608127CCD0450B04ADC078CBB2B78248B435747614206CB0F301` | Immutable |

---

## 6. Rehearsal Decision Table

| Pipeline Area | Result | Evidence / Artifact | Severity | Follow-up Action |
|---|---|---|---|---|
| **Scout** | **PASS** | `reports/pilot/j1_scout.json`, `j2_scout.json` | Low | Maintain DOM extraction heuristics |
| **Planner** | **PASS** | `reports/pilot/j1_journey.json`, `j2_journey.json` | Low | Refine keyword ranking between contact and form submission |
| **Executor** | **PASS** | `reports/pilot/j1_execution.json`, `j2_execution.json` | Low | Continue strict omission of post-input screenshots |
| **Anomaly Engine** | **PASS** | `reports/pilot/j3_anomalies.json` | Low | Maintain canonical rule set and `may be expected` tags |
| **Reproducer** | **PASS** | `reports/pilot/j3_reproduction.json` | Low | Preserve bounded attempt budget (max 5) |
| **Baseline & Review** | **PASS** | `reports/baselines/pilot-shop-baseline-v1.json` | Low | Maintain strict lineage verification |
| **Review State** | **PASS** | `reports/review-state/events.jsonl` | Low | Keep append-only storage and CLI snippet generator |
| **Review API** | **PASS** | `http://127.0.0.1:3210/api/candidates` | Low | Maintain 100% read-only GET/HEAD constraints |
| **Review UI** | **PASS** | Browser subagent visual audit | Low | Continue 4-way visual separation; zero web mutation |
| **Safety & Redaction** | **PASS** | Automated secret scan across artifacts | Low | Enforce redaction invariants across future builds |

---

## 7. Analyst Recommendations & Real-World Prerequisites

Before attempting any real-world external pilot:
1. **Explicit External Authorization:** An external pilot requires signed written approval and designated staging boundaries from the target application owners.
2. **Session / Auth Profiles:** Support for non-trivial authentication flows (OAuth, session tokens, SSO) via local environment variables.
3. **Ambiguous Control Disambiguation:** Enhanced locator resolution for dynamic web frameworks.
4. **No Premature Architecture:** Do not add databases, cloud hosting, background workers, or AI providers.

---

## 8. Conclusion

**Overall Assessment:** **Ready for additional controlled local rehearsals; real-world pilot still pending.**
