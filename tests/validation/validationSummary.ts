/**
 * Deterministic validation summary report generator for Build 10.
 *
 * Guarantees:
 *  - Marks every outcome as synthetic fixture evidence
 *  - Non-negotiable invariant: `confirmedBug: false`
 *  - Never claims a synthetic fixture failure is a confirmed bug
 *  - Deterministic structure
 */

import { TOOL_VERSION } from '../../src/version.js';

export interface ValidationScenarioOutcome {
  scenarioId: string;
  name: string;
  category: string;
  status: 'passed' | 'failed';
  ruleId?: string;
  classification?: string;
  reproductionStatus?: string;
  notes: string;
  confirmedBug: false;
}

export interface ValidationSummaryDocument {
  schemaVersion: '1.0';
  toolVersion: string;
  generatedAt: string;
  disclaimer: string;
  summary: {
    totalScenarios: number;
    passedScenarios: number;
    failedScenarios: number;
    confirmedBug: false;
  };
  scenarios: ValidationScenarioOutcome[];
  limitations: string[];
}

/**
 * Builds a deterministic validation summary document.
 */
export function buildValidationSummary(
  scenarios: ValidationScenarioOutcome[],
  options?: { generatedAt?: string; limitations?: string[] },
): ValidationSummaryDocument {
  const passed = scenarios.filter((s) => s.status === 'passed').length;
  const failed = scenarios.filter((s) => s.status === 'failed').length;

  return {
    schemaVersion: '1.0',
    toolVersion: TOOL_VERSION,
    generatedAt: options?.generatedAt ?? '2026-10-11T00:00:00.000Z',
    disclaimer:
      'All scenarios are synthetic local fixture executions. CrashLab never claims a fixture anomaly is a confirmed software defect.',
    summary: {
      totalScenarios: scenarios.length,
      passedScenarios: passed,
      failedScenarios: failed,
      confirmedBug: false,
    },
    scenarios: scenarios.map((s) => ({
      ...s,
      confirmedBug: false,
    })),
    limitations: options?.limitations ?? [
      'Validation executed exclusively against local controlled fixtures on 127.0.0.1.',
      'No production targets, external APIs, or real customer data were used.',
      'Observations and anomaly signals are leads for human review, never confirmed defects.',
      'Review state was updated solely through the CLI review-state command.',
      'UI and HTTP API operated in strict read-only mode with zero mutation endpoints.',
    ],
  };
}
