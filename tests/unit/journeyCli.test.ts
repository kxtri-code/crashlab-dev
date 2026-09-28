import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseJourneyArgs, runJourneyCommand } from '../../src/cli/journeyCommand.js';
import { dispatch, main, parseArgs } from '../../src/cli.js';
import type { JourneyPlan } from '../../src/journey/types.js';
import { checkoutScoutReport, loginScoutReport } from '../fixtures/scoutReports.js';

let dir: string;
let scoutPath: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'crashlab-journey-cli-'));
  scoutPath = join(dir, 'scout.json');
  await writeFile(scoutPath, JSON.stringify(loginScoutReport()), 'utf8');
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
    const code = await runJourneyCommand(argv);
    return { code, stdout: logs.join('\n'), stderr: errors.join('\n') };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

describe('parseJourneyArgs', () => {
  it('parses goal, scout and out flags', () => {
    const args = parseJourneyArgs(['--goal', 'log in', '--scout', 'reports/scout.json', '--out', 'out/j.json']);
    expect(args).toMatchObject({
      goal: 'log in',
      scoutPath: 'reports/scout.json',
      outputPath: 'out/j.json',
      valid: true,
    });
  });

  it('parses inline flag values', () => {
    expect(parseJourneyArgs(['--goal=complete checkout']).goal).toBe('complete checkout');
  });

  it('defaults the scout path to the Build 1 report location', () => {
    expect(parseJourneyArgs(['--goal', 'x']).scoutPath).toBe('reports/scout.json');
  });

  it('defaults the output to reports/journey.json', () => {
    expect(parseJourneyArgs(['--goal', 'x']).outputPath).toBe('reports/journey.json');
  });

  it('accepts a positional goal', () => {
    expect(parseJourneyArgs(['log in']).goal).toBe('log in');
  });

  it('keeps the scout path exactly as supplied, without resolving it', () => {
    const args = parseJourneyArgs(['--goal', 'x', '--scout', './relative/../scout.json']);
    expect(args.scoutPath).toBe('./relative/../scout.json');
  });

  it('rejects an unknown option', () => {
    const args = parseJourneyArgs(['--goal', 'x', '--bogus']);
    expect(args.valid).toBe(false);
    expect(args.error).toContain('--bogus');
  });

  it('rejects --goal with no value', () => {
    const args = parseJourneyArgs(['--goal']);
    expect(args.valid).toBe(false);
    expect(args.error).toMatch(/requires a value/);
  });

  it('rejects --scout with no value', () => {
    expect(parseJourneyArgs(['--goal', 'x', '--scout']).valid).toBe(false);
  });

  it('rejects --out with no value', () => {
    expect(parseJourneyArgs(['--goal', 'x', '--out']).valid).toBe(false);
  });
});

describe('journey CLI exit codes', () => {
  it('succeeds and writes the plan for a valid invocation', async () => {
    const out = join(dir, 'plan-ok.json');
    const result = await run(['--goal', 'try to log in', '--scout', scoutPath, '--out', out]);
    expect(result.code).toBe(0);
    expect(existsSync(out)).toBe(true);
  });

  it('returns non-zero for a missing goal', async () => {
    const result = await run(['--scout', scoutPath]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Missing goal/i);
  });

  it('returns non-zero for a blank goal', async () => {
    const result = await run(['--goal', '   ', '--scout', scoutPath]);
    expect(result.code).toBe(1);
  });

  it('returns non-zero for a missing Scout report', async () => {
    const result = await run(['--goal', 'log in', '--scout', join(dir, 'nope.json')]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/not found/i);
  });

  it('returns non-zero for invalid Scout JSON', async () => {
    const bad = join(dir, 'bad.json');
    await writeFile(bad, '{ not json', 'utf8');
    const result = await run(['--goal', 'log in', '--scout', bad]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/not valid JSON/i);
  });

  it('returns non-zero for a structurally invalid Scout report', async () => {
    const bad = join(dir, 'invalid.json');
    await writeFile(bad, JSON.stringify({ meta: { tool: 'x' } }), 'utf8');
    const result = await run(['--goal', 'log in', '--scout', bad]);
    expect(result.code).toBe(1);
  });

  it('returns 2 for an unknown option', async () => {
    const result = await run(['--goal', 'x', '--nope']);
    expect(result.code).toBe(2);
  });

  it('returns 0 for a valid report with no matching elements', async () => {
    const empty = join(dir, 'empty.json');
    await writeFile(empty, JSON.stringify(checkoutScoutReport()), 'utf8');
    const out = join(dir, 'plan-empty.json');
    const result = await run(['--goal', 'try to complete checkout', '--scout', empty, '--out', out]);
    expect(result.code).toBe(0);
    const plan = JSON.parse(await readFile(out, 'utf8')) as JourneyPlan;
    expect(plan.steps.length).toBeGreaterThan(0);
  });
});

describe('journey CLI output', () => {
  it('writes valid JSON with the full schema', async () => {
    const out = join(dir, 'plan-schema.json');
    await run(['--goal', 'try to log in', '--scout', scoutPath, '--out', out]);
    const plan = JSON.parse(await readFile(out, 'utf8')) as JourneyPlan;

    expect(plan.schemaVersion).toBe('1.0');
    expect(plan.goal).toBe('try to log in');
    expect(plan.normalizedGoal).toBe('try to log in');
    expect(plan.journeyType).toBe('login');
    expect(Array.isArray(plan.steps)).toBe(true);
    expect(Array.isArray(plan.warnings)).toBe(true);
    expect(Array.isArray(plan.assumptions)).toBe(true);
    expect(Array.isArray(plan.missingInformation)).toBe(true);
    expect(plan.planner.mode).toBe('heuristic');
  });

  it('marks every written step executable: false', async () => {
    const out = join(dir, 'plan-exec.json');
    await run(['--goal', 'try to log in', '--scout', scoutPath, '--out', out]);
    const plan = JSON.parse(await readFile(out, 'utf8')) as JourneyPlan;
    expect(plan.steps.every((step) => step.executable === false)).toBe(true);
  });

  it('produces byte-identical output across repeated runs', async () => {
    const first = join(dir, 'det-1.json');
    const second = join(dir, 'det-2.json');
    await run(['--goal', 'try to log in', '--scout', scoutPath, '--out', first]);
    await run(['--goal', 'try to log in', '--scout', scoutPath, '--out', second]);
    expect(await readFile(first, 'utf8')).toBe(await readFile(second, 'utf8'));
  });

  it('prints a summary naming the report and denying execution', async () => {
    const result = await run(['--goal', 'try to log in', '--scout', scoutPath, '--out', join(dir, 'p.json')]);
    expect(result.stdout).toContain('JOURNEY PLANNER');
    expect(result.stdout).toContain('try to log in');
    expect(result.stdout).toMatch(/execution belongs to Build 3/);
  });

  it('does not write an output file when the goal is missing', async () => {
    const out = join(dir, 'never-written.json');
    await run(['--scout', scoutPath, '--out', out]);
    expect(existsSync(out)).toBe(false);
  });
});

describe('Build 1 CLI behaviour is unchanged', () => {
  it('still parses scout arguments identically', () => {
    const args = parseArgs(['https://example.com', '--timeout', '5000', '--out', 'x.json']);
    expect(args).toMatchObject({
      command: 'scout',
      url: 'https://example.com',
      timeoutMs: 5000,
      outputPath: 'x.json',
      valid: true,
    });
  });

  it('still defaults the scout output path', () => {
    expect(parseArgs(['https://example.com']).outputPath).toBe('reports/scout.json');
  });

  it('still reports bad scout arguments with exit code 2', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(await main(['https://x.test', '--nope'])).toBe(2);
    } finally {
      err.mockRestore();
      out.mockRestore();
    }
  });

  it('still prints help for a bare invocation', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(await main([])).toBe(0);
      expect(spy.mock.calls.flat().join('\n')).toContain('Usage:');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('dispatch', () => {
  it('routes the journey subcommand to the journey command', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(await dispatch(['journey', '--help'])).toBe(0);
      expect(spy.mock.calls.flat().join('\n')).toContain('--goal');
    } finally {
      spy.mockRestore();
    }
  });

  it('routes a bare URL to the scout path, unchanged', async () => {
    // The scout path must not be swallowed by the journey dispatch.
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      // Invalid scout args short-circuit before any browser is launched.
      expect(await dispatch(['https://x.test', '--nope'])).toBe(2);
    } finally {
      err.mockRestore();
      out.mockRestore();
    }
  });
});
