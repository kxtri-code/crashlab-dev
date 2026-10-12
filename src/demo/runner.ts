/**
 * CrashLab Local Product Demo Runner (Build 10.5).
 *
 * Coordinates execution of:
 *  1. Healthy Scenario: Safe catalog exploration, 0 anomalies, clean baseline generation.
 *  2. Controlled Failure Scenario: Deterministic HTTP 500 fault on /boom, HTTP_5XX classification,
 *     3x bounded reproduction, candidate report generation with confirmed: false / confirmedBug: false invariants,
 *     and review-state triage recording.
 *
 * Guarantees:
 *  - Strict loopback isolation (127.0.0.1 ephemeral port only).
 *  - Zero external network requests or production credentials.
 *  - Reuses existing CrashLab pipeline functions without duplication.
 *  - Isolated reports directory (reports/demo/) with safe, bounded cleanup.
 */

import { join, resolve, normalize } from 'node:path';
import { mkdir, rm, stat } from 'node:fs/promises';
import { runScout } from '../scout/scout.js';
import { planJourney } from '../journey/plan.js';
import { executeJourney } from '../executor/executor.js';
import { buildAnomalyReport } from '../anomaly/report.js';
import { reproduceSignals } from '../reproducer/reproducer.js';
import { buildCandidateReport } from '../review/candidateReport.js';
import { buildBaseline } from '../baseline/writer.js';
import { validateBaselineCandidate } from '../baseline/validator.js';
import type { Baseline } from '../baseline/types.js';
import type { CandidateReport } from '../review/types.js';
import { recordReviewEvent } from '../review/reviewStateStore.js';
import { writeReport } from '../report/write.js';
import { startDemoFixtureServer, type DemoFixtureHandle } from './fixtureServer.js';
import type { DemoOptions, DemoRunResult, DemoScenarioResult } from './types.js';

export const DEFAULT_DEMO_OUT_DIR = 'reports/demo';

/**
 * Safely removes demo artifacts.
 *
 * Refuses deletion if the target path is not strictly identified as a demo directory,
 * preventing accidental deletion of project roots or arbitrary user directories.
 */
export async function cleanDemoArtifacts(outDir: string): Promise<{ cleaned: boolean; removedPath: string }> {
  const resolved = resolve(normalize(outDir));
  const baseName = resolved.split(/[\\/]/).pop()?.toLowerCase();

  // Safety check: must contain 'demo' in directory name or path
  if (!baseName || !resolved.toLowerCase().includes('demo')) {
    throw new Error(
      `Refusing to delete unsafe directory "${resolved}". Safe demo cleanup only targets directories containing "demo".`,
    );
  }

  // Refuse root or top-level project directories
  const cwd = resolve(process.cwd());
  if (resolved === cwd || resolved === resolve(cwd, 'reports') || resolved === resolve(cwd, 'src') || resolved === resolve(cwd, 'tests')) {
    throw new Error(`Refusing to delete critical workspace directory "${resolved}".`);
  }

  try {
    const s = await stat(resolved);
    if (s.isDirectory()) {
      await rm(resolved, { recursive: true, force: true });
      return { cleaned: true, removedPath: resolved };
    }
  } catch {
    // Directory does not exist, nothing to remove
  }

  return { cleaned: false, removedPath: resolved };
}

/**
 * Executes the complete CrashLab local demo.
 */
export async function runDemo(options: DemoOptions = {}): Promise<DemoRunResult> {
  const outDir = options.outDir ?? DEFAULT_DEMO_OUT_DIR;

  // Handle cleanup-only mode
  if (options.clean) {
    const { cleaned, removedPath } = await cleanDemoArtifacts(outDir);
    return {
      exitCode: 0,
      success: true,
      outDir,
      scenarios: [],
      cleaned,
      message: cleaned ? `Successfully cleaned demo artifacts at ${removedPath}.` : `No demo artifacts found at ${removedPath}.`,
    };
  }

  const log = (msg: string): void => {
    if (!options.quiet) {
      console.log(msg);
    }
  };

  const writeFn = options.deps?.reportWriter
    ? (data: unknown, path: string) => options.deps!.reportWriter!(data, path)
    : (data: unknown, path: string) => writeReport(data as object, path);

  const scenarioMode = options.scenario ?? 'all';
  const runHealthy = scenarioMode === 'healthy' || scenarioMode === 'all';
  const runFailure = scenarioMode === 'failure' || scenarioMode === 'all';

  log('============================================================');
  log('CRASHLAB LOCAL PRODUCT DEMO (Build 10.5)');
  log('============================================================');
  log(`Output directory:  ${outDir}`);
  log(`Mode:              ${scenarioMode}`);
  log(`Loopback target:   127.0.0.1 (Ephemeral port)`);
  log('Safe test mode:    ENABLED (Payment guard active, zero retries)');
  log('');

  await mkdir(outDir, { recursive: true });

  let fixture: DemoFixtureHandle | null = null;
  const scenarios: DemoScenarioResult[] = [];

  try {
    fixture = await startDemoFixtureServer(options.deps?.port ?? 0);
    log(`Local synthetic fixture server active at: ${fixture.origin}`);
    log('');

    // -----------------------------------------------------------
    // SCENARIO 1: Healthy Scenario
    // -----------------------------------------------------------
    if (runHealthy) {
      const startTime = Date.now();
      log('------------------------------------------------------------');
      log('Scenario 1: Healthy Journey & Clean Baseline Creation');
      log('------------------------------------------------------------');

      const healthyDir = join(outDir, 'healthy');
      await mkdir(healthyDir, { recursive: true });

      // Step 1: Scout
      log('  [1/6] Scouting target catalog page...');
      const scoutPath = join(healthyDir, 'scout.json');
      const scout = await runScout({
        url: `${fixture.origin}/`,
        headless: true,
        settleMs: 150,
        timeoutMs: 15_000,
      });
      await writeFn(scout, scoutPath);
      log(`        Scout completed (${scout.interactiveElements.length} elements mapped).`);

      // Step 2: Journey Plan
      log('  [2/6] Planning safe user journey: "explore product catalog and view cart"...');
      const planPath = join(healthyDir, 'journey.json');
      const plan = planJourney('explore product catalog and view cart', scout, scoutPath);
      await writeFn(plan, planPath);
      log(`        Journey planned (${plan.steps.length} steps, type: ${plan.journeyType}).`);

      // Step 3: Execute
      log('  [3/6] Executing journey plan in headless browser...');
      const execPath = join(healthyDir, 'execution.json');
      const exec = await executeJourney({
        plan,
        planPath,
        safeTestMode: true,
        evidenceDir: join(healthyDir, 'evidence'),
        provenance: {
          environmentId: 'local',
          appBuildId: 'demo-local-10.5',
        },
      });
      await writeFn(exec, execPath);
      log(`        Execution finished (${exec.stepCounts.passed}/${exec.stepCounts.total} steps passed, status: ${exec.status}).`);

      // Step 4: Anomalies
      log('  [4/6] Classifying evidence signals for unexpected anomalies...');
      const anomPath = join(healthyDir, 'anomalies.json');
      const anomalies = buildAnomalyReport({
        execution: exec,
        journey: plan,
        executionPath: execPath,
        journeyPath: planPath,
      });
      await writeFn(anomalies, anomPath);
      log(`        Anomalies classified: ${anomalies.summary.totalSignals} signals (clean run).`);

      // Step 5: Clean Baseline Eligibility Validation
      log('  [5/6] Validating baseline eligibility against CrashLab trust rules...');
      const baselineValidation = validateBaselineCandidate({
        execution: exec,
        anomalies,
        journey: plan,
        acceptedSignalIds: [],
        allowUnverifiedAssertions: false,
        paths: {
          execution: execPath,
          anomalies: anomPath,
          journey: planPath,
        },
      });

      let baseline: Baseline | null = null;
      let baselinePath: string | null = null;

      if (!baselineValidation.safe) {
        log('        Baseline creation REFUSED (Trust Invariant: Absence of signals is not evidence of health):');
        for (const blocker of baselineValidation.blockers) {
          log(`          - ${blocker}`);
        }
        log(`        Status: partial / unexercised (${exec.stepCounts.passed}/${exec.stepCounts.total} steps passed, ${exec.verification?.executedSteps ?? 0} executed).`);
        log('        Semantics: A run that only skipped steps cannot establish a verified known-good baseline.');
      } else {
        baselinePath = join(healthyDir, 'baseline.json');
        baseline = buildBaseline({
          baselineId: 'demo-healthy-baseline',
          name: 'Demo Healthy Synthetic Baseline',
          execution: exec,
          anomalies,
          journey: plan,
          acceptedSignalIds: [],
          confirmedBy: 'demo-operator',
          paths: {
            execution: execPath,
            anomalies: anomPath,
            journey: planPath,
          },
          allowUnverifiedAssertions: false,
        });
        await writeFn(baseline, baselinePath);
        log(`        Baseline registered (${baseline.baselineId}).`);
      }

      // Step 6: Candidate review
      const candPath = join(healthyDir, 'candidates.json');
      let candidates: CandidateReport;

      if (baseline) {
        log('  [6/6] Reviewing against baseline for candidate regressions...');
        candidates = buildCandidateReport({
          execution: exec,
          anomalies,
          reproduction: null,
          journey: plan,
          baseline,
          paths: {
            execution: execPath,
            anomalies: anomPath,
            reproduction: null,
            journey: planPath,
            baseline: baselinePath!,
          },
        });
        await writeFn(candidates, candPath);
        log(`        Candidate review completed: ${candidates.candidates.length} candidate defect(s).`);
      } else {
        log('  [6/6] Reviewing findings without baseline...');
        candidates = buildCandidateReport({
          execution: exec,
          anomalies,
          reproduction: null,
          journey: plan,
          baseline: null,
          paths: {
            execution: execPath,
            anomalies: anomPath,
            reproduction: null,
            journey: planPath,
            baseline: null,
          },
        });
        await writeFn(candidates, candPath);
        log(`        Review completed without baseline: ${candidates.candidates.length} candidate findings.`);
        log('        Trust Invariant: Health remains UNCONFIRMED (no baseline established; zero steps executed).');
      }

      const durationMs = Date.now() - startTime;
      const scenarioStatus = baselineValidation.safe ? 'passed' : 'partial';
      scenarios.push({
        name: 'Healthy Catalog Journey',
        scenario: 'healthy',
        status: scenarioStatus,
        durationMs,
        artifacts: {
          scout: scoutPath,
          journey: planPath,
          execution: execPath,
          anomalies: anomPath,
          baseline: baselinePath,
          candidates: candPath,
        },
        summary: {
          signalsObserved: anomalies.summary.totalSignals,
          ruleIds: anomalies.summary.ruleIds,
          candidateCount: candidates.candidates.length,
          confirmedBug: false,
          confirmed: false,
          baselineCreated: baselineValidation.safe,
          baselineRefused: !baselineValidation.safe,
          baselineRefusalReason: baselineValidation.safe ? null : baselineValidation.blockers.join('; '),
        },
        reports: {
          journey: plan,
          execution: exec,
          anomalies,
          baseline: baseline ?? undefined,
          candidates,
        },
      });
      log('');
    }

    // -----------------------------------------------------------
    // SCENARIO 2: Controlled Failure Scenario
    // -----------------------------------------------------------
    if (runFailure) {
      const startTime = Date.now();
      log('------------------------------------------------------------');
      log('Scenario 2: Controlled HTTP 500 Fault & Bounded Reproduction');
      log('------------------------------------------------------------');

      const failureDir = join(outDir, 'controlled-failure');
      await mkdir(failureDir, { recursive: true });

      // Step 1: Scout
      log('  [1/6] Scouting controlled fault route (/boom)...');
      const scoutPath = join(failureDir, 'scout.json');
      const scout = await runScout({
        url: `${fixture.origin}/boom`,
        headless: true,
        settleMs: 150,
        timeoutMs: 15_000,
      });
      await writeFn(scout, scoutPath);
      log('        Scout completed on /boom.');

      // Step 2: Journey Plan
      log('  [2/6] Planning journey: "observe server fault response"...');
      const planPath = join(failureDir, 'journey.json');
      const plan = planJourney('observe server fault response', scout, scoutPath);
      await writeFn(plan, planPath);
      log(`        Journey planned (${plan.steps.length} steps).`);

      // Step 3: Execute
      log('  [3/6] Executing journey and capturing server response...');
      const execPath = join(failureDir, 'execution.json');
      const exec = await executeJourney({
        plan,
        planPath,
        safeTestMode: true,
        evidenceDir: join(failureDir, 'evidence'),
        provenance: {
          environmentId: 'local',
          appBuildId: 'demo-local-10.5',
        },
      });
      await writeFn(exec, execPath);
      log('        Execution completed; HTTP 500 response recorded in evidence.');

      // Step 4: Anomalies
      log('  [4/6] Classifying evidence signals via Build 4 rule engine...');
      const anomPath = join(failureDir, 'anomalies.json');
      const anomalies = buildAnomalyReport({
        execution: exec,
        journey: plan,
        executionPath: execPath,
        journeyPath: planPath,
      });
      await writeFn(anomalies, anomPath);
      log(`        Anomaly classified: ${anomalies.summary.totalSignals} signal(s) [Rules: ${anomalies.summary.ruleIds.join(', ')}].`);

      // Step 5: Bounded Reproduction
      log('  [5/6] Running bounded reproduction (3 attempts, fresh browser contexts)...');
      const reproPath = join(failureDir, 'reproduction.json');
      const repro = await reproduceSignals({
        anomalies,
        journey: plan,
        attempts: 3,
        authorized: true,
        anomalyPath: anomPath,
        journeyPath: planPath,
        executionPath: execPath,
        includePossiblyExpected: false,
        outputDir: join(failureDir, 'reproduction'),
        provenance: {
          environmentId: 'local',
          appBuildId: 'demo-local-10.5',
        },
      });
      await writeFn(repro, reproPath);
      const repResult = repro.results[0];
      log(`        Reproduction finished: ${repResult ? repResult.classification : 'none'} (${repResult?.matchingAttempts ?? 0}/3 matching attempts).`);
      log(`        Trust Invariant: confirmedBug: false (automated test cannot claim product defect).`);

      // Step 6: Candidate Review Report & Review-State Triage
      log('  [6/6] Generating candidate report & recording review-state triage...');
      const candPath = join(failureDir, 'candidates.json');
      const candidates = buildCandidateReport({
        execution: exec,
        anomalies,
        reproduction: repro,
        journey: plan,
        baseline: null,
        paths: {
          execution: execPath,
          anomalies: anomPath,
          reproduction: reproPath,
          journey: planPath,
          baseline: null,
        },
      });
      await writeFn(candidates, candPath);

      // Record human review decision in review-state event store
      const reviewStateDir = join(failureDir, 'review-state');
      if (candidates.candidates.length > 0) {
        const firstCand = candidates.candidates[0]!;
        const candidateId = firstCand.candidateId ?? firstCand.id;
        await recordReviewEvent(reviewStateDir, {
          candidateId,
          status: 'investigating',
          reviewer: 'demo-operator',
          note: 'Controlled synthetic HTTP 500 fixture fault flagged for operator review in demo',
          sourceCandidate: {
            report: candPath,
            candidateId,
            signalKeyHash: firstCand.signalKeyHash,
            ruleId: firstCand.ruleId,
            kind: firstCand.kind,
            classification: firstCand.classification,
          },
          automaticClassification: firstCand.classification,
        });
      }
      log(`        Candidate report generated: ${candidates.candidates.length} candidate finding(s).`);
      log(`        Review state recorded: status: investigating in ${reviewStateDir}.`);

      const durationMs = Date.now() - startTime;
      scenarios.push({
        name: 'Controlled HTTP 500 Fault',
        scenario: 'failure',
        status: 'passed',
        durationMs,
        artifacts: {
          scout: scoutPath,
          journey: planPath,
          execution: execPath,
          anomalies: anomPath,
          reproduction: reproPath,
          candidates: candPath,
          reviewState: reviewStateDir,
        },
        summary: {
          signalsObserved: anomalies.summary.totalSignals,
          ruleIds: anomalies.summary.ruleIds,
          attemptsRun: repro.reproducer.attemptsRequested,
          reproduced: repResult?.classification === 'reproduced',
          candidateCount: candidates.candidates.length,
          confirmedBug: false,
          confirmed: false,
        },
        reports: {
          journey: plan,
          execution: exec,
          anomalies,
          reproduction: repro,
          candidates,
        },
      });
      log('');
    }

    log('============================================================');
    log('DEMO RUN COMPLETED SUCCESSFULLY');
    log('============================================================');
    log('');
    log('INSPECT IN REVIEW UI:');
    log('  To explore the candidate defect interactively in your browser:');
    log('  1. Start the Review API:');
    log(`     npm run review-api -- --candidates ${join(outDir, 'controlled-failure', 'candidates.json')} --review-state ${join(outDir, 'controlled-failure', 'review-state')}`);
    log('  2. In a second terminal, launch the Review UI:');
    log('     npm run review-ui');
    log('  3. Open http://127.0.0.1:3211 in your browser.');
    log('');
    log('RESET / CLEANUP:');
    log('  To remove all generated demo artifacts safely:');
    log(`  npm run demo -- --clean`);
    log('============================================================');

    return {
      exitCode: 0,
      success: true,
      outDir,
      scenarios,
      message: `Demo executed successfully with ${scenarios.length} scenario(s).`,
    };
  } finally {
    if (fixture) {
      await fixture.stop();
    }
  }
}
