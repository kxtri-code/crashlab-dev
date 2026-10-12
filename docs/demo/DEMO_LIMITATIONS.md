# CrashLab Demo Evidence & Scope Limitations

This document outlines the architectural boundaries, evidence limitations, and safety constraints of the CrashLab local product demonstration (Build 10.5).

---

## 1. Local Synthetic Evidence vs Real Target Evidence

The demonstration environment runs entirely against a local, in-process synthetic HTTP fixture (`127.0.0.1` on an ephemeral port).

| Dimension | Demo Synthetic Fixture | Real Staging / Production |
| --- | --- | --- |
| **Network Interface** | Loopback only (`127.0.0.1`) | External network / internet |
| **Authentication** | None | Real operator credentials / OAuth |
| **State Persistence** | Transient in-memory HTTP responses | Production databases & caches |
| **Financial / Dangerous Actions** | Completely omitted | Real payment gateways & data destruction |
| **Purpose** | Validate harness mechanics & pipeline integrity | Validate real customer journeys & regressions |

### Critical Distinction
- Evidence produced by `npm run demo` proves that CrashLab's internal software pipeline operates correctly under controlled local conditions.
- It does **not** evaluate real application business logic, backend scalability, security posture, or compliance.

---

## 2. Why a Reproduced Anomaly is NOT a Confirmed Defect

During Scenario 2, the demo fixture returns a deterministic HTTP 500 error on the `/boom` route. The reproduction engine validates that this error recurs in all 3 test attempts (`reproduced: 3/3`).

Despite 100% reproduction consistency, CrashLab enforces the following non-negotiable invariant:

```json
{
  "confirmed": false,
  "confirmedBug": false
}
```

### Rationale
1. **Lack of Domain Intent:** An automated testing system cannot infer whether a non-200 HTTP code is an unexpected system failure, a deliberate simulated fault, a maintenance placeholder, or an expected validation response.
2. **Avoiding False Alarms:** Labeling unconfirmed anomalies as "bugs" degrades operator trust.
3. **Role of CrashLab:** CrashLab acts as an evidence gatherer and reproducibility validator. The final verdict on whether an anomaly represents an actual product defect belongs exclusively to human engineers.

---

## 3. Proven Safety Guarantees

The demo runner enforces strict guarantees verified by automated regression tests:

1. **Loopback-Only Binding:**
   The fixture server binds exclusively to `127.0.0.1`. It never listens on `0.0.0.0` or any public network adapter.
2. **Zero Outbound Network Traffic:**
   Playwright and HTTP clients are restricted to the local fixture origin. Zero external URLs, analytics endpoints, or cloud services are contacted.
3. **Zero Secrets or Credentials:**
   No passwords, API tokens, cookies, or secrets are used or logged.
4. **Permanent Payment Guard:**
   Safe-test mode is permanently enabled (`safeTestMode: true`). Any payment or checkout-adjacent actions are blocked before execution.
5. **No Automatic Retry Storms:**
   Reproduction attempts are strictly bounded (default: 3). If a step fails, CrashLab does not engage in uncontrolled retry loops.
6. **Report Immutability:**
   Journey plans and execution inputs are hashed (`sha256`) and remain byte-identical before and after execution.

---

## 4. Why Real Staging Pilots Remain Blocked

CrashLab contains a preflight execution gate (Build 10.2 & 10.3) that prohibits running against external staging environments unless:
- The target origin is explicitly permitted.
- Staging hostnames are verified non-production.
- Written owner authorization (`AUTHORIZATION_REFERENCE`) is supplied.
- Dangerous and destructive operations are covered by mandatory forbidden action declarations.

Until these conditions are met and signed off by application owners, **the real staging pilot remains strictly blocked**. The local demo provides a safe, risk-free alternative for evaluating CrashLab's capabilities.
