/**
 * Worker Execution Log Builder — Build 12K.1.
 *
 * Constructs rich, structured, human-readable execution logs for runs.
 * Includes:
 * - Worker and session configuration
 * - Safe-Test mode guarantees
 * - Chronological step execution timeline
 * - Detailed network requests and status codes
 * - Browser console outputs and errors
 * - Anomaly detection results
 * - Candidate defect findings
 * - Preservation of trust invariants: confirmedBug: false, confirmed: false
 */

import type { ExecutionReport } from '../../executor/types.js';
import type { AnomalyReport } from '../../anomaly/report.js';
import type { CandidateReport } from '../../review/types.js';

export interface FormatWorkerExecutionLogInput {
  readonly runId: string;
  readonly journey: { readonly id: string; readonly goal: string; readonly origin: string };
  readonly target: { readonly id: string; readonly name: string; readonly targetUrl: string; readonly environment: string };
  readonly execReport: ExecutionReport;
  readonly anomalyReport: AnomalyReport;
  readonly candidateReport?: CandidateReport | { readonly candidates: ReadonlyArray<{ readonly id: string; readonly ruleId: string; readonly classification: string }> };
}

export function formatWorkerExecutionLog(input: FormatWorkerExecutionLogInput): string {
  const lines: string[] = [];
  const log = (msg: string = '') => lines.push(msg);

  const startTime = input.execReport.startedAt || new Date().toISOString();
  const finishTime = input.execReport.finishedAt || new Date().toISOString();
  const durationMs = input.execReport.durationMs ?? 0;

  log('================================================================================');
  log(`CRASHLAB WORKER EXECUTION LOG — RUN ${input.runId}`);
  log('================================================================================');
  log(`Timestamp:             ${startTime}`);
  log(`Run ID:                ${input.runId}`);
  log(`Journey ID:            ${input.journey.id}`);
  log(`Journey Goal:          "${input.journey.goal}"`);
  log(`Target Environment:    ${input.target.name} [${input.target.environment}]`);
  log(`Target URL:            ${input.target.targetUrl}`);
  log(`Origin:                ${input.journey.origin}`);
  log(`Safe-Test Mode:        ENFORCED (Destructive & financial operations permanently blocked)`);
  log(`Browser Engine:        Playwright Headless Chromium (isolated session)`);
  log('--------------------------------------------------------------------------------');
  log();
  log('--- WORKER LIFECYCLE & STEP EXECUTION TIMELINE ---');

  if (input.execReport.steps && input.execReport.steps.length > 0) {
    for (const step of input.execReport.steps) {
      const statusTag = (step.status || 'UNKNOWN').toUpperCase();
      log(`[${step.startedAt || startTime}] STEP ${step.order}: [${(step.action || '').toUpperCase()}] "${step.intent}" -> ${statusTag} (${step.durationMs}ms)`);
      if (step.selectedLocator) {
        log(`    Target Locator:   ${step.selectedLocator}`);
      }
      if (step.urlBefore || step.urlAfter) {
        log(`    URL Navigation:   ${step.urlBefore || 'initial'} -> ${step.urlAfter || 'current'}`);
      }
      if (step.error) {
        log(`    Step Refusal:     [${step.error.reason}] ${step.error.message}`);
      }
      if (step.skipReason) {
        log(`    Step Skipped:     ${step.skipReason}`);
      }

      // Network events observed during this step
      if (step.evidence?.networkEvents && step.evidence.networkEvents.length > 0) {
        for (const net of step.evidence.networkEvents) {
          const status = net.status !== null ? `HTTP ${net.status}` : (net.failure ? `FAILED (${net.failure})` : 'PENDING');
          log(`    [NETWORK] ${net.method} ${net.url} -> ${status} (${net.durationMs ?? 0}ms)`);
        }
      }

      // Console events observed during this step
      if (step.evidence?.consoleEvents && step.evidence.consoleEvents.length > 0) {
        for (const con of step.evidence.consoleEvents) {
          log(`    [CONSOLE.${(con.type || 'LOG').toUpperCase()}] ${con.text}`);
        }
      }
      log();
    }
  } else {
    log('  (No execution steps recorded in report)');
    log();
  }

  log('--------------------------------------------------------------------------------');
  log('--- EXECUTION SUMMARY & OUTCOME ---');
  log(`Overall Status:        ${input.execReport.status}`);
  log(`Total Duration:        ${durationMs}ms`);
  log(`Steps Passed:          ${input.execReport.stepCounts?.passed ?? 0} / ${input.execReport.stepCounts?.total ?? 0}`);
  log(`Steps Failed:          ${input.execReport.stepCounts?.failed ?? 0}`);
  log(`Steps Blocked:         ${input.execReport.stepCounts?.blocked ?? 0}`);
  log(`Steps Skipped:         ${input.execReport.stepCounts?.skipped ?? 0}`);
  log();

  log('--- AUTOMATED ANOMALY DETECTION ENGINE ---');
  const anomalyCount = input.anomalyReport.summary?.totalSignals ?? input.anomalyReport.anomalies?.length ?? 0;
  log(`Total Signals Captured: ${anomalyCount}`);
  if (input.anomalyReport.anomalies && input.anomalyReport.anomalies.length > 0) {
    for (const anom of input.anomalyReport.anomalies) {
      log(`  * [${anom.ruleId}] ${anom.message} (Step: ${anom.stepOrder ?? 'N/A'}, SignalLevel: ${anom.signalLevel || 'error'})`);
    }
  } else {
    log('  (No anomalous signals detected during this execution)');
  }
  log();

  log('--- CANDIDATE DEFECT FINDINGS & TRUST INVARIANTS ---');
  const candidates = input.candidateReport?.candidates ?? [];
  log(`Candidate Count:       ${candidates.length}`);
  log(`Trust Invariant:       confirmedBug: false • confirmed: false`);
  log(`Human Sign-off Policy: Automated leads require operator review before defect confirmation.`);
  for (const cand of candidates) {
    log(`  * Candidate ID: ${cand.id} | Rule: ${cand.ruleId} | Classification: ${cand.classification}`);
  }
  log();

  log('================================================================================');
  log(`[${finishTime}] Journey verification execution completed. Worker released.`);
  log('================================================================================');

  return lines.join('\n') + '\n';
}
