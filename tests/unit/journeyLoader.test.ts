import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asInteractiveElement,
  elementIdFor,
  extractElements,
  loadScoutReport,
  ScoutReportError,
  validateScoutReport,
} from '../../src/journey/scoutLoader.js';
import { planJourney } from '../../src/journey/plan.js';
import { emptyScoutReport, loginScoutReport } from '../fixtures/scoutReports.js';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'crashlab-journey-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Write a fixture to the temp dir and return its path. */
async function write(name: string, contents: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, contents, 'utf8');
  return path;
}

describe('elementIdFor', () => {
  it('pads to three digits', () => {
    expect(elementIdFor(0)).toBe('element-001');
    expect(elementIdFor(9)).toBe('element-010');
    expect(elementIdFor(99)).toBe('element-100');
    expect(elementIdFor(1234)).toBe('element-1235');
  });
});

describe('validateScoutReport', () => {
  it('accepts a well-formed report', () => {
    const report = validateScoutReport(JSON.parse(JSON.stringify(loginScoutReport())), 'x.json');
    expect(report.meta.tool).toBe('CrashLab Scout');
  });

  it('rejects a non-object root', () => {
    expect(() => validateScoutReport([], 'x.json')).toThrow(ScoutReportError);
    expect(() => validateScoutReport('nope', 'x.json')).toThrow(/must be a JSON object/);
    expect(() => validateScoutReport(null, 'x.json')).toThrow(/must be a JSON object/);
  });

  it('rejects missing metadata', () => {
    const report = JSON.parse(JSON.stringify(loginScoutReport())) as Record<string, unknown>;
    delete report['meta'];
    expect(() => validateScoutReport(report, 'x.json')).toThrow(/metadata/i);
  });

  it('rejects metadata missing a required field', () => {
    const report = JSON.parse(JSON.stringify(loginScoutReport())) as { meta: Record<string, unknown> };
    delete report.meta['version'];
    expect(() => validateScoutReport(report, 'x.json')).toThrow(/metadata/i);
  });

  it('rejects missing target', () => {
    const report = JSON.parse(JSON.stringify(loginScoutReport())) as Record<string, unknown>;
    delete report['target'];
    expect(() => validateScoutReport(report, 'x.json')).toThrow(/target/i);
  });

  it('rejects a missing interactiveElements array', () => {
    const report = JSON.parse(JSON.stringify(loginScoutReport())) as Record<string, unknown>;
    delete report['interactiveElements'];
    expect(() => validateScoutReport(report, 'x.json')).toThrow(/interactiveElements/);
  });

  it('rejects a non-array interactiveElements', () => {
    const report = JSON.parse(JSON.stringify(loginScoutReport())) as Record<string, unknown>;
    report['interactiveElements'] = { nope: true };
    expect(() => validateScoutReport(report, 'x.json')).toThrow(/interactiveElements array/);
  });

  it('rejects an element without an index, breaking traceability', () => {
    const report = JSON.parse(JSON.stringify(loginScoutReport())) as { interactiveElements: Record<string, unknown>[] };
    delete report.interactiveElements[1]!['index'];
    expect(() => validateScoutReport(report, 'x.json')).toThrow(/integer index/);
  });

  it('rejects an element without a selector', () => {
    const report = JSON.parse(JSON.stringify(loginScoutReport())) as { interactiveElements: Record<string, unknown>[] };
    delete report.interactiveElements[0]!['selector'];
    expect(() => validateScoutReport(report, 'x.json')).toThrow(/selector/);
  });

  it('rejects duplicate element indices', () => {
    const report = JSON.parse(JSON.stringify(loginScoutReport())) as { interactiveElements: { index: number }[] };
    report.interactiveElements[1]!.index = report.interactiveElements[0]!.index;
    expect(() => validateScoutReport(report, 'x.json')).toThrow(/duplicate element index/);
  });

  it('rejects an unrecognised element type', () => {
    const report = JSON.parse(JSON.stringify(loginScoutReport())) as { interactiveElements: Record<string, unknown>[] };
    report.interactiveElements[0]!['type'] = 'teleporter';
    expect(() => validateScoutReport(report, 'x.json')).toThrow(/unrecognised type/);
  });

  it('rejects malformed forms', () => {
    const report = JSON.parse(JSON.stringify(loginScoutReport())) as Record<string, unknown>;
    report['forms'] = 'not an array';
    expect(() => validateScoutReport(report, 'x.json')).toThrow(/forms/);
  });

  it('accepts a report with an empty element array', () => {
    expect(() => validateScoutReport(JSON.parse(JSON.stringify(emptyScoutReport())), 'x.json')).not.toThrow();
  });
});

describe('loadScoutReport', () => {
  it('reports a missing file with actionable advice', async () => {
    const missing = join(dir, 'does-not-exist.json');
    await expect(loadScoutReport(missing)).rejects.toThrow(/not found/i);
    await expect(loadScoutReport(missing)).rejects.toThrow(/Run the scout command first/i);
  });

  it('reports a directory passed in place of a file', async () => {
    await expect(loadScoutReport(dir)).rejects.toThrow(/directory/i);
  });

  it('reports invalid JSON', async () => {
    const path = await write('broken.json', '{ this is not json');
    await expect(loadScoutReport(path)).rejects.toThrow(/not valid JSON/i);
  });

  it('reports a structurally invalid report', async () => {
    const path = await write('invalid.json', JSON.stringify({ meta: {}, target: {} }));
    await expect(loadScoutReport(path)).rejects.toThrow(ScoutReportError);
  });

  it('loads a valid report', async () => {
    const path = await write('valid.json', JSON.stringify(loginScoutReport()));
    const report = await loadScoutReport(path);
    expect(report.target.title).toBe('Sign in');
  });
});

describe('planning from a file on disk', () => {
  it('plans against a report loaded from disk', async () => {
    const path = await write('login.json', JSON.stringify(loginScoutReport()));
    const report = await loadScoutReport(path);
    const plan = planJourney('log in', report, path);
    expect(plan.steps.length).toBeGreaterThan(0);
    expect(plan.target.url).toBe('https://staging.example.test/login');
  });
});

describe('asInteractiveElement', () => {
  it('rejects an object with no index or selector', () => {
    expect(asInteractiveElement({ selector: '#a' })).toBeNull();
    expect(asInteractiveElement({ index: 0 })).toBeNull();
    expect(asInteractiveElement(null)).toBeNull();
    expect(asInteractiveElement('x')).toBeNull();
  });

  it('coerces an unknown type to other', () => {
    expect(asInteractiveElement({ index: 0, selector: '#a', type: 'teleporter' })?.type).toBe('other');
  });

  it('defaults visibility and enabled to false when absent', () => {
    const element = asInteractiveElement({ index: 0, selector: '#a' });
    expect(element?.visible).toBe(false);
    expect(element?.enabled).toBe(false);
  });
});

describe('extractElements', () => {
  it('sorts by document order and skips unusable entries', () => {
    const report = loginScoutReport();
    report.interactiveElements.push({ ...report.interactiveElements[0]!, index: 99 });
    // A malformed entry injected into the middle must be dropped, not crash.
    (report.interactiveElements as unknown[]).splice(2, 0, { type: 'button' });

    const elements = extractElements(report);
    expect(elements.map((element) => element.index)).toEqual([...elements.map((element) => element.index)].sort((a, b) => a - b));
    expect(elements.every((element) => typeof element.selector === 'string')).toBe(true);
  });
});
