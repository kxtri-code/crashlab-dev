# CrashLab Staging Pilot Configuration Template

This document provides the non-secret configuration template for CrashLab's **Build 10.2 Staging Pilot Preflight Validator**.

> [!IMPORTANT]
> **Safety Invariants:**
> - Never commit real credentials, tokens, cookies, or secrets to Git.
> - Never paste passwords or authorization tokens into AI chat.
> - Provide test credentials strictly through local environment variables or an ignored local file (`test-data.local.json`).
> - Safe-test mode remains unconditionally enabled: live payment submission, destructive operations, and unapproved off-origin navigations are blocked before browser interaction.
> - Zero browser traffic occurs during preflight validation (`npm run pilot-preflight`).
> - The real staging pilot remains blocked until authorized staging configuration is explicitly supplied.

---

## 1. Key-Value Configuration Format (`.env` style)

Create a local configuration file (e.g. `pilot.env` or `pilot.staging.conf`) outside Git or gitignored:

```text
TARGET_URL=<authorized staging URL, e.g. https://staging-shop.example.test/catalog>
TARGET_NAME=<application name, e.g. Staging Demo Store>
TARGET_ENVIRONMENT=staging
APP_BUILD_ID=<optional application build identifier, e.g. 2026.10-build42>
ALLOWED_ORIGINS=<comma-separated approved origins, e.g. https://staging-shop.example.test>
ALLOWED_JOURNEYS=<2 to 4 approved safe journeys, e.g. Browse catalog and view products, Submit safe feedback form>
FORBIDDEN_ACTIONS=<comma-separated forbidden actions, e.g. payment, checkout, account_deletion, data_deletion, password_reset, credential_change>
TEST_DATA_FILE=<optional local path to protected test data file, e.g. ./test-data.local.json>
AUTHORIZATION_REFERENCE=<non-secret reference to written authorization, e.g. TICKET-SEC-2026-042 or DOC-STAGING-AUTH-V1>
RESET_PROCEDURE=<description or script reference, e.g. Automated staging database restore script>
TESTING_WINDOW=<optional approved testing window, e.g. Mon-Fri 02:00-06:00 UTC>
```

---

## 2. JSON Configuration Format (`pilot.json`)

Alternatively, configure using JSON with granular journey objects:

```json
{
  "targetUrl": "https://staging-shop.example.test/catalog",
  "targetName": "Staging Demo Store",
  "targetEnvironment": "staging",
  "appBuildId": "2026.10-build42",
  "allowedOrigins": [
    "https://staging-shop.example.test"
  ],
  "allowedJourneys": [
    {
      "id": "j-catalog-01",
      "goal": "browse product catalog and filter categories",
      "origin": "https://staging-shop.example.test",
      "allowedActions": ["navigate", "filter", "view"],
      "forbiddenActions": ["checkout", "payment"],
      "requiresCredentials": false,
      "requiresTestData": false
    },
    {
      "id": "j-feedback-02",
      "goal": "submit safe feedback form with test message",
      "origin": "https://staging-shop.example.test",
      "allowedActions": ["navigate", "fill", "submit_form"],
      "forbiddenActions": ["checkout", "payment"],
      "requiresCredentials": false,
      "requiresTestData": false
    }
  ],
  "forbiddenActions": [
    "payment",
    "checkout",
    "account_deletion",
    "data_deletion",
    "password_reset",
    "credential_change"
  ],
  "testDataFile": "./test-data.local.json",
  "authorizationReference": "TICKET-SEC-2026-042",
  "resetProcedure": "Automated staging database restore script",
  "testingWindow": "Mon-Fri 02:00-06:00 UTC"
}
```

---

## 3. Protected Local Test Credentials (Format Only)

If journeys require authentication, supply credentials via environment variables or an ignored local file. **Never commit credentials to Git.**

```bash
# Example local environment variables (never committed)
# TEST_USER=staging_test_user
# TEST_PASSWORD=local_staging_test_password
```

---

## 4. Preflight Validation Command

Before any future pilot runner is executed, validate the configuration using the Build 10.2 preflight validator:

```bash
# Run validator CLI
npm run pilot-preflight -- --config path/to/pilot.json

# Save report
npm run pilot-preflight -- --config path/to/pilot.json --report reports/preflight.json
```

### Validator Exit Codes

- `0`: Configuration is valid and safe (`ready`).
- `1`: Configuration is blocked or invalid by domain/safety rules (`blocked` / `invalid`).
- `2`: CLI syntax error, missing argument, or unreadable file.

---

## 5. Preflight Authorization Checklist

Before removing the pilot block, confirm:
- [ ] Application owner has granted explicit written authorization to test this staging URL.
- [ ] `AUTHORIZATION_REFERENCE` contains a non-secret ticket ID or document link (no tokens or keys).
- [ ] The target is a non-production staging, QA, or demo environment (production hostnames are rejected).
- [ ] Staging environment can be reset or cleaned if necessary.
- [ ] Target owner is aware CrashLab will generate automated Playwright browser traffic.
- [ ] Safe-test mode remains enabled (`confirmedBug: false` invariant enforced).
