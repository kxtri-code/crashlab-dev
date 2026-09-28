/**
 * Journey plan fixtures for Build 3 executor tests.
 *
 * These are hand-authored Build 2 *contract* documents. Build 2 itself only
 * ever emits `identify` and `assert` (see README, "Build 2 compatibility
 * note"), so exercising `click`, `fill`, `submit` and the rest requires
 * plans written by hand. Every one of them is a valid `journey-plan-v1`
 * document: schema version 1.0, `executable: false` on every step.
 */

import type { JourneyPlan, JourneyStep } from '../../src/journey/types.js';
import { JOURNEY_SCHEMA_VERSION } from '../../src/journey/types.js';

/** A step with defaults, so a fixture states only what it is testing. */
export function step(overrides: Partial<JourneyStep> & { id: string; order: number }): JourneyStep {
  return {
    intent: overrides.id,
    action: 'observe',
    description: '',
    targetElementIds: [],
    locatorCandidates: [],
    expectedOutcome: '',
    confidence: 0.7,
    executable: false,
    source: { report: 'reports/sourney.json', elementIds: [] },
    ...overrides,
  };
}

/** A valid plan wrapping the given steps. */
export function plan(overrides: Partial<JourneyPlan> = {}): JourneyPlan {
  return {
    schemaVersion: JOURNEY_SCHEMA_VERSION,
    goal: 'fixture journey',
    normalizedGoal: 'fixture journey',
    journeyType: 'unknown',
    target: { url: 'https://fixture.test/', finalUrl: 'https://fixture.test/', title: 'Fixture' },
    steps: [],
    assumptions: [],
    warnings: [],
    missingInformation: [],
    planner: { mode: 'heuristic', version: '0.1.0' },
    ...overrides,
  };
}

/** A valid plan with the given steps, in order. */
export function planWith(steps: JourneyStep[], overrides: Partial<JourneyPlan> = {}): JourneyPlan {
  return plan({ ...overrides, steps });
}
