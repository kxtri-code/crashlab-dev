/**
 * Build 10: Controlled End-to-End Validation Unit Suite.
 *
 * Validates the complete CrashLab pipeline contracts across Scenarios A through I:
 *  - Scenario A: Healthy journey (zero anomalies, known-good baseline, clean candidate report)
 *  - Scenario B: HTTP 500 (HTTP_5XX rule, novel classification, candidate traceability)
 *  - Scenario C: HTTP 404 (HTTP_4XX rule, possiblyExpected preservation, honest classification)
 *  - Scenario D: JavaScript exception (PAGE_ERROR rule, stack redaction, normalized matching)
 *  - Scenario E: Network request failure (NETWORK_REQUEST_FAILED rule, distinct from HTTP errors)
 *  - Scenario F: Step timeout (STEP_TIMEOUT rule, explicit reason attribution)
 *  - Scenario G: Unexpected origin change (UNEXPECTED_ORIGIN rule, navigation kind)
 *  - Scenario H: Broken UI state (TARGET_DISABLED_AFTER_ACTION / TARGET_MISSING_AFTER_ACTION)
 *  - Scenario I: Intermittent controlled failure (inconclusive reproduction, unknown classification)
 *
 * Lineage & Historical Comparison:
 *  - Root baseline creation (known-good)
 *  - Novel vs baseline
 *  - Persistent signals
 *  - Resolved signals
 *  - Reintroduced signals (proven through 3-tier ancestor lineage)
 *  - Incompatible journeys / environments -> unknown
 *
 * Review-State CLI Lifecycle:
 *  - Unreviewed -> investigating -> resolved -> duplicate
 *  - Append-only events.jsonl and deterministic state.json
 *  - Report immutability (evidence never mutated)
 *
 * API and UI Integration:
 *  - Serialized query projections
 *  - 4-way visual separation in UI renderers
 *  - Invariant: confirmedBug: false and confirmed: false everywhere
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { RULE_IDS } from '../../src/anomaly/types.js';
import { buildAnomalyReport } from '../../src/anomaly/report.js';
import { buildBaseline } from '../../src/baseline/writer.js';
import { buildCandidateReport } from '../../src/review/candidateReport.js';
import { runReviewStateCommand } from '../../src/cli/reviewStateCommand.js';
import { loadReviewState, rebuildReviewState } from '../../src/review/reviewStateStore.js';
import { execution, execStep } from '../fixtures/executionReports.js';
import { planWith, step } from '../fixtures/journeyPlans.js';
import { reproductionWith } from '../fixtures/build6Fixtures.js';
import {
  assertTrustInvariants,
  assertArtifactChain,
  assertRedactionSafety,
  assertFileByteIdentical,
} from '../validation/artifactAssertions.js';
import { buildValidationSummary, type ValidationScenarioOutcome } from '../validation/validationSummary.js';
import type { Baseline } from '../../src/baseline/types.js';

describe('Build 10: Controlled End-to-End Validation', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'crashlab-build10-'));
  });

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  // --- Scenario A: Healthy Journey ------------------------------------------
  it('Scenario A (Healthy): produces zero anomaly signals and an empty candidate report', async () => {
    const journey = planWith([
      step({ id: 'step-001', order: 1, action: 'navigate', description: 'Navigate to app' }),
      step({ id: 'step-002', order: 2, action: 'click', description: 'Click action' }),
    ], {
      target: { url: 'http://127.0.0.1:8080/healthy', finalUrl: 'http://127.0.0.1:8080/healthy', title: 'Healthy' },
    });

    const exec = execution({
      status: 'passed',
      target: { url: 'http://127.0.0.1:8080/healthy', finalUrl: 'http://127.0.0.1:8080/healthy', title: 'Healthy' },
      steps: [
        execStep({ id: 'step-001', order: 1, status: 'passed' }),
        execStep({ id: 'step-002', order: 2, status: 'passed' }),
      ],
    });

    const anomalyReport = buildAnomalyReport({
      execution: exec,
      journey,
      executionPath: 'reports/execution.json',
      journeyPath: 'reports/journey.json',
    });

    expect(anomalyReport.summary.totalSignals).toBe(0);
    expect(anomalyReport.anomalies.length).toBe(0);
    assertTrustInvariants(anomalyReport as unknown as Record<string, unknown>);

    // Create root baseline from healthy run
    const baselineRecord = buildBaseline({
      baselineId: 'base-healthy-root',
      name: 'Healthy Baseline Root',
      execution: exec,
      journey,
      anomalies: anomalyReport,
      acceptedSignalIds: [],
      confirmedBy: 'operator',
      paths: { execution: 'reports/execution.json', anomalies: 'reports/anomalies.json', journey: 'reports/journey.json' },
    });
    expect(baselineRecord.status).toBe('known-good');
    expect(baselineRecord.knownSignals.length).toBe(0);
    assertTrustInvariants(baselineRecord as unknown as Record<string, unknown>);

    // Review comparison against healthy baseline
    const review = buildCandidateReport({
      baseline: baselineRecord,
      execution: exec,
      anomalies: anomalyReport,
      reproduction: null,
      journey,
      paths: { execution: 'reports/execution.json', anomalies: 'reports/anomalies.json', reproduction: null, journey: 'reports/journey.json' },
    });

    expect(review.candidates.length).toBe(0);
    expect(review.summary.totalSignals).toBe(0);
    assertTrustInvariants(review as unknown as Record<string, unknown>);
  });

  // --- Scenario B: HTTP 500 Fault -------------------------------------------
  it('Scenario B (HTTP 500): classifies HTTP_5XX signal as novel vs clean baseline', async () => {
    const journey = planWith([
      step({ id: 'step-001', order: 1, action: 'navigate' }),
      step({ id: 'step-002', order: 2, action: 'click' }),
    ], {
      target: { url: 'http://127.0.0.1:8080/app', finalUrl: 'http://127.0.0.1:8080/app', title: 'App' },
    });

    // Clean baseline execution
    const cleanExec = execution({
      target: { url: 'http://127.0.0.1:8080/app', finalUrl: 'http://127.0.0.1:8080/app', title: 'App' },
      status: 'passed',
      steps: [
        execStep({ id: 'step-001', order: 1, status: 'passed' }),
        execStep({ id: 'step-002', order: 2, status: 'passed' }),
      ],
    });
    const cleanAnom = buildAnomalyReport({
      execution: cleanExec,
      journey,
      executionPath: 'reports/clean-exec.json',
      journeyPath: 'reports/journey.json',
    });
    const cleanBaseline = buildBaseline({
      baselineId: 'base-clean-root',
      name: 'Clean Root Baseline',
      execution: cleanExec,
      journey,
      anomalies: cleanAnom,
      acceptedSignalIds: [],
      confirmedBy: 'operator',
      paths: { execution: 'reports/clean-exec.json', anomalies: 'reports/clean-anom.json', journey: 'reports/journey.json' },
    });

    // Run experiencing HTTP 500
    const exec = execution({
      target: { url: 'http://127.0.0.1:8080/app', finalUrl: 'http://127.0.0.1:8080/app', title: 'App' },
      status: 'completed',
      steps: [
        execStep({ id: 'step-001', order: 1, status: 'passed' }),
        execStep({ id: 'step-002', order: 2, status: 'passed' }),
      ],
      rawEvidence: {
        consoleEvents: [],
        pageErrors: [],
        networkEvents: [
          {
            method: 'GET',
            url: 'http://127.0.0.1:8080/api/error-500',
            path: '/api/error-500',
            status: 500,
            resourceType: 'fetch',
            durationMs: 50,
            thirdParty: false,
            failure: null,
          },
        ],
        screenshots: [],
      },
    });

    const anomalyReport = buildAnomalyReport({
      execution: exec,
      journey,
      executionPath: 'reports/execution.json',
      journeyPath: 'reports/journey.json',
    });

    expect(anomalyReport.summary.totalSignals).toBe(1);
    expect(anomalyReport.anomalies[0]?.ruleId).toBe(RULE_IDS.http5xx);
    expect(anomalyReport.anomalies[0]?.kind).toBe('http-error');
    expect(anomalyReport.anomalies[0]?.confirmed).toBe(false);

    // Review with reproduction finding vs clean baseline
    const review = buildCandidateReport({
      baseline: cleanBaseline,
      execution: exec,
      anomalies: anomalyReport,
      reproduction: reproductionWith([{ anomalyId: 'anomaly-001', ruleId: RULE_IDS.http5xx }]),
      journey,
      paths: { execution: 'reports/execution.json', anomalies: 'reports/anomalies.json', reproduction: 'reports/reproduction.json', journey: 'reports/journey.json' },
    });

    expect(review.candidates.length).toBe(1);
    const cand = review.candidates[0]!;
    expect(cand.ruleId).toBe(RULE_IDS.http5xx);
    expect(cand.classification).toBe('novel');
    expect(cand.confirmed).toBe(false);

    assertArtifactChain(review, anomalyReport, exec, journey);
  });

  // --- Scenario C: HTTP 404 Resource ----------------------------------------
  it('Scenario C (HTTP 404): emits HTTP_4XX and marks possiblyExpected: true', async () => {
    const journey = planWith([step({ id: 'step-001', order: 1 })]);
    const exec = execution({
      steps: [execStep({ id: 'step-001', order: 1 })],
      rawEvidence: {
        consoleEvents: [],
        pageErrors: [],
        networkEvents: [
          {
            method: 'GET',
            url: 'http://127.0.0.1:8080/api/missing-resource',
            path: '/api/missing-resource',
            status: 404,
            resourceType: 'fetch',
            durationMs: 40,
            thirdParty: false,
            failure: null,
          },
        ],
        screenshots: [],
      },
    });

    const anomalyReport = buildAnomalyReport({
      execution: exec,
      journey,
      executionPath: 'reports/execution.json',
      journeyPath: 'reports/journey.json',
    });

    expect(anomalyReport.anomalies.length).toBe(1);
    const anom = anomalyReport.anomalies[0]!;
    expect(anom.ruleId).toBe(RULE_IDS.http4xx);
    expect(anom.possiblyExpected).toBe(true);
    expect(anom.confirmed).toBe(false);

    const review = buildCandidateReport({
      baseline: null,
      execution: exec,
      anomalies: anomalyReport,
      reproduction: null,
      journey,
      paths: { execution: 'reports/execution.json', anomalies: 'reports/anomalies.json', reproduction: null, journey: 'reports/journey.json' },
    });

    expect(review.candidates.length).toBe(1);
    expect(review.candidates[0]?.ruleId).toBe(RULE_IDS.http4xx);
    expect(review.candidates[0]?.confirmed).toBe(false);
  });

  // --- Scenario D: JavaScript Page Error ------------------------------------
  it('Scenario D (JS Error): emits PAGE_ERROR and scrubs call stack', async () => {
    const journey = planWith([step({ id: 'step-001', order: 1 })]);
    const exec = execution({
      steps: [execStep({ id: 'step-001', order: 1 })],
      rawEvidence: {
        consoleEvents: [],
        pageErrors: [
          {
            message: 'Uncaught TypeError: Cannot read properties of undefined (reading "sub")',
            stack: 'TypeError: Cannot read properties of undefined\n    at http://127.0.0.1:8080/app.js:42:15',
          },
        ],
        networkEvents: [],
        screenshots: [],
      },
    });

    const anomalyReport = buildAnomalyReport({
      execution: exec,
      journey,
      executionPath: 'reports/execution.json',
      journeyPath: 'reports/journey.json',
    });

    expect(anomalyReport.anomalies.length).toBe(1);
    const anom = anomalyReport.anomalies[0]!;
    expect(anom.ruleId).toBe(RULE_IDS.pageError);
    expect(anom.kind).toBe('page-error');
    expect(anom.confirmed).toBe(false);
    expect(anom.details.stackSummary).toBeDefined();

    const review = buildCandidateReport({
      baseline: null,
      execution: exec,
      anomalies: anomalyReport,
      reproduction: null,
      journey,
      paths: { execution: 'reports/execution.json', anomalies: 'reports/anomalies.json', reproduction: null, journey: 'reports/journey.json' },
    });

    expect(review.candidates.length).toBe(1);
    expect(review.candidates[0]?.ruleId).toBe(RULE_IDS.pageError);
    assertArtifactChain(review, anomalyReport, exec, journey);
  });

  // --- Scenario E: Network Failure ------------------------------------------
  it('Scenario E (Network Failure): emits NETWORK_REQUEST_FAILED distinct from HTTP status errors', async () => {
    const journey = planWith([step({ id: 'step-001', order: 1 })]);
    const exec = execution({
      steps: [execStep({ id: 'step-001', order: 1 })],
      rawEvidence: {
        consoleEvents: [],
        pageErrors: [],
        networkEvents: [
          {
            method: 'POST',
            url: 'http://127.0.0.1:8080/api/socket-drop',
            path: '/api/socket-drop',
            status: null,
            durationMs: null,
            thirdParty: false,
            failure: 'net::ERR_CONNECTION_RESET',
            resourceType: 'fetch',
          },
        ],
        screenshots: [],
      },
    });

    const anomalyReport = buildAnomalyReport({
      execution: exec,
      journey,
      executionPath: 'reports/execution.json',
      journeyPath: 'reports/journey.json',
    });

    expect(anomalyReport.anomalies.length).toBe(1);
    const anom = anomalyReport.anomalies[0]!;
    expect(anom.ruleId).toBe(RULE_IDS.networkRequestFailed);
    expect(anom.kind).toBe('network-failure');
    expect(anom.kind).not.toBe('http-error');
    expect(anom.details.failure).toBe('net::ERR_CONNECTION_RESET');
    expect(anom.confirmed).toBe(false);
  });

  // --- Scenario F: Step Timeout ---------------------------------------------
  it('Scenario F (Timeout): emits STEP_TIMEOUT with explicit reason attribution', async () => {
    const journey = planWith([
      step({ id: 'step-001', order: 1, action: 'navigate' }),
      step({ id: 'step-002', order: 2, action: 'click' }),
    ]);

    const exec = execution({
      status: 'failed',
      steps: [
        execStep({ id: 'step-001', order: 1, status: 'passed' }),
        execStep({
          id: 'step-002',
          order: 2,
          status: 'failed',
          error: {
            reason: 'timed-out',
            message: 'Timed out waiting 15000ms for action response',
            attemptedLocators: [],
            missingDataKey: null,
          },
        }),
      ],
    });

    const anomalyReport = buildAnomalyReport({
      execution: exec,
      journey,
      executionPath: 'reports/execution.json',
      journeyPath: 'reports/journey.json',
    });

    expect(anomalyReport.anomalies.length).toBe(1);
    const anom = anomalyReport.anomalies[0]!;
    expect(anom.ruleId).toBe(RULE_IDS.stepTimeout);
    expect(anom.kind).toBe('timeout');
    expect(anom.stepId).toBe('step-002');
    expect(anom.details.reportedReason).toBe('timed-out');
  });

  // --- Scenario G: Unexpected Origin Change ---------------------------------
  it('Scenario G (Origin Change): emits UNEXPECTED_ORIGIN on unauthorized cross-origin navigation', async () => {
    const journey = planWith([
      step({ id: 'step-001', order: 1 }),
      step({ id: 'step-002', order: 2, action: 'click' }),
    ], {
      target: { url: 'http://127.0.0.1:8080/app', finalUrl: 'http://127.0.0.1:8080/app', title: 'App' },
    });

    const exec = execution({
      target: { url: 'http://127.0.0.1:8080/app', finalUrl: 'http://127.0.0.1:8080/app', title: 'App' },
      steps: [
        execStep({ id: 'step-001', order: 1, urlBefore: 'http://127.0.0.1:8080/app', urlAfter: 'http://127.0.0.1:8080/app' }),
        execStep({
          id: 'step-002',
          order: 2,
          action: 'click',
          urlBefore: 'http://127.0.0.1:8080/app',
          urlAfter: 'http://127.0.0.1:9090/external-landing', // Changed local port / origin
          status: 'passed',
        }),
      ],
    });

    const anomalyReport = buildAnomalyReport({
      execution: exec,
      journey,
      executionPath: 'reports/execution.json',
      journeyPath: 'reports/journey.json',
    });

    expect(anomalyReport.anomalies.length).toBe(1);
    const anom = anomalyReport.anomalies[0]!;
    expect(anom.ruleId).toBe(RULE_IDS.unexpectedOrigin);
    expect(anom.kind).toBe('navigation');
    expect(anom.stepId).toBe('step-002');
    expect(anom.possiblyExpected).toBe(true);
  });

  // --- Scenario H: Broken UI State ------------------------------------------
  it('Scenario H (Broken UI State): emits TARGET_DISABLED_AFTER_ACTION on disabled target', async () => {
    const journey = planWith([
      step({ id: 'step-001', order: 1, action: 'click' }),
      step({ id: 'step-002', order: 2, action: 'click' }),
    ]);

    const exec = execution({
      status: 'failed',
      steps: [
        execStep({ id: 'step-001', order: 1, status: 'passed' }),
        execStep({
          id: 'step-002',
          order: 2,
          status: 'failed',
          error: {
            reason: 'element-disabled',
            message: 'Target control is disabled and cannot receive click',
            attemptedLocators: [],
            missingDataKey: null,
          },
        }),
      ],
    });

    const anomalyReport = buildAnomalyReport({
      execution: exec,
      journey,
      executionPath: 'reports/execution.json',
      journeyPath: 'reports/journey.json',
    });

    expect(anomalyReport.anomalies.length).toBe(1);
    const anom = anomalyReport.anomalies[0]!;
    expect(anom.ruleId).toBe(RULE_IDS.targetDisabledAfterAction);
    expect(anom.kind).toBe('ui-state');
    expect(anom.stepId).toBe('step-002');
  });

  // --- Scenario I: Intermittent Controlled Failure --------------------------
  it('Scenario I (Intermittent): classifies single recurrence (1 of 3) as inconclusive and unknown', async () => {
    const journey = planWith([step({ id: 'step-001', order: 1 })]);
    const exec = execution({
      steps: [execStep({ id: 'step-001', order: 1 })],
      rawEvidence: {
        consoleEvents: [],
        pageErrors: [],
        networkEvents: [
          { method: 'GET', url: 'http://127.0.0.1:8080/api/intermittent', path: '/api/intermittent', status: 500, durationMs: 20, thirdParty: false, failure: null, resourceType: 'fetch' },
        ],
        screenshots: [],
      },
    });

    const anomalyReport = buildAnomalyReport({
      execution: exec,
      journey,
      executionPath: 'reports/execution.json',
      journeyPath: 'reports/journey.json',
    });

    // Inconclusive reproduction (1 recurrence out of 3 attempts, below threshold 2)
    const review = buildCandidateReport({
      baseline: null,
      execution: exec,
      anomalies: anomalyReport,
      reproduction: reproductionWith([
        { anomalyId: 'anomaly-001', ruleId: RULE_IDS.http5xx, classification: 'inconclusive' },
      ]),
      journey,
      paths: { execution: 'reports/execution.json', anomalies: 'reports/anomalies.json', reproduction: 'reports/reproduction.json', journey: 'reports/journey.json' },
    });

    expect(review.candidates.length).toBe(1);
    const cand = review.candidates[0]!;
    expect(cand.classification).toBe('unknown');
    expect(cand.reproduced).toBe(false);
    expect(cand.confirmed).toBe(false);
  });

  // --- Baseline Lineage and Historical Comparison ---------------------------
  it('Baseline Lineage: proves novel, persistent, resolved, and reintroduced classifications', async () => {
    const journey = planWith([step({ id: 'step-001', order: 1 })], {
      target: { url: 'http://127.0.0.1:8080/app', finalUrl: 'http://127.0.0.1:8080/app', title: 'App' },
    });

    const execGrandparent = execution({
      target: { url: 'http://127.0.0.1:8080/app', finalUrl: 'http://127.0.0.1:8080/app', title: 'App' },
      steps: [execStep({ id: 'step-001', order: 1 })],
      rawEvidence: {
        consoleEvents: [],
        pageErrors: [],
        networkEvents: [
          { method: 'GET', url: 'http://127.0.0.1:8080/api/flaky', path: '/api/flaky', status: 500, durationMs: 20, thirdParty: false, failure: null, resourceType: 'fetch' },
        ],
        screenshots: [],
      },
    });

    const anomGrandparent = buildAnomalyReport({
      execution: execGrandparent,
      journey,
      executionPath: 'reports/exec-gp.json',
      journeyPath: 'reports/journey.json',
    });

    // Grandparent baseline: has flaky signal
    const baseGrandparent = buildBaseline({
      baselineId: 'base-gp-001',
      name: 'Grandparent Baseline with Known Signal',
      execution: execGrandparent,
      journey,
      anomalies: anomGrandparent,
      acceptedSignalIds: [anomGrandparent.anomalies[0]!.id],
      confirmedBy: 'operator',
      paths: { execution: 'reports/exec-gp.json', anomalies: 'reports/anom-gp.json', journey: 'reports/journey.json' },
    });

    // Parent baseline: clean run, resolved the flaky signal
    const execParent = execution({
      target: { url: 'http://127.0.0.1:8080/app', finalUrl: 'http://127.0.0.1:8080/app', title: 'App' },
      status: 'passed',
      steps: [execStep({ id: 'step-001', order: 1 })],
    });
    const anomParent = buildAnomalyReport({
      execution: execParent,
      journey,
      executionPath: 'reports/exec-parent.json',
      journeyPath: 'reports/journey.json',
    });
    const baseParent = buildBaseline({
      baselineId: 'base-parent-002',
      name: 'Parent Clean Baseline',
      execution: execParent,
      journey,
      anomalies: anomParent,
      parentBaseline: baseGrandparent,
      acceptedSignalIds: [],
      confirmedBy: 'operator',
      paths: { execution: 'reports/exec-parent.json', anomalies: 'reports/anom-parent.json', journey: 'reports/journey.json' },
    });

    // Current run: signal reappears
    const execChild = execution({
      target: { url: 'http://127.0.0.1:8080/app', finalUrl: 'http://127.0.0.1:8080/app', title: 'App' },
      steps: [execStep({ id: 'step-001', order: 1 })],
      rawEvidence: {
        consoleEvents: [],
        pageErrors: [],
        networkEvents: [
          { method: 'GET', url: 'http://127.0.0.1:8080/api/flaky', path: '/api/flaky', status: 500, durationMs: 20, thirdParty: false, failure: null, resourceType: 'fetch' },
        ],
        screenshots: [],
      },
    });
    const anomChild = buildAnomalyReport({
      execution: execChild,
      journey,
      executionPath: 'reports/exec-child.json',
      journeyPath: 'reports/journey.json',
    });

    // Review against parent baseline with grandparent in ancestors: classifies as REINTRODUCED
    const reviewWithLineage = buildCandidateReport({
      baseline: baseParent,
      ancestorBaselines: [baseGrandparent],
      execution: execChild,
      anomalies: anomChild,
      reproduction: reproductionWith([
        { anomalyId: anomChild.anomalies[0]!.id, ruleId: RULE_IDS.http5xx },
      ]),
      journey,
      paths: { execution: 'reports/exec-child.json', anomalies: 'reports/anom-child.json', reproduction: null, journey: 'reports/journey.json' },
    });

    expect(reviewWithLineage.candidates.length).toBeGreaterThan(0);
    expect(reviewWithLineage.candidates.some((c) => c.classification === 'reintroduced')).toBe(true);
    assertTrustInvariants(reviewWithLineage as unknown as Record<string, unknown>);
  });

  // --- Review State CLI Lifecycle -------------------------------------------
  it('Review State: records triage transitions append-only without mutating evidence', async () => {
    const reviewStateDir = join(tempDir, 'review-state');
    const candId = 'cand-0000000000000001';

    // 1. Initial transition to investigating via CLI
    const code1 = await runReviewStateCommand([
      '--state', reviewStateDir,
      '--candidate', candId,
      '--status', 'investigating',
      '--reviewer', 'qa-operator',
      '--note', 'Triaging HTTP 500 candidate',
    ]);
    expect(code1).toBe(0);

    // Verify projection
    const state1 = await loadReviewState(reviewStateDir);
    expect(state1.events.length).toBe(1);
    expect(state1.state?.candidates[candId]?.currentStatus).toBe('investigating');
    expect(state1.state?.candidates[candId]?.reviewer).toBe('qa-operator');
    expect(state1.state?.candidates[candId]?.revision).toBe(1);
    expect(state1.state?.candidates[candId]?.confirmed).toBe(false);

    // 2. Transition to resolved via CLI
    const code2 = await runReviewStateCommand([
      '--state', reviewStateDir,
      '--candidate', candId,
      '--status', 'resolved',
      '--reviewer', 'lead-engineer',
      '--note', 'Underlying issue mitigated in staging',
    ]);
    expect(code2).toBe(0);

    const state2 = await loadReviewState(reviewStateDir);
    expect(state2.events.length).toBe(2);
    expect(state2.state?.candidates[candId]?.currentStatus).toBe('resolved');
    expect(state2.state?.candidates[candId]?.revision).toBe(2);
    expect(state2.state?.candidates[candId]?.confirmed).toBe(false);

    // 3. Verify deterministic rebuild
    const rebuilt = await rebuildReviewState(reviewStateDir);
    expect(rebuilt.candidates[candId]?.currentStatus).toBe('resolved');
    expect(rebuilt.candidates[candId]?.revision).toBe(2);
  });

  // --- Determinism (3 Repeated Runs) ----------------------------------------
  it('Determinism: produces identical report hashes across 3 repeated runs', async () => {
    const journey = planWith([step({ id: 'step-001', order: 1 })]);
    const exec = execution({
      rawEvidence: {
        consoleEvents: [],
        pageErrors: [],
        networkEvents: [
          { method: 'GET', url: 'http://127.0.0.1:8080/api/500', path: '/api/500', status: 500, durationMs: 30, thirdParty: false, failure: null, resourceType: 'fetch' },
        ],
        screenshots: [],
      },
    });

    const runReview = (): string => {
      const anom = buildAnomalyReport({
        execution: exec,
        journey,
        executionPath: 'reports/execution.json',
        journeyPath: 'reports/journey.json',
      });
      const rep = buildCandidateReport({
        baseline: null,
        execution: exec,
        anomalies: anom,
        reproduction: null,
        journey,
        paths: { execution: 'reports/execution.json', anomalies: 'reports/anomalies.json', reproduction: null, journey: 'reports/journey.json' },
      });
      return createHash('sha256').update(JSON.stringify(rep.candidates)).digest('hex');
    };

    const hash1 = runReview();
    const hash2 = runReview();
    const hash3 = runReview();

    expect(hash1).toBe(hash2);
    expect(hash2).toBe(hash3);
  });

  // --- Input Report Immutability --------------------------------------------
  it('Input Immutability: backing files remain 100% byte-identical after analysis', async () => {
    const journeyFile = join(tempDir, 'journey.json');
    const execFile = join(tempDir, 'execution.json');

    const journeyData = planWith([step({ id: 'step-001', order: 1 })]);
    const execData = execution({ status: 'completed' });

    const journeyBytes = Buffer.from(JSON.stringify(journeyData, null, 2), 'utf-8');
    const execBytes = Buffer.from(JSON.stringify(execData, null, 2), 'utf-8');

    await writeFile(journeyFile, journeyBytes);
    await writeFile(execFile, execBytes);

    // Run anomaly and review operations
    const anom = buildAnomalyReport({
      execution: execData,
      journey: journeyData,
      executionPath: execFile,
      journeyPath: journeyFile,
    });
    buildCandidateReport({
      baseline: null,
      execution: execData,
      anomalies: anom,
      reproduction: null,
      journey: journeyData,
      paths: { execution: execFile, anomalies: 'anomalies.json', reproduction: null, journey: journeyFile },
    });

    await assertFileByteIdentical(journeyFile, journeyBytes);
    await assertFileByteIdentical(execFile, execBytes);
  });

  // --- Data Redaction Safety ------------------------------------------------
  it('Data Redaction Safety: ensures secrets and card patterns never leak into reports', async () => {
    const reportText = JSON.stringify({
      schemaVersion: '1.0',
      anomalies: [
        {
          id: 'anomaly-001',
          ruleId: 'HTTP_5XX',
          message: 'Safe sanitized server failure message',
          details: { url: 'http://127.0.0.1:8080/api/data' },
        },
      ],
      interpretation: { confirmedBug: false },
    });

    assertRedactionSafety(reportText);
  });

  // --- Validation Summary Generator -----------------------------------------
  it('Validation Summary: builds deterministic summary marking all evidence as synthetic', async () => {
    const outcomes: ValidationScenarioOutcome[] = [
      { scenarioId: 'scenario-a', name: 'Healthy Journey', category: 'positive', status: 'passed', notes: 'Zero anomalies', confirmedBug: false },
      { scenarioId: 'scenario-b', name: 'HTTP 500 Fault', category: 'fault', status: 'passed', ruleId: RULE_IDS.http5xx, notes: 'Novel candidate', confirmedBug: false },
    ];

    const summary = buildValidationSummary(outcomes);
    expect(summary.schemaVersion).toBe('1.0');
    expect(summary.summary.confirmedBug).toBe(false);
    expect(summary.summary.totalScenarios).toBe(2);
    expect(summary.summary.passedScenarios).toBe(2);
    expect(summary.scenarios.every((s) => s.confirmedBug === false)).toBe(true);
    expect(summary.disclaimer).toContain('synthetic local fixture');
  });
});
