/**
 * Preflight Safety Adapter — Build 11: Hosted MVP Foundation.
 *
 * Adapts product TargetEnvironment and ProductApprovedJourney domain entities
 * into PilotConfiguration and delegates directly to the established Build 10.2
 * preflight safety validator.
 *
 * Zero duplication; zero weakening of preflight rules.
 */

import type { PilotConfiguration, ApprovedJourney, PreflightResult } from '../../preflight/types.js';
import { validatePilotConfiguration } from '../../preflight/validator.js';
import type { TargetEnvironment } from '../types/target.js';
import type { ProductApprovedJourney } from '../types/journey.js';

/**
 * Converts product-level target and journey entities into a PilotConfiguration.
 */
export function adaptToPilotConfiguration(
  target: TargetEnvironment,
  journeys: readonly ProductApprovedJourney[],
  testDataFile?: string,
): PilotConfiguration {
  const mappedJourneys: ApprovedJourney[] = journeys.map((j) => ({
    id: j.id,
    goal: j.goal,
    origin: j.origin,
    allowedActions: j.allowedActions,
    forbiddenActions: j.forbiddenActions,
    requiresCredentials: j.requiresCredentials,
    requiresTestData: j.requiresTestData,
  }));

  return {
    targetUrl: target.targetUrl,
    targetName: target.name,
    targetEnvironment: target.environment,
    appBuildId: target.appBuildId,
    allowedOrigins: target.allowedOrigins,
    allowedJourneys: mappedJourneys,
    forbiddenActions: target.forbiddenActions,
    testDataFile,
    authorizationReference: target.authorizationReference,
    resetProcedure: target.resetProcedure,
    testingWindow: target.testingWindow,
  };
}

/**
 * Validates preflight safety for a product target and its approved journeys.
 * Directly executes the proven Build 10.2 safety validator.
 */
export function validateProductTargetPreflight(
  target: TargetEnvironment,
  journeys: readonly ProductApprovedJourney[],
  testDataFile?: string,
): PreflightResult {
  const pilotConfig = adaptToPilotConfiguration(target, journeys, testDataFile);
  return validatePilotConfiguration(pilotConfig, {
    checkFilesystem: Boolean(testDataFile),
    allowSingleJourney: journeys.length === 1,
  });
}
