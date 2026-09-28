import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseExecuteArgs, runExecuteCommand, EXECUTE_FLAGS } from '../../src/cli/executeCommand.js';
import { dispatch } from '../../src/cli.js';
import { planWith, step } from '../fixtures/journeyPlans.js';

let dir: string;
let validPlanPath: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'crashlab-exec-cli-'));
  validPlanPath = join(dir, 'journey.json');
  await writeFile(
    validPlanPath,
    JSON.stringify(
      planWith([step({ id: 'step-001', order: 1, action: 'observe', locatorCandidates: ['#nothing'] })], {
        goal: 'cli fixture',
        target: { url: 'http://127.0.0.1:9/unreachable', finalUrl: null, title: 'x' },
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
    const code = await runExecuteCommand(argv);
    return { code, stdout: logs.join('\n'), stderr: errors.join('\n') };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

describe('parseExecuteArgs', () => {
  it('defaults the journey path and output path', () => {
    const args = parseExecuteArgs(['--confirm-authorized']);
    expect(args.journeyPath).toBe('reports/journey.json');
    expect(args.outputPath).toBe('reports/execution.json');
  });

  it('parses journey, data and output', () => {
    const args = parseExecuteArgs([
      '--journey',
      'p.json',
      '--data',
      'd.json',
      '--output',
      'o.json',
      '--confirm-authorized',
    ]);
    expect(args).toMatchObject({ journeyPath: 'p.json', dataPath: 'd.json', outputPath: 'o.json', confirmAuthorized: true });
  });

  it('parses inline values', () => {
    expect(parseExecuteArgs(['--journey=p.json']).journeyPath).toBe('p.json');
  });

  it('parses the timeout', () => {
    expect(parseExecuteArgs(['--timeout', '20000']).timeoutMs).toBe(20000);
  });

  it('rejects a malformed timeout', () => {
    expect(parseExecuteArgs(['--timeout', 'abc']).valid).toBe(false);
    expect(parseExecuteArgs(['--timeout', '10']).valid).toBe(false);
  });

  it('reads the boolean switches', () => {
    const args = parseExecuteArgs(['--continue-on-failure', '--headed', '--confirm-authorized', '--safe-test-mode', '--no-screenshots']);
    expect(args).toMatchObject({
      continueOnFailure: true,
      headed: true,
      confirmAuthorized: true,
      safeTestMode: true,
      screenshots: false,
    });
  });

  it('does not confirm authorization by default', () => {
    expect(parseExecuteArgs([]).confirmAuthorized).toBe(false);
  });

  it('rejects an unknown option', () => {
    const args = parseExecuteArgs(['--bogus']);
    expect(args.valid).toBe(false);
    expect(args.error).toContain('--bogus');
  });

  it('rejects a flag with no value', () => {
    expect(parseExecuteArgs(['--journey']).valid).toBe(false);
    expect(parseExecuteArgs(['--data']).valid).toBe(false);
    expect(parseExecuteArgs(['--output']).valid).toBe(false);
    expect(parseExecuteArgs(['--timeout']).valid).toBe(false);
  });

  it('lists every flag the command understands', () => {
    for (const flag of ['--journey', '--data', '--output', '--timeout', '--confirm-authorized']) {
      expect(EXECUTE_FLAGS, flag).toContain(flag as never);
    }
  });
});

describe('execute CLI: safety gates run before the browser', () => {
  it('refuses without --confirm-authorized and writes no report', async () => {
    const out = join(dir, 'no-auth.json');
    const result = await run(['--journey', validPlanPath, '--output', out]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/--confirm-authorized was not supplied/);
    expect(result.stderr).toMatch(/authorized to test/);
    expect(existsSync(out)).toBe(false);
  });

  it('checks authorization before even reading the plan', async () => {
    // A plan path that does not exist still yields the authorization error,
    // proving the gate is evaluated first.
    const result = await run(['--journey', join(dir, 'missing.json')]);
    expect(result.stderr).toMatch(/--confirm-authorized/);
    expect(result.stderr).not.toMatch(/not found/);
  });

  it('refuses a missing journey plan', async () => {
    const result = await run(['--journey', join(dir, 'missing.json'), '--confirm-authorized']);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/not found/i);
  });

  it('refuses invalid journey JSON', async () => {
    const path = join(dir, 'bad.json');
    await writeFile(path, '{ nope', 'utf8');
    const result = await run(['--journey', path, '--confirm-authorized']);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/not valid JSON/i);
  });

  it('refuses a plan whose step claims executable true', async () => {
    const path = join(dir, 'executable-true.json');
    await writeFile(
      path,
      JSON.stringify({
        ...planWith([step({ id: 'step-001', order: 1 })]),
        steps: [{ ...step({ id: 'step-001', order: 1 }), executable: true }],
      }),
      'utf8',
    );
    const out = join(dir, 'never-written.json');
    const result = await run(['--journey', path, '--output', out, '--confirm-authorized']);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/violates the Build 2 contract/);
    expect(existsSync(out)).toBe(false);
  });

  it('refuses an unsupported schema version', async () => {
    const path = join(dir, 'v2.json');
    await writeFile(path, JSON.stringify({ ...planWith([]), schemaVersion: '2.0' }), 'utf8');
    const result = await run(['--journey', path, '--confirm-authorized']);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Unsupported journey plan schemaVersion/);
  });

  it('refuses a missing test-data file before launching the browser', async () => {
    const out = join(dir, 'never-written-2.json');
    const result = await run([
      '--journey',
      validPlanPath,
      '--data',
      join(dir, 'missing-data.json'),
      '--output',
      out,
      '--confirm-authorized',
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Test data file not found/);
    expect(existsSync(out)).toBe(false);
  });

  it('refuses a malformed test-data file', async () => {
    const dataPath = join(dir, 'bad-data.json');
    await writeFile(dataPath, JSON.stringify({ user: { email: 'a@b.test' } }), 'utf8');
    const result = await run(['--journey', validPlanPath, '--data', dataPath, '--confirm-authorized']);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/string keys to string values/);
  });

  it('returns 2 for an unknown option', async () => {
    expect((await run(['--confirm-authorized', '--bogus'])).code).toBe(2);
  });
});

describe('execute CLI: end to end against a local fixture', () => {
  it('writes a valid execution report', async () => {
    if (!(await chromiumAvailable())) return;

    const { startFixtureServer, stopFixtureServer } = await import('../fixtures/server.js');
    const { validateJourneyPlan } = await import('../../src/executor/planValidator.js');
    const { origin, server } = await startFixtureServer();

    try {
      const path = join(dir, 'real.json');
      await writeFile(
        path,
        JSON.stringify(
          planWith(
            [
              step({ id: 'step-001', order: 1, action: 'identify', locatorCandidates: ["page.getByTestId('simple-button')"] }),
              step({ id: 'step-002', order: 2, action: 'click', locatorCandidates: ["page.getByTestId('simple-button')"] }),
            ],
            { goal: 'cli e2e', target: { url: `${origin}/executor`, finalUrl: null, title: 'x' } },
          ),
        ),
        'utf8',
      );
      // Sanity: the file on disk is a valid plan.
      expect(validateJourneyPlan(JSON.parse(await readFile(path, 'utf8')), path).steps).toHaveLength(2);

      const out = join(dir, 'execution-e2e.json');
      const result = await run([
        '--journey',
        path,
        '--output',
        out,
        '--confirm-authorized',
        '--no-screenshots',
        '--timeout',
        '20000',
      ]);

      expect(result.code).toBe(0);
      expect(existsSync(out)).toBe(true);

      const report = JSON.parse(await readFile(out, 'utf8')) as Record<string, unknown>;
      expect(report['schemaVersion']).toBe('1.0');
      expect(report['journeyPlanSchemaVersion']).toBe('1.0');
      expect(report['status']).toBe('passed');
      expect((report['steps'] as unknown[]).length).toBe(2);
      expect(report['executor']).toMatchObject({ mode: 'deterministic', retries: 0 });
      expect(report['redaction']).toMatchObject({ sensitiveValuesRedacted: true });

      // The terminal summary must state that a failure is not a bug.
      expect(result.stdout).toMatch(/not a confirmed bug/);
    } finally {
      await stopFixtureServer(server);
    }
  }, 60_000);

  it('never mutates the journey plan it consumed', async () => {
    if (!(await chromiumAvailable())) return;

    const { startFixtureServer, stopFixtureServer } = await import('../fixtures/server.js');
    const { origin, server } = await startFixtureServer();
    try {
      const path = join(dir, 'immutable.json');
      const contents = JSON.stringify(
        planWith([step({ id: 'step-001', order: 1, action: 'observe', locatorCandidates: ['#click-result'] })], {
          goal: 'immutability',
          target: { url: `${origin}/executor`, finalUrl: null, title: 'x' },
        }),
      );
      await writeFile(path, contents, 'utf8');

      await run(['--journey', path, '--output', join(dir, 'immutable-out.json'), '--confirm-authorized', '--no-screenshots']);

      // Byte-for-byte unchanged: no execution result was written back.
      expect(await readFile(path, 'utf8')).toBe(contents);
    } finally {
      await stopFixtureServer(server);
    }
  }, 60_000);
});

/** True when a Chromium binary is installed. */
async function chromiumAvailable(): Promise<boolean> {
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

describe('dispatch', () => {
  it('routes the execute subcommand', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(await dispatch(['execute', '--help'])).toBe(0);
      expect(spy.mock.calls.flat().join('\n')).toContain('--confirm-authorized');
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
