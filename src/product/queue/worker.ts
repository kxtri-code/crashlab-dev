/**
 * Execution Worker Boundary & Deterministic Mock Worker — Build 12B.2B.
 *
 * Provides the injectable worker interface separating asynchronous run orchestration
 * from actual browser execution.
 *
 * Invariants:
 * - Deterministic unit-test worker launches ZERO browsers and makes ZERO network requests.
 * - Confirmed bugs and mutations to input journeys are forbidden.
 * - Clean cancellation and resource disposal.
 */

import type { TargetEnvironment } from '../types/target.js';
import type { ProductApprovedJourney } from '../types/journey.js';
import type { ArtifactType } from '../types/artifact.js';

export interface WorkerArtifactPayload {
  readonly type: ArtifactType;
  readonly relativePath: string;
  readonly payload: Buffer | Uint8Array | string;
  readonly contentType: string;
}

export interface ExecutionWorkerInput {
  readonly runId: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly target: TargetEnvironment;
  readonly journey: ProductApprovedJourney;
  readonly attemptNumber: number;
  readonly safeTestMode: true;
  readonly cancellationSignal?: AbortSignal;
}

export interface ExecutionWorkerResult {
  readonly status: 'completed' | 'partial' | 'failed' | 'cancelled';
  readonly passedSteps: number;
  readonly totalSteps: number;
  readonly failureReason?: string;
  readonly executionReportRef?: string;
  readonly anomalyReportRef?: string;
  readonly reproductionReportRef?: string;
  readonly candidatesReportRef?: string;
  readonly candidateRefs?: readonly string[];
  readonly artifacts?: readonly WorkerArtifactPayload[];
  readonly summary?: Record<string, unknown>;
}

export interface ExecutionWorker {
  executeRun(input: ExecutionWorkerInput): Promise<ExecutionWorkerResult>;
  cancelRun(runId: string): Promise<void>;
  close(): Promise<void>;
}

export interface DeterministicMockWorkerOptions {
  readonly mockResult?:
    | ExecutionWorkerResult
    | ((input: ExecutionWorkerInput) => Promise<ExecutionWorkerResult> | ExecutionWorkerResult);
  readonly mockError?: Error;
  readonly delayMs?: number;
  readonly onExecute?: (input: ExecutionWorkerInput) => void;
  readonly onCancel?: (runId: string) => void;
}

/**
 * Deterministic mock worker for unit tests and local queue verification.
 * Launches zero browsers, makes zero target requests, and provides deterministic artifacts.
 */
export class DeterministicMockWorker implements ExecutionWorker {
  private readonly executedRunsList: ExecutionWorkerInput[] = [];
  private readonly cancelledRunsList: string[] = [];
  private closed = false;

  constructor(private readonly options: DeterministicMockWorkerOptions = {}) {}

  get executedRuns(): readonly ExecutionWorkerInput[] {
    return [...this.executedRunsList];
  }

  get cancelledRuns(): readonly string[] {
    return [...this.cancelledRunsList];
  }

  async executeRun(input: ExecutionWorkerInput): Promise<ExecutionWorkerResult> {
    if (this.closed) {
      throw new Error('DeterministicMockWorker is closed.');
    }

    this.executedRunsList.push(input);
    if (this.options.onExecute) {
      this.options.onExecute(input);
    }

    if (input.cancellationSignal?.aborted) {
      return {
        status: 'cancelled',
        passedSteps: 0,
        totalSteps: 1,
        failureReason: 'Execution cancelled before launch.',
      };
    }

    if (this.options.delayMs && this.options.delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          resolve();
        }, this.options.delayMs);

        if (input.cancellationSignal) {
          input.cancellationSignal.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
          });
        }
      });
    }

    if (input.cancellationSignal?.aborted) {
      return {
        status: 'cancelled',
        passedSteps: 0,
        totalSteps: 1,
        failureReason: 'Execution cancelled during run.',
      };
    }

    if (this.options.mockError) {
      throw this.options.mockError;
    }

    if (this.options.mockResult) {
      if (typeof this.options.mockResult === 'function') {
        return this.options.mockResult(input);
      }
      return this.options.mockResult;
    }

    // Default deterministic successful result
    const samplePayload = JSON.stringify({
      runId: input.runId,
      status: 'completed',
      passedSteps: 3,
      totalSteps: 3,
      targetOrigin: input.target.targetOrigin,
      journeyGoal: input.journey.goal,
      timestamp: new Date().toISOString(),
      safeTestMode: true,
      confirmedBug: false,
    });

    return {
      status: 'completed',
      passedSteps: 3,
      totalSteps: 3,
      artifacts: [
        {
          type: 'execution',
          relativePath: `runs/${input.runId}/execution_report.json`,
          payload: Buffer.from(samplePayload, 'utf8'),
          contentType: 'application/json',
        },
        {
          type: 'log',
          relativePath: `runs/${input.runId}/execution.log`,
          payload: Buffer.from(
            [
              '================================================================================',
              `CRASHLAB WORKER EXECUTION LOG — RUN ${input.runId}`,
              '================================================================================',
              `Timestamp:          ${new Date().toISOString()}`,
              `Journey ID:         ${input.journey.id}`,
              `Target ID:          ${input.target.id}`,
              `Target URL:         ${input.target.targetUrl}`,
              'Mode:               Safe-Test Deterministic Execution',
              'Safe-Test Mode:     ENFORCED (Destructive actions permanently blocked)',
              '--------------------------------------------------------------------------------',
              `[STEP 1] Navigate to ${input.target.targetUrl} -> PASSED`,
              `[STEP 2] Evaluate interaction preflight assertions -> PASSED`,
              `[STEP 3] Capture execution provenance and network traces -> PASSED`,
              '--------------------------------------------------------------------------------',
              'EXECUTION SUMMARY: Completed with 3/3 steps verified. Zero anomalous signals.',
              'Trust Invariant: confirmedBug: false • confirmed: false',
              '================================================================================',
            ].join('\n') + '\n',
            'utf8',
          ),
          contentType: 'text/plain; charset=utf-8',
        },
      ],
      summary: {
        completedDeterministically: true,
      },
    };
  }

  async cancelRun(runId: string): Promise<void> {
    this.cancelledRunsList.push(runId);
    if (this.options.onCancel) {
      this.options.onCancel(runId);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
