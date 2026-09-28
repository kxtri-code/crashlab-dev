/**
 * Journey plan loading and validation.
 *
 * Pure and Playwright-free: every check here runs *before* a browser is
 * launched, so an invalid plan can never cause a navigation. Nothing is
 * silently corrected - a plan that violates the Build 2 contract is refused
 * with a specific reason, because quietly repairing it would mean executing
 * something the planner never proposed.
 *
 * Plan element types are imported from Build 2 rather than redeclared, so the
 * two builds cannot drift apart.
 */

import { readFile } from 'node:fs/promises';
import type { JourneyAction, JourneyPlan, JourneyStep, JourneyTarget, JourneyType } from '../journey/types.js';
import { JourneyPlanError, SUPPORTED_JOURNEY_SCHEMA_VERSIONS } from './types.js';
import { toOrigin } from '../util/url.js';

/** Actions the executor knows how to perform. */
export const SUPPORTED_ACTIONS: readonly JourneyAction[] = [
  'observe',
  'navigate',
  'identify',
  'click',
  'fill',
  'select',
  'upload',
  'submit',
  'assert',
];

/** Journey types Build 2 can emit. Reused rather than duplicated. */
const KNOWN_JOURNEY_TYPES: readonly string[] = [
  'login',
  'registration',
  'checkout',
  'purchase',
  'ticket_purchase',
  'form_submission',
  'search',
  'contact',
  'upload',
  'navigation',
  'unknown',
];

/** True for a plain object (not null, not an array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True for a string or null. */
function isNullableString(value: unknown): value is string | null {
  return value === null || value === undefined || typeof value === 'string';
}

/** True for an array whose every entry is a string. */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/**
 * Validate a parsed JSON value as an executable journey plan.
 *
 * @throws {JourneyPlanError} listing the first contract violation found.
 */
export function validateJourneyPlan(value: unknown, path: string): JourneyPlan {
  if (!isRecord(value)) {
    throw new JourneyPlanError(path, 'Journey plan root must be a JSON object.');
  }

  // --- schema version -----------------------------------------------------
  const schemaVersion = value['schemaVersion'];
  if (typeof schemaVersion !== 'string') {
    throw new JourneyPlanError(path, 'Journey plan is missing a string schemaVersion.');
  }
  if (!(SUPPORTED_JOURNEY_SCHEMA_VERSIONS as readonly string[]).includes(schemaVersion)) {
    throw new JourneyPlanError(
      path,
      `Unsupported journey plan schemaVersion "${schemaVersion}". This executor supports ${SUPPORTED_JOURNEY_SCHEMA_VERSIONS.join(', ')}.`,
    );
  }

  // --- goal and type ------------------------------------------------------
  if (typeof value['goal'] !== 'string' || value['goal'].trim() === '') {
    throw new JourneyPlanError(path, 'Journey plan is missing a non-empty goal.');
  }
  const journeyType = value['journeyType'];
  if (typeof journeyType !== 'string' || !KNOWN_JOURNEY_TYPES.includes(journeyType)) {
    throw new JourneyPlanError(
      path,
      `Journey plan has an unrecognised journeyType. Expected one of ${KNOWN_JOURNEY_TYPES.join(', ')}.`,
    );
  }

  // --- target -------------------------------------------------------------
  const rawTarget = value['target'];
  if (!isRecord(rawTarget) || typeof rawTarget['url'] !== 'string' || rawTarget['url'].trim() === '') {
    throw new JourneyPlanError(path, 'Journey plan is missing a target.url.');
  }
  const target = toOrigin(rawTarget['url']);
  if (target === null) {
    throw new JourneyPlanError(
      path,
      `Journey plan target.url is not a valid absolute URL: ${rawTarget['url']}. ` +
        'The executor will not guess a URL from free text.',
    );
  }

  // --- steps --------------------------------------------------------------
  const rawSteps = value['steps'];
  if (!Array.isArray(rawSteps)) {
    throw new JourneyPlanError(path, 'Journey plan is missing a steps array.');
  }

  const seenIds = new Set<string>();
  const steps: JourneyStep[] = rawSteps.map((rawStep, position) => {
    if (!isRecord(rawStep)) {
      throw new JourneyPlanError(path, `Journey plan step at position ${position} is not an object.`);
    }

    const id = rawStep['id'];
    if (typeof id !== 'string' || id.trim() === '') {
      throw new JourneyPlanError(path, `Journey plan step at position ${position} has no id.`);
    }
    if (seenIds.has(id)) {
      throw new JourneyPlanError(path, `Journey plan contains duplicate step id "${id}".`);
    }
    seenIds.add(id);

    const order = rawStep['order'];
    if (typeof order !== 'number' || !Number.isInteger(order) || order < 1) {
      throw new JourneyPlanError(path, `Journey plan step "${id}" has an invalid order; expected a positive integer.`);
    }

    const action = rawStep['action'];
    if (typeof action !== 'string' || !SUPPORTED_ACTIONS.includes(action as JourneyAction)) {
      throw new JourneyPlanError(
        path,
        `Journey plan step "${id}" has unsupported action "${String(action)}". ` +
          `Supported actions: ${SUPPORTED_ACTIONS.join(', ')}.`,
      );
    }

    // The Build 2 contract says every step is executable: false. A true here
    // means the plan came from somewhere that does not honour the contract, so
    // refuse the whole plan rather than trusting it.
    if (rawStep['executable'] !== false) {
      throw new JourneyPlanError(
        path,
        `Journey plan step "${id}" violates the Build 2 contract: executable must be false, got ${JSON.stringify(rawStep['executable'])}. ` +
          'Refusing to execute a plan that does not honour the planning contract.',
      );
    }

    if (!isStringArray(rawStep['targetElementIds'])) {
      throw new JourneyPlanError(path, `Journey plan step "${id}" has a malformed targetElementIds; expected an array of strings.`);
    }
    if (!isStringArray(rawStep['locatorCandidates'])) {
      throw new JourneyPlanError(path, `Journey plan step "${id}" has a malformed locatorCandidates; expected an array of strings.`);
    }

    for (const elementId of rawStep['targetElementIds']) {
      if (!/^element-\d{3,}$/.test(elementId)) {
        throw new JourneyPlanError(
          path,
          `Journey plan step "${id}" has a malformed element id "${elementId}"; expected the form element-001.`,
        );
      }
    }

    const source = rawStep['source'];
    if (source !== undefined && !isRecord(source)) {
      throw new JourneyPlanError(path, `Journey plan step "${id}" has a malformed source block.`);
    }

    return {
      id,
      order,
      intent: typeof rawStep['intent'] === 'string' ? rawStep['intent'] : id,
      action: action as JourneyAction,
      description: typeof rawStep['description'] === 'string' ? rawStep['description'] : '',
      targetElementIds: [...rawStep['targetElementIds']],
      locatorCandidates: [...rawStep['locatorCandidates']],
      expectedOutcome: typeof rawStep['expectedOutcome'] === 'string' ? rawStep['expectedOutcome'] : '',
      confidence: typeof rawStep['confidence'] === 'number' ? rawStep['confidence'] : 0,
      executable: false,
      source: isRecord(source) && isStringArray(source['elementIds'])
        ? { report: typeof source['report'] === 'string' ? source['report'] : '', elementIds: [...source['elementIds']] }
        : { report: '', elementIds: [] },
    };
  });

  // --- deterministic ordering --------------------------------------------
  // Steps execute in `order`, and the array must already agree with it, so the
  // run is reproducible from the file as written.
  const byArrayPosition = steps.every((step, position) => step.order === position + 1);
  if (!byArrayPosition) {
    throw new JourneyPlanError(
      path,
      'Journey plan step order values do not match array position. ' +
        'Execution follows the order field, so a mismatch would make the run non-deterministic.',
    );
  }

  const journeyTarget: JourneyTarget = {
    url: rawTarget['url'],
    finalUrl: isNullableString(rawTarget['finalUrl']) ? (rawTarget['finalUrl'] ?? null) : null,
    title: typeof rawTarget['title'] === 'string' ? rawTarget['title'] : '',
  };

  return {
    schemaVersion,
    goal: value['goal'],
    normalizedGoal: typeof value['normalizedGoal'] === 'string' ? value['normalizedGoal'] : value['goal'],
    journeyType: journeyType as JourneyType,
    target: journeyTarget,
    steps,
    assumptions: isStringArray(value['assumptions']) ? [...value['assumptions']] : [],
    warnings: isStringArray(value['warnings']) ? [...value['warnings']] : [],
    missingInformation: isStringArray(value['missingInformation']) ? [...value['missingInformation']] : [],
    planner: isRecord(value['planner'])
      ? {
          mode: 'heuristic',
          version: typeof value['planner']['version'] === 'string' ? value['planner']['version'] : 'unknown',
        }
      : { mode: 'heuristic', version: 'unknown' },
  };
}

/** Read, parse and validate a journey plan from disk. */
export async function loadJourneyPlan(path: string): Promise<JourneyPlan> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new JourneyPlanError(path, `Journey plan not found: ${path}. Run the journey command first.`);
    }
    if (code === 'EISDIR') {
      throw new JourneyPlanError(path, `Journey plan path is a directory, not a file: ${path}.`);
    }
    throw new JourneyPlanError(path, `Journey plan could not be read: ${(error as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new JourneyPlanError(path, `Journey plan is not valid JSON: ${(error as Error).message}`);
  }

  return validateJourneyPlan(parsed, path);
}
