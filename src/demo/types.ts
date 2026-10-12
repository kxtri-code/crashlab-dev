/**
 * Types and interfaces for Build 10.5: Local Product Demo Runner.
 */

import type { ExecutionReport } from '../executor/types.js';
import type { JourneyPlan } from '../journey/types.js';
import type { AnomalyReport } from '../anomaly/report.js';
import type { ReproductionReport } from '../reproducer/types.js';
import type { CandidateReport } from '../review/types.js';
import type { Baseline } from '../baseline/types.js';

export type DemoScenario = 'healthy' | 'failure' | 'all';

export interface DemoOptions {
  /** Which scenario(s) to execute. Defaults to 'all'. */
  scenario?: DemoScenario;
  /** Directory where demo artifacts are saved. Defaults to 'reports/demo'. */
  outDir?: string;
  /** Whether to suppress terminal progress logging. */
  quiet?: boolean;
  /** Clean up demo reports without running scenarios. */
  clean?: boolean;
  /** Injected dependencies for testing or custom execution. */
  deps?: DemoDependencies;
}

export interface DemoDependencies {
  /** Custom port to bind the demo server (0 for ephemeral). */
  port?: number;
  /** Optional custom write function. */
  reportWriter?: (data: unknown, filePath: string) => Promise<void>;
}

export interface DemoScenarioResult {
  name: string;
  scenario: 'healthy' | 'failure';
  status: 'passed' | 'failed';
  durationMs: number;
  artifacts: {
    scout?: string;
    journey?: string;
    execution?: string;
    anomalies?: string;
    baseline?: string;
    reproduction?: string;
    candidates?: string;
    reviewState?: string;
  };
  summary: {
    signalsObserved: number;
    ruleIds: string[];
    attemptsRun?: number;
    reproduced?: boolean;
    candidateCount?: number;
    confirmedBug: false;
    confirmed: false;
  };
  reports?: {
    journey?: JourneyPlan;
    execution?: ExecutionReport;
    anomalies?: AnomalyReport;
    baseline?: Baseline;
    reproduction?: ReproductionReport;
    candidates?: CandidateReport;
  };
}

export interface DemoRunResult {
  exitCode: number;
  success: boolean;
  outDir: string;
  scenarios: DemoScenarioResult[];
  cleaned?: boolean;
  message: string;
}
