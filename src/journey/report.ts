/**
 * Journey report persistence and terminal summary.
 *
 * Pure formatting plus a thin write wrapper, mirroring Build 1's
 * `report/build.ts` and `report/write.ts` split.
 */

import { writeReport } from '../report/write.js';
import type { JourneyPlan } from './types.js';
import { confidenceBand } from './types.js';
import { TOOL_NAME, TOOL_VERSION } from '../version.js';

/** Default journey plan output path. */
export const DEFAULT_JOURNEY_OUTPUT_PATH = 'reports/journey.json';

/** Write a journey plan as JSON. Returns the absolute path written. */
export function writeJourneyPlan(
  plan: JourneyPlan,
  outputPath: string = DEFAULT_JOURNEY_OUTPUT_PATH,
  cwd: string = process.cwd(),
): Promise<string> {
  return writeReport(plan, outputPath, cwd);
}

/** Line-aligned `Label: value` helper, matching the Scout summary style. */
function row(label: string, value: string, width = 12): string {
  return `  ${label.padEnd(width)} ${value}`;
}

/**
 * Render the terminal summary. Pure - no I/O, no ANSI codes - so it is
 * directly assertable in tests.
 */
export function summarizeJourney(plan: JourneyPlan): string {
  const lines: string[] = [];
  const required = plan.steps.filter((step) => step.targetElementIds.length > 0);
  const avgConfidence =
    plan.steps.length === 0
      ? 0
      : Math.round((plan.steps.reduce((sum, step) => sum + step.confidence, 0) / plan.steps.length) * 100) / 100;

  lines.push(`${TOOL_NAME.toUpperCase()} - JOURNEY PLANNER v${TOOL_VERSION}`);
  lines.push('');
  lines.push(row('Goal:', plan.goal || '(empty)'));
  lines.push(row('Journey type:', plan.journeyType));
  lines.push(row('Target:', plan.target.url));
  if (plan.target.finalUrl && plan.target.finalUrl !== plan.target.url) {
    lines.push(row('Final URL:', plan.target.finalUrl));
  }
  lines.push(row('Page title:', plan.target.title || '(untitled)'));
  lines.push('');

  lines.push('PLAN');
  lines.push(`  Steps:            ${plan.steps.length}`);
  lines.push(`  With targets:     ${required.length}`);
  lines.push(`  Avg confidence:   ${avgConfidence.toFixed(2)} (${confidenceBand(avgConfidence)})`);
  lines.push(`  Executable:       0 of ${plan.steps.length} (planning only)`);
  lines.push('');

  lines.push('STEPS');
  for (const step of plan.steps) {
    const targets = step.targetElementIds.length > 0 ? step.targetElementIds.join(', ') : '(none found)';
    lines.push(`  ${step.id}  ${step.intent}`);
    lines.push(`        action=${step.action} confidence=${step.confidence.toFixed(2)} targets=${targets}`);
  }
  lines.push('');

  if (plan.warnings.length > 0) {
    lines.push(`WARNINGS (${plan.warnings.length})`);
    for (const warning of plan.warnings) lines.push(`  - ${warning}`);
    lines.push('');
  }

  if (plan.missingInformation.length > 0) {
    lines.push(`MISSING INFORMATION (${plan.missingInformation.length})`);
    for (const entry of plan.missingInformation) lines.push(`  - ${entry}`);
    lines.push('');
  }

  if (plan.assumptions.length > 0) {
    lines.push(`ASSUMPTIONS (${plan.assumptions.length})`);
    for (const assumption of plan.assumptions) lines.push(`  - ${assumption}`);
    lines.push('');
  }

  lines.push('Plan complete. No step was executed - execution belongs to Build 3.');

  return lines.join('\n');
}
