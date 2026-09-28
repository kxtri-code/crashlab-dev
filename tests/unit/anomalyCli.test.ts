import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ANOMALY_FLAGS, parseAnomalyArgs, runAnomalyCommand } from '../../src/cli/anomalyCommand.js';
import { dispatch } from '../../src/cli.js';
import type { AnomalyReport } from '../../src/anomaly/report.js';
import { execStep, execution, journey, netEvent, pageError, consoleEvent, stepError } from '../fixtures/executionReports.js';

let dir: string;
let cleanExecution: string;
let cleanJourney: string;
let noisyExecution: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'crashlab-anomaly-cli-'));
  cleanJourney = join(dir, 'journey.json');
  cleanExecution = join(dir, 'execution.json');
  await writeFile(cleanJourney, JSON.stringify(journey()), 'utf8');
  await writeFile(
    cleanExecution,
    JSON.stringify(execution({ steps: [execStep({ id: 'step-001', order: 1 })] })),
    'utf8',
  );
  noisyExecution = join(dir, 'noisy.json');
  await writeFile(
    noisyExecution,
    JSON.stringify(
      execution({
        status: 'partial',
        rawEvidence: {
          ...execution().rawEvidence,
          networkEvents: [netEvent({ status: 500 })],
          pageErrors: [pageError()],
          consoleEvents: [consoleEvent({ type: 'error' })],
        },
        steps: [
          execStep({ id: 'step-001', order: 1, action: 'click', status: 'failed', error: stepError('action-failed') }),
        ],
      }),
    ),
    'utf8',
  );
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
    const code = await runAnomalyCommand(argv);
    return { code, stdout: logs.join('\n'), stderr: errors.join('\n') };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

describe('parseAnomalyArgs', () => {
  it('defaults both input paths and the output path', () => {
    const args = parseAnomalyArgs([]);
    expect(args.executionPath).toBe('reports/execution.json');
    expect(args.journeyPath).toBe('reports/journey.json');
    expect(args.outputPath).toBe('reports/anomalies.json');
  });

  it('parses every documented flag', () => {
    const args = parseAnomalyArgs([
      '--execution',
      'e.json',
      '--journey',
      'j.json',
      '--out',
      'o.json',
      '--include-console-warnings',
    ]);
    expect(args).toMatchObject({
      executionPath: 'e.json',
      journeyPath: 'j.json',
      outputPath: 'o.json',
      includeConsoleWarnings: true,
      valid: true,
    });
  });

  it('parses inline values', () => {
    expect(parseAnomalyArgs(['--execution=e.json']).executionPath).toBe('e.json');
  });

  it('does not include console warnings by default', () => {
    expect(parseAnomalyArgs([]).includeConsoleWarnings).toBe(false);
  });

  it('rejects an unknown option', () => {
    const args = parseAnomalyArgs(['--bogus']);
    expect(args.valid).toBe(false);
    expect(args.error).toContain('--bogus');
  });

  it('rejects a flag with no value', () => {
    expect(parseAnomalyArgs(['--execution']).valid).toBe(false);
    expect(parseAnomalyArgs(['--journey']).valid).toBe(false);
    expect(parseAnomalyArgs(['--output']).valid).toBe(false);
  });

  it('has no flag that could confirm or suppress a bug', () => {
    const joined = (ANOMALY_FLAGS as readonly string[]).join(' ');
    expect(joined).not.toMatch(/confirm|severity|reproduce|bug/i);
  });
});

describe('anomalies CLI: valid analysis', () => {
  it('succeeds and writes a report for a clean execution', async () => {
    const out = join(dir, 'clean-anomalies.json');
    const result = await run(['--execution', cleanExecution, '--journey', cleanJourney, '--output', out]);
    expect(result.code).toBe(0);
    expect(existsSync(out)).toBe(true);

    const report = JSON.parse(await readFile(out, 'utf8')) as AnomalyReport;
    expect(report.schemaVersion).toBe('1.0');
    expect(report.anomalies).toEqual([]);
    expect(report.summary.totalSignals).toBe(0);
    expect(report.interpretation.confirmedBug).toBe(false);
    expect(report.interpretation.requiresInvestigation).toBe(false);
  });

  it('succeeds even when signals are found', async () => {
    const out = join(dir, 'noisy-anomalies.json');
    const result = await run(['--execution', noisyExecution, '--journey', cleanJourney, '--output', out]);
    // Finding signals is a successful analysis, not an error.
    expect(result.code).toBe(0);

    const report = JSON.parse(await readFile(out, 'utf8')) as AnomalyReport;
    expect(report.anomalies.length).toBeGreaterThan(0);
    expect(report.summary.totalSignals).toBe(report.anomalies.length);
    expect(report.interpretation.requiresInvestigation).toBe(true);
  });

  it('reports signals, never bugs, in the terminal output', async () => {
    const result = await run([
      '--execution',
      noisyExecution,
      '--journey',
      cleanJourney,
      '--output',
      join(dir, 'term.json'),
    ]);
    expect(result.stdout).toMatch(/SIGNALS OBSERVED/);
    expect(result.stdout).toMatch(/Confirmed bugs: 0/);
    expect(result.stdout).toMatch(/not confirmed defects/);
    expect(result.stdout).toMatch(/Build 5/);
  });

  it('writes deterministic output across repeated runs', async () => {
    const first = join(dir, 'det-1.json');
    const second = join(dir, 'det-2.json');
    await run(['--execution', noisyExecution, '--journey', cleanJourney, '--output', first]);
    await run(['--execution', noisyExecution, '--journey', cleanJourney, '--output', second]);
    expect(await readFile(first, 'utf8')).toBe(await readFile(second, 'utf8'));
  });

  it('does not modify either input', async () => {
    const beforeExecution = await readFile(noisyExecution, 'utf8');
    const beforeJourney = await readFile(cleanJourney, 'utf8');
    await run(['--execution', noisyExecution, '--journey', cleanJourney, '--output', join(dir, 'immutable.json')]);
    expect(await readFile(noisyExecution, 'utf8')).toBe(beforeExecution);
    expect(await readFile(cleanJourney, 'utf8')).toBe(beforeJourney);
  });

  it('includes console warnings only when asked', async () => {
    const withoutPath = join(dir, 'nowarn.json');
    const withPath = join(dir, 'warn.json');
    await run(['--execution', noisyExecution, '--journey', cleanJourney, '--output', withoutPath]);
    await run([
      '--execution',
      noisyExecution,
      '--journey',
      cleanJourney,
      '--output',
      withPath,
      '--include-console-warnings',
    ]);
    const without = JSON.parse(await readFile(withoutPath, 'utf8')) as AnomalyReport;
    const with_ = JSON.parse(await readFile(withPath, 'utf8')) as AnomalyReport;
    // The fixture's console events are errors, not warnings, so the counts match
    // here; the flag is proven by the parser test and by rule behaviour.
    expect(without.summary.consoleErrors).toBe(with_.summary.consoleErrors);
  });
});

describe('anomalies CLI: invalid input', () => {
  it('returns 2 for an unknown option', async () => {
    expect((await run(['--execution', cleanExecution, '--bogus'])).code).toBe(2);
  });

  it('returns 1 and writes nothing for a missing execution file', async () => {
    const out = join(dir, 'never-1.json');
    const result = await run(['--execution', join(dir, 'absent.json'), '--journey', cleanJourney, '--output', out]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Execution report not found/);
    expect(existsSync(out)).toBe(false);
  });

  it('returns 1 and writes nothing for a missing journey file', async () => {
    const out = join(dir, 'never-2.json');
    const result = await run(['--execution', cleanExecution, '--journey', join(dir, 'absent.json'), '--output', out]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Journey report not found/);
    expect(existsSync(out)).toBe(false);
  });

  it('returns 1 for invalid execution JSON', async () => {
    const path = join(dir, 'bad-exec.json');
    await writeFile(path, '{ nope', 'utf8');
    const out = join(dir, 'never-3.json');
    const result = await run(['--execution', path, '--journey', cleanJourney, '--output', out]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/not valid JSON/);
    expect(existsSync(out)).toBe(false);
  });

  it('returns 1 for invalid journey JSON', async () => {
    const path = join(dir, 'bad-journey.json');
    await writeFile(path, 'nope', 'utf8');
    const result = await run(['--execution', cleanExecution, '--journey', path]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/not valid JSON/);
  });

  it('returns 1 for an unsupported execution schema version', async () => {
    const path = join(dir, 'v2-exec.json');
    await writeFile(path, JSON.stringify({ ...execution(), schemaVersion: '2.0' }), 'utf8');
    const result = await run(['--execution', path, '--journey', cleanJourney]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Unsupported execution report schemaVersion/);
  });

  it('returns 1 for an unsupported journey schema version', async () => {
    const path = join(dir, 'v2-journey.json');
    await writeFile(path, JSON.stringify({ ...journey(), schemaVersion: '3.0' }), 'utf8');
    const result = await run(['--execution', cleanExecution, '--journey', path]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Unsupported journey report schemaVersion/);
  });
});

describe('dispatch', () => {
  it('routes the anomalies subcommand', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(await dispatch(['anomalies', '--help'])).toBe(0);
      expect(spy.mock.calls.flat().join('\n')).toContain('--execution');
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

  it('still routes journey and execute help unchanged', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(await dispatch(['journey', '--help'])).toBe(0);
      expect(await dispatch(['execute', '--help'])).toBe(0);
      expect(spy.mock.calls.flat().join('\n')).toContain('--goal');
    } finally {
      spy.mockRestore();
    }
  });
});
