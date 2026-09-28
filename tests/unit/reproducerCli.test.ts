import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { REPRODUCE_FLAGS, parseReproduceArgs, runReproduceCommand } from '../../src/cli/reproduceCommand.js';
import { dispatch } from '../../src/cli.js';
import { loadReproductionInputs, validateAnomalyReport, validateJourneyReport } from '../../src/reproducer/inputLoader.js';
import { reproduceSignals, ReproductionRefused } from '../../src/reproducer/reproducer.js';
import { buildReproductionReport, summarizeReproductionReport } from '../../src/reproducer/reproductionReport.js';
import type { ReproductionInput } from '../../src/reproducer/types.js';
import { attempt } from '../fixtures/reproductionFixtures.js';
import { anomalyReport, http4xxSignal, http5xxSignal, reproJourney } from '../fixtures/reproductionFixtures.js';

let dir: string;
let anomalyPath: string;
let journeyPath: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'crashlab-repro-cli-'));
  journeyPath = join(dir, 'journey.json');
  anomalyPath = join(dir, 'anomalies.json');
  await writeFile(journeyPath, JSON.stringify(reproJourney()), 'utf8');
  await writeFile(anomalyPath, JSON.stringify(anomalyReport([http5xxSignal()])), 'utf8');
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Run the command with console output captured. */
async function run(argv: string[]) {
  const logs: string[] = [];
  const errors: string[] = [];
  const out = vi.spyOn(console, 'log').mockImplementation((...args) => void logs.push(args.join(' ')));
  const err = vi.spyOn(console, 'error').mockImplementation((...args) => void errors.push(args.join(' ')));
  try {
    const code = await runReproduceCommand(argv);
    return { code, stdout: logs.join('\n'), stderr: errors.join('\n') };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

describe('parseReproduceArgs', () => {
  it('defaults the input and output paths', () => {
    const args = parseReproduceArgs([]);
    expect(args.anomalyPath).toBe('reports/anomalies.json');
    expect(args.journeyPath).toBe('reports/journey.json');
    expect(args.outputPath).toBe('reports/reproduction.json');
    expect(args.attempts).toBe(3);
  });

  it('parses every documented flag', () => {
    const args = parseReproduceArgs([
      '--anomalies',
      'a.json',
      '--journey',
      'j.json',
      '--data',
      'd.json',
      '--out',
      'r.json',
      '--attempts',
      '5',
      '--headed',
      '--include-possibly-expected',
      '--confirm-authorized',
    ]);
    expect(args).toMatchObject({
      anomalyPath: 'a.json',
      journeyPath: 'j.json',
      dataPath: 'd.json',
      outputPath: 'r.json',
      attempts: 5,
      headed: true,
      includePossiblyExpected: true,
      confirmAuthorized: true,
      valid: true,
    });
  });

  it('does not confirm authorization by default', () => {
    expect(parseReproduceArgs([]).confirmAuthorized).toBe(false);
  });

  it('rejects an out-of-range attempt count rather than clamping', () => {
    expect(parseReproduceArgs(['--attempts', '0']).valid).toBe(false);
    expect(parseReproduceArgs(['--attempts', '6']).valid).toBe(false);
    expect(parseReproduceArgs(['--attempts', '99']).valid).toBe(false);
    expect(parseReproduceArgs(['--attempts', '-1']).valid).toBe(false);
    expect(parseReproduceArgs(['--attempts', '2.5']).valid).toBe(false);
  });

  it('accepts the in-range attempt counts', () => {
    for (const value of ['1', '2', '3', '4', '5']) {
      expect(parseReproduceArgs(['--attempts', value]).valid, value).toBe(true);
    }
  });

  it('rejects an unknown option', () => {
    const args = parseReproduceArgs(['--bogus']);
    expect(args.valid).toBe(false);
    expect(args.error).toContain('--bogus');
  });

  it('rejects a flag with no value', () => {
    for (const flag of ['--anomalies', '--journey', '--data', '--output', '--attempts', '--timeout']) {
      expect(parseReproduceArgs([flag]).valid, flag).toBe(false);
    }
  });

  it('has no flag that could confirm a bug or lift a safety guard', () => {
    const joined = (REPRODUCE_FLAGS as readonly string[]).join(' ');
    expect(joined).not.toMatch(/confirm-bug|severity|reproduce-again|unlimited|live-payment|unsafe/i);
  });
});

describe('input validation', () => {
  it('rejects a non-object anomaly root', () => {
    expect(() => validateAnomalyReport([], 'a.json')).toThrow(/must be a JSON object/);
  });

  it('rejects an unsupported anomaly schema version', () => {
    expect(() => validateAnomalyReport({ ...anomalyReport([]), schemaVersion: '9.9' }, 'a.json')).toThrow(
      /Unsupported anomaly report schemaVersion/,
    );
  });

  it('rejects an anomaly report with no anomalies array', () => {
    expect(() => validateAnomalyReport({ schemaVersion: '1.0' }, 'a.json')).toThrow(/anomalies array/);
  });

  it('rejects duplicate anomaly ids', () => {
    expect(() => validateAnomalyReport(anomalyReport([http5xxSignal('a'), http5xxSignal('a')]), 'a.json')).toThrow(
      /duplicate anomaly id "a"/,
    );
  });

  it('rejects an anomaly with no ruleId', () => {
    const broken = anomalyReport([http5xxSignal()]);
    (broken.anomalies[0] as unknown as Record<string, unknown>)['ruleId'] = undefined;
    expect(() => validateAnomalyReport(broken, 'a.json')).toThrow(/has no ruleId/);
  });

  it('rejects an unsupported journey schema version', () => {
    expect(() => validateJourneyReport({ ...reproJourney(), schemaVersion: '7.0' }, 'j.json')).toThrow(
      /Unsupported journey report schemaVersion/,
    );
  });

  it('rejects a journey with no goal or target', () => {
    expect(() => validateJourneyReport({ ...reproJourney(), goal: '' }, 'j.json')).toThrow(/goal/);
    expect(() => validateJourneyReport({ ...reproJourney(), target: undefined }, 'j.json')).toThrow(/target/);
  });

  it('loads both artifacts from disk', async () => {
    const loaded = await loadReproductionInputs(anomalyPath, journeyPath);
    expect(loaded.anomalies.anomalies).toHaveLength(1);
    expect(loaded.journey.goal).toBeTruthy();
  });

  it('reports a missing file', async () => {
    await expect(loadReproductionInputs(join(dir, 'absent.json'), journeyPath)).rejects.toThrow(/not found/);
  });
});

describe('reproduce CLI: safety gates', () => {
  it('refuses without --confirm-authorized and writes nothing', async () => {
    const out = join(dir, 'never-1.json');
    const result = await run(['--anomalies', anomalyPath, '--journey', journeyPath, '--output', out]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/--confirm-authorized/);
    expect(result.stderr).toMatch(/No browser was opened/);
    expect(existsSync(out)).toBe(false);
  });

  it('checks authorization before reading the inputs', async () => {
    // A missing anomaly file still yields the authorization error, proving the
    // gate runs first.
    const result = await run(['--anomalies', join(dir, 'absent.json')]);
    expect(result.stderr).toMatch(/--confirm-authorized/);
    expect(result.stderr).not.toMatch(/not found/);
  });

  it('returns 2 for an unknown option', async () => {
    expect((await run(['--confirm-authorized', '--bogus'])).code).toBe(2);
  });

  it('returns 1 for a missing anomaly report', async () => {
    const out = join(dir, 'never-2.json');
    const result = await run([
      '--anomalies',
      join(dir, 'absent.json'),
      '--journey',
      journeyPath,
      '--output',
      out,
      '--confirm-authorized',
    ]);
    expect(result.code).toBe(1);
    expect(existsSync(out)).toBe(false);
  });

  it('returns 1 for a missing journey report', async () => {
    const result = await run([
      '--anomalies',
      anomalyPath,
      '--journey',
      join(dir, 'absent.json'),
      '--confirm-authorized',
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Journey report not found/);
  });

  it('returns 1 for invalid anomaly JSON', async () => {
    const path = join(dir, 'bad-anomalies.json');
    await writeFile(path, '{ nope', 'utf8');
    const result = await run(['--anomalies', path, '--journey', journeyPath, '--confirm-authorized']);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/not valid JSON/);
  });

  it('returns 1 for invalid journey JSON', async () => {
    const path = join(dir, 'bad-journey.json');
    await writeFile(path, 'nope', 'utf8');
    const result = await run(['--anomalies', anomalyPath, '--journey', path, '--confirm-authorized']);
    expect(result.code).toBe(1);
  });

  it('returns 1 for an unsupported schema version', async () => {
    const path = join(dir, 'v9.json');
    await writeFile(path, JSON.stringify({ ...anomalyReport([]), schemaVersion: '9.9' }), 'utf8');
    const result = await run(['--anomalies', path, '--journey', journeyPath, '--confirm-authorized']);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Unsupported anomaly report schemaVersion/);
  });

  it('returns 1 for malformed test data, before any browser opens', async () => {
    const dataPath = join(dir, 'bad-data.json');
    await writeFile(dataPath, JSON.stringify({ user: { email: 'a@b.test' } }), 'utf8');
    const out = join(dir, 'never-3.json');
    const result = await run([
      '--anomalies',
      anomalyPath,
      '--journey',
      journeyPath,
      '--data',
      dataPath,
      '--output',
      out,
      '--confirm-authorized',
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/string keys to string values/);
    expect(existsSync(out)).toBe(false);
  });
});

describe('reproduceSignals', () => {
  /** A reproducer input with no browser needed. */
  function input(overrides: Partial<ReproductionInput> = {}): ReproductionInput {
    return {
      anomalies: anomalyReport([http5xxSignal()]),
      journey: reproJourney(),
      attempts: 1,
      authorized: true,
      anomalyPath: 'reports/anomalies.json',
      journeyPath: 'reports/journey.json',
      executionPath: 'reports/execution.json',
      includePossiblyExpected: false,
      outputDir: join(dir, 'artifacts'),
      ...overrides,
    };
  }

  it('refuses when authorization is absent, before any browser opens', async () => {
    await expect(reproduceSignals(input({ authorized: false }))).rejects.toThrow(ReproductionRefused);
    expect(existsSync(join(dir, 'artifacts'))).toBe(false);
  });

  it('produces a valid report with no browser when nothing is eligible', async () => {
    // Only an ineligible signal, so the run must not launch anything.
    const report = await reproduceSignals(input({ anomalies: anomalyReport([http4xxSignal()]) }));
    expect(report.runs).toEqual([]);
    expect(report.reproducer.attemptsRequested).toBe(1);
    expect(report.reproducer.attemptsCompleted).toBe(0);
    expect(report.results).toHaveLength(1);
    expect(report.results[0]?.classification).toBe('ineligible');
  });

  it('produces a valid report with no browser when there are no signals at all', async () => {
    const report = await reproduceSignals(input({ anomalies: anomalyReport([]) }));
    expect(report.runs).toEqual([]);
    expect(report.results).toEqual([]);
    expect(report.summary.totalSignals).toBe(0);
  });
});

describe('reproduction report', () => {
  /** Build a report from fixed attempts, no browser involved. */
  function reportFor(anomalies: AnomalyReportLike, attempts: ReturnType<typeof attempt>[]) {
    return buildReproductionReport(
      {
        anomalies,
        journey: reproJourney(),
        attempts: attempts.length,
        authorized: true,
        anomalyPath: 'reports/anomalies.json',
        journeyPath: 'reports/journey.json',
        executionPath: 'reports/execution.json',
        includePossiblyExpected: false,
        outputDir: 'reports/reproduction',
      },
      attempts,
    );
  }

  it('has every required field', () => {
    const report = reportFor(anomalyReport([http5xxSignal()]), [
      attempt(1, [http5xxSignal()]),
      attempt(2, [http5xxSignal()]),
    ]);
    for (const key of [
      'schemaVersion',
      'journeyReport',
      'anomalyReport',
      'attemptsRequested',
      'attemptsCompleted',
      'summary',
      'runs',
      'results',
      'safety',
      'reproducer',
      'interpretation',
    ]) {
      // attemptsRequested/attemptsCompleted live under `reproducer`.
      if (key === 'attemptsRequested') expect(report.reproducer.attemptsRequested).toBe(2);
      else if (key === 'attemptsCompleted') expect(report.reproducer.attemptsCompleted).toBe(2);
      else expect(report, key).toHaveProperty(key);
    }
  });

  it('references per-attempt artifacts instead of copying them', () => {
    const report = reportFor(anomalyReport([http5xxSignal()]), [attempt(1, [http5xxSignal()]), attempt(2, [http5xxSignal()])]);
    expect(report.runs[0]?.executionReport).toContain('attempt-001');
    expect(report.runs[0]?.anomalyReport).toContain('attempt-001');
    // The execution report's own evidence must not be inlined.
    expect(report).not.toHaveProperty('rawEvidence');
  });

  it('records the safety guarantees', () => {
    const report = reportFor(anomalyReport([http5xxSignal()]), [attempt(1, [http5xxSignal()])]);
    expect(report.safety).toMatchObject({
      authorizedConfirmationRequired: true,
      safeTestMode: true,
      livePaymentAllowed: false,
      sensitiveValuesRedacted: true,
    });
  });

  it('always reports automaticRetries false', () => {
    const report = reportFor(anomalyReport([http5xxSignal()]), [attempt(1, [http5xxSignal()])]);
    expect(report.reproducer.automaticRetries).toBe(false);
  });

  it('never confirms a bug', () => {
    const report = reportFor(anomalyReport([http5xxSignal()]), [
      attempt(1, [http5xxSignal()]),
      attempt(2, [http5xxSignal()]),
      attempt(3, [http5xxSignal()]),
    ]);
    expect(report.interpretation.confirmedBug).toBe(false);
    expect(report.results.every((result) => result.confirmed === false)).toBe(true);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toMatch(/confirmedBug":\s*true|bugConfirmed|defectConfirmed|reproduced":\s*true/);
  });

  it('produces byte-identical output for the same inputs', () => {
    const anomalies = anomalyReport([http5xxSignal(), http4xxSignal()]);
    const attempts = [attempt(1, [http5xxSignal()]), attempt(2, [http5xxSignal()]), attempt(3, [http5xxSignal()])];
    const first = JSON.stringify(reportFor(anomalies, attempts), null, 2);
    for (let i = 0; i < 3; i++) {
      expect(JSON.stringify(reportFor(anomalies, attempts), null, 2)).toBe(first);
    }
  });

  it('contains no timestamp, so output is stable over time', () => {
    const report = reportFor(anomalyReport([http5xxSignal()]), [attempt(1, [http5xxSignal()])]);
    expect(JSON.stringify(report)).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });

  it('reports signals, never bugs, in the terminal output', () => {
    const report = reportFor(anomalyReport([http5xxSignal()]), [
      attempt(1, [http5xxSignal()]),
      attempt(2, [http5xxSignal()]),
    ]);
    const summary = summarizeReproductionReport(report);
    expect(summary).toMatch(/SIGNALS/);
    expect(summary).toMatch(/Confirmed bugs: 0/);
    expect(summary).toMatch(/candidate, not a confirmed defect/);
    expect(summary).toMatch(/declared attempts only/);
  });
});

/** Loose alias so the test can name the fixture type without importing it twice. */
type AnomalyReportLike = ReturnType<typeof anomalyReport>;

describe('dispatch', () => {
  it('routes the reproduce subcommand', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(await dispatch(['reproduce', '--help'])).toBe(0);
      expect(spy.mock.calls.flat().join('\n')).toContain('--anomalies');
    } finally {
      spy.mockRestore();
    }
  });

  it('still routes every earlier command unchanged', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(await dispatch(['journey', '--help'])).toBe(0);
      expect(await dispatch(['execute', '--help'])).toBe(0);
      expect(await dispatch(['anomalies', '--help'])).toBe(0);
      expect(spy.mock.calls.flat().join('\n')).toContain('--goal');
    } finally {
      spy.mockRestore();
    }
  });

  it('still routes scout unchanged', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(await dispatch(['https://x.test', '--nope'])).toBe(2);
    } finally {
      err.mockRestore();
      out.mockRestore();
    }
  });
});
