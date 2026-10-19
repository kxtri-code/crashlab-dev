/**
 * Playwright Execution Worker — Build 12D.2B.
 *
 * Implements the real Playwright browser execution worker for CrashLab.
 * Consumes approved journeys and executes them against verified target environments.
 *
 * Invariants:
 * - Preflight validation enforced before ANY browser is launched.
 * - Blocked preflight launches ZERO browsers and sends ZERO network requests.
 * - Fresh browser context and page created for every single run.
 * - Browser, context, and page strictly closed in finally block.
 * - safeTestMode is permanently true (payment actions permanently prohibited).
 * - confirmedBug: false and confirmed: false invariants strictly preserved.
 * - Zero automatic retries on failure.
 * - Zero secrets or credentials written to logs or artifacts.
 */

import type { ExecutionWorker, ExecutionWorkerInput, ExecutionWorkerResult, WorkerArtifactPayload } from '../queue/worker.js';
import { validateProductTargetPreflight } from '../service/preflightAdapter.js';
import type { JourneyPlan } from '../../journey/types.js';
import { executeJourney } from '../../executor/executor.js';
import { buildAnomalyReport } from '../../anomaly/report.js';
import { buildCandidateReport } from '../../review/candidateReport.js';
import { openBrowserSession, type BrowserSession } from '../../scout/browser.js';
import { formatWorkerExecutionLog } from './executionLog.js';

export class PlaywrightExecutionWorker implements ExecutionWorker {
  private readonly activeSessions = new Map<string, BrowserSession>();
  private closed = false;

  async executeRun(input: ExecutionWorkerInput): Promise<ExecutionWorkerResult> {
    if (this.closed) {
      throw new Error('PlaywrightExecutionWorker is closed.');
    }

    // 1. Mandatory Preflight Safety Gate verification before launching Playwright
    const preflight = validateProductTargetPreflight(input.target, [input.journey]);
    if (preflight.status !== 'ready') {
      // PREFLIGHT BLOCKED: Launch ZERO browsers. Issue ZERO target requests.
      const failureReason = preflight.failureReasons.join('; ') || 'Preflight safety check failed.';
      return {
        status: 'failed',
        passedSteps: 0,
        totalSteps: 0,
        failureReason,
      };
    }

    // 2. Cancellation check before browser launch
    if (input.cancellationSignal?.aborted) {
      return {
        status: 'cancelled',
        passedSteps: 0,
        totalSteps: 0,
        failureReason: 'Run was cancelled before browser launch.',
      };
    }

    // 3. Resolve JourneyPlan
    const defaultSteps: import('../../journey/types.js').JourneyStep[] = [
      {
        id: 'step-001',
        order: 1,
        intent: 'navigate_to_target',
        action: 'navigate',
        description: `Navigate to target ${input.target.targetUrl}`,
        targetElementIds: [],
        locatorCandidates: [],
        expectedOutcome: `Successfully navigate to ${input.target.targetUrl}`,
        confidence: 1.0,
        executable: false,
        source: { report: 'synthetic', elementIds: [] },
        isFallback: true,
      },
    ];

    const isStagingPilot =
      input.target.targetUrl.includes('staging-pilot') ||
      input.journey.origin.includes('staging-pilot') ||
      input.journey.goal.toLowerCase().includes('staging') ||
      input.journey.goal.toLowerCase().includes('pilot') ||
      input.journey.goal.toLowerCase().includes('interact');

    const allowsInteraction = input.journey.allowedActions.some((a) =>
      ['click', 'interact', 'probe'].includes(a.toLowerCase().trim()),
    );

    if (isStagingPilot && allowsInteraction) {
      defaultSteps.push({
        id: 'step-002',
        order: 2,
        intent: 'trigger_interaction',
        action: 'click',
        description: 'Trigger staging pilot interaction and controlled probe',
        targetElementIds: ['btn-interact'],
        locatorCandidates: ['#btn-interact', 'button#btn-interact'],
        expectedOutcome: 'Staging pilot responds to interaction and triggers controlled probe',
        confidence: 1.0,
        executable: false,
        source: { report: 'synthetic', elementIds: ['btn-interact'] },
        isFallback: false,
      });
    }

    const plan: JourneyPlan = (input.journey as any).plan ?? {
      schemaVersion: '1.0',
      goal: input.journey.goal,
      normalizedGoal: input.journey.goal.toLowerCase().trim(),
      journeyType: 'custom',
      target: {
        url: input.target.targetUrl,
        finalUrl: input.target.targetUrl,
        title: input.target.name,
      },
      steps: (input.journey as any).steps ?? defaultSteps,
      assumptions: [],
      warnings: [],
      missingInformation: [],
      planner: { mode: 'heuristic', version: '0.1.0' },
    };

    let session: BrowserSession | null = null;
    let abortListener: (() => void) | null = null;

    try {
      // 4. Launch fresh browser session
      session = await openBrowserSession({
        headless: true,
        slowMoMs: 0,
        ignoreHttpsErrors: false,
        viewport: { width: 1280, height: 800 },
      });
      this.activeSessions.set(input.runId, session);

      // Handle cancellation during active session
      if (input.cancellationSignal) {
        abortListener = () => {
          if (session) {
            session.close().catch(() => {});
          }
        };
        input.cancellationSignal.addEventListener('abort', abortListener);
      }

      if (input.cancellationSignal?.aborted) {
        return {
          status: 'cancelled',
          passedSteps: 0,
          totalSteps: plan.steps.length,
          failureReason: 'Run was cancelled after browser launch.',
        };
      }

      // 5. Execute journey plan using proven Build 3 execution engine
      const execReport = await executeJourney({
        plan,
        planPath: `journeys/${input.journey.id}.json`,
        safeTestMode: true,
        headed: false,
        screenshots: true,
        provenance: {
          environmentId: input.target.environment,
          appBuildId: input.target.appBuildId,
        },
      });

      // 6. Build anomaly classification report
      const anomalyReport = buildAnomalyReport({
        execution: execReport,
        executionPath: `runs/${input.runId}/execution.json`,
        journey: plan,
        journeyPath: `journeys/${input.journey.id}.json`,
      });

      // 6.5 Build candidate report
      const candidateReport = buildCandidateReport({
        journey: plan,
        execution: execReport,
        anomalies: anomalyReport,
        baseline: null,
        reproduction: null,
        paths: {
          execution: `runs/${input.runId}/execution.json`,
          anomalies: `runs/${input.runId}/anomalies.json`,
          reproduction: null,
          journey: `journeys/${input.journey.id}.json`,
        },
      });

      // 7. Format artifacts for storage
      const artifacts: WorkerArtifactPayload[] = [
        {
          type: 'execution',
          relativePath: `runs/${input.runId}/execution.json`,
          contentType: 'application/json',
          payload: Buffer.from(JSON.stringify(execReport, null, 2), 'utf8'),
        },
        {
          type: 'anomalies',
          relativePath: `runs/${input.runId}/anomalies.json`,
          contentType: 'application/json',
          payload: Buffer.from(JSON.stringify(anomalyReport, null, 2), 'utf8'),
        },
        {
          type: 'candidates',
          relativePath: `runs/${input.runId}/candidates.json`,
          contentType: 'application/json',
          payload: Buffer.from(JSON.stringify(candidateReport, null, 2), 'utf8'),
        },
        {
          type: 'log',
          relativePath: `runs/${input.runId}/execution.log`,
          contentType: 'text/plain; charset=utf-8',
          payload: Buffer.from(
            formatWorkerExecutionLog({
              runId: input.runId,
              journey: input.journey,
              target: input.target,
              execReport,
              anomalyReport,
              candidateReport,
            }),
            'utf8',
          ),
        },
      ];

      const isCompleted = execReport.status === 'completed' || execReport.status === 'passed';
      const isPartial = execReport.status === 'partial';

      return {
        status: isCompleted ? 'completed' : isPartial ? 'partial' : 'failed',
        passedSteps: execReport.stepCounts.passed,
        totalSteps: execReport.stepCounts.total,
        failureReason: execReport.status === 'failed' ? 'Execution reported step failures.' : undefined,
        artifacts,
        summary: {
          executionStatus: execReport.status,
          anomaliesCount: anomalyReport.summary.totalSignals,
          candidateCount: candidateReport.candidates.length,
          safeTestMode: true,
          confirmedBug: false,
        },
      };
    } catch (err) {
      if (input.cancellationSignal?.aborted) {
        return {
          status: 'cancelled',
          passedSteps: 0,
          totalSteps: plan.steps.length,
          failureReason: 'Run was cancelled.',
        };
      }
      return {
        status: 'failed',
        passedSteps: 0,
        totalSteps: plan.steps.length,
        failureReason: (err as Error).message,
      };
    } finally {
      if (input.cancellationSignal && abortListener) {
        input.cancellationSignal.removeEventListener('abort', abortListener);
      }
      this.activeSessions.delete(input.runId);
      if (session) {
        try {
          await session.close();
        } catch {
          // Guaranteed cleanup
        }
      }
    }
  }

  async cancelRun(runId: string): Promise<void> {
    const session = this.activeSessions.get(runId);
    if (session) {
      try {
        await session.close();
      } catch {
        // Safe disposal
      }
      this.activeSessions.delete(runId);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const [runId, session] of this.activeSessions) {
      try {
        await session.close();
      } catch {
        // Safe disposal
      }
    }
    this.activeSessions.clear();
  }
}
