/**
 * Scout report loading and validation.
 *
 * Build 2 consumes a Build 1 report. Validation is deliberately *structural*
 * rather than a full schema re-statement: the goal is to reject input that
 * would make planning meaningless (no target, no element array, untraceable
 * elements), not to re-litigate every field Build 1 already types.
 *
 * Element types are imported from Build 1 rather than redeclared.
 */

import { readFile } from 'node:fs/promises';
import type {
  InteractiveElement,
  InteractiveElementType,
  ScoutForm,
  ScoutReport,
} from '../scout/types.js';

/** A validation failure that should stop planning, with a usable message. */
export class ScoutReportError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.name = 'ScoutReportError';
    this.path = path;
  }
}

/** Element types Build 1 can emit, used to validate the `type` field. */
const KNOWN_ELEMENT_TYPES = new Set<string>([
  'button',
  'link',
  'input',
  'select',
  'textarea',
  'checkbox',
  'radio',
  'other',
]);

/** True for a plain object (not null, not an array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True for a string or null. */
function isNullableString(value: unknown): value is string | null {
  return value === null || value === undefined || typeof value === 'string';
}

/** Stable, deterministic element id derived from the Scout element's index. */
export function elementIdFor(index: number): string {
  return `element-${String(index + 1).padStart(3, '0')}`;
}

/**
 * Validate a parsed JSON value as a usable Scout report.
 *
 * @throws {ScoutReportError} when the report cannot be planned against.
 */
export function validateScoutReport(value: unknown, path: string): ScoutReport {
  if (!isRecord(value)) {
    throw new ScoutReportError(path, 'Scout report root must be a JSON object.');
  }

  const meta = value['meta'];
  if (!isRecord(meta) || typeof meta['tool'] !== 'string' || typeof meta['version'] !== 'string') {
    throw new ScoutReportError(
      path,
      'Scout report is missing required metadata: expected meta.tool and meta.version strings. ' +
        'Re-run the scout command to produce a current report.',
    );
  }

  const target = value['target'];
  if (!isRecord(target) || typeof target['inputUrl'] !== 'string') {
    throw new ScoutReportError(path, 'Scout report is missing required target metadata: expected target.inputUrl.');
  }

  const elements = value['interactiveElements'];
  if (!Array.isArray(elements)) {
    throw new ScoutReportError(
      path,
      'Scout report is missing an interactiveElements array, so no elements can be planned against.',
    );
  }

  const badIndex = elements.findIndex(
    (element) => !isRecord(element) || typeof element['index'] !== 'number' || !Number.isInteger(element['index']),
  );
  if (badIndex >= 0) {
    throw new ScoutReportError(
      path,
      `Scout report element at position ${badIndex} has no integer index, so it cannot be referenced by a journey step.`,
    );
  }

  const badSelector = elements.findIndex((element) => !isRecord(element) || typeof element['selector'] !== 'string');
  if (badSelector >= 0) {
    throw new ScoutReportError(
      path,
      `Scout report element at position ${badSelector} has no selector string, so it cannot be referenced by a journey step.`,
    );
  }

  // A duplicate index means two elements would resolve to the same journey id,
  // which breaks step-to-element traceability.
  const seen = new Set<number>();
  for (const element of elements) {
    const index = (element as { index: number }).index;
    if (seen.has(index)) {
      throw new ScoutReportError(
        path,
        `Scout report contains duplicate element index ${index}, which would make journey steps ambiguous.`,
      );
    }
    seen.add(index);
  }

  const badType = elements.findIndex((element) => {
    const type = (element as Record<string, unknown>)['type'];
    return type !== undefined && typeof type === 'string' && !KNOWN_ELEMENT_TYPES.has(type);
  });
  if (badType >= 0) {
    throw new ScoutReportError(
      path,
      `Scout report element at position ${badType} has an unrecognised type; expected one of ${[...KNOWN_ELEMENT_TYPES].join(', ')}.`,
    );
  }

  const forms = value['forms'];
  if (forms !== undefined && !Array.isArray(forms)) {
    throw new ScoutReportError(path, 'Scout report forms must be an array when present.');
  }

  return value as unknown as ScoutReport;
}

/** Read, parse and validate a Scout report from disk. */
export async function loadScoutReport(path: string): Promise<ScoutReport> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new ScoutReportError(path, `Scout report not found: ${path}. Run the scout command first.`);
    }
    if (code === 'EISDIR') {
      throw new ScoutReportError(path, `Scout report path is a directory, not a file: ${path}.`);
    }
    throw new ScoutReportError(path, `Scout report could not be read: ${(error as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ScoutReportError(path, `Scout report is not valid JSON: ${(error as Error).message}`);
  }

  return validateScoutReport(parsed, path);
}

/**
 * Narrow a Scout element for planner use.
 *
 * Build 1 types these fields, but a report on disk is untrusted input, so the
 * planner re-checks the fields it actually reads before trusting them.
 */
export function asInteractiveElement(value: unknown): InteractiveElement | null {
  if (!isRecord(value)) return null;
  if (typeof value['index'] !== 'number' || typeof value['selector'] !== 'string') return null;

  const type = typeof value['type'] === 'string' ? value['type'] : 'other';
  return {
    index: value['index'],
    type: (KNOWN_ELEMENT_TYPES.has(type) ? type : 'other') as InteractiveElementType,
    tag: typeof value['tag'] === 'string' ? value['tag'] : '',
    text: isNullableString(value['text']) ? (value['text'] ?? null) : null,
    label: isNullableString(value['label']) ? (value['label'] ?? null) : null,
    name: isNullableString(value['name']) ? (value['name'] ?? null) : null,
    id: isNullableString(value['id']) ? (value['id'] ?? null) : null,
    placeholder: isNullableString(value['placeholder']) ? (value['placeholder'] ?? null) : null,
    ariaLabel: isNullableString(value['ariaLabel']) ? (value['ariaLabel'] ?? null) : null,
    role: isNullableString(value['role']) ? (value['role'] ?? null) : null,
    href: isNullableString(value['href']) ? (value['href'] ?? null) : null,
    inputType: isNullableString(value['inputType']) ? (value['inputType'] ?? null) : null,
    // The planner never reads `value`, but the field is kept so the element can
    // be echoed back without a lossy cast if that ever changes.
    value: isNullableString(value['value']) ? (value['value'] ?? null) : null,
    selector: value['selector'],
    locator: isNullableString(value['locator']) ? (value['locator'] ?? null) : null,
    visible: value['visible'] === true,
    enabled: value['enabled'] === true,
    required: value['required'] === true,
    disabled: value['disabled'] === true,
    readonly: value['readonly'] === true,
    formIndex: typeof value['formIndex'] === 'number' ? value['formIndex'] : null,
  };
}

/** Narrow the interactive-element array, dropping entries that cannot be used. */
export function extractElements(report: ScoutReport): InteractiveElement[] {
  const raw = Array.isArray(report.interactiveElements) ? report.interactiveElements : [];
  return raw
    .map(asInteractiveElement)
    .filter((element): element is InteractiveElement => element !== null)
    .sort((a, b) => a.index - b.index);
}

/** Narrow the forms array for planner use. */
export function extractForms(report: ScoutReport): ScoutForm[] {
  return Array.isArray(report.forms) ? (report.forms as ScoutForm[]) : [];
}
