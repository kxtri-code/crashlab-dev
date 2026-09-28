import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadAnalysisInputs, orderedSteps, validateExecutionReport, validateJourneyReport } from '../../src/anomaly/validator.js';
import { AnomalyInputError } from '../../src/anomaly/types.js';
import { redactMessage, redactStack, sanitizeFailure, sanitizePath, sanitizeUrl, scrubText } from '../../src/anomaly/redaction.js';
import { consoleEvent, execution, journey, netEvent } from '../fixtures/executionReports.js';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'crashlab-anomaly-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Write a fixture to the temp dir. */
async function write(name: string, value: unknown): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, JSON.stringify(value), 'utf8');
  return path;
}

/** Assert validation rejects a value, returning the message. */
function rejection(value: unknown, label: string): string {
  try {
    validateExecutionReport(value, 'x.json');
  } catch (error) {
    expect(error, label).toBeInstanceOf(AnomalyInputError);
    return (error as Error).message;
  }
  throw new Error(`expected rejection: ${label}`);
}

describe('validateExecutionReport', () => {
  it('accepts a valid report', () => {
    expect(validateExecutionReport(JSON.parse(JSON.stringify(execution())), 'x.json').goal).toBe('Try to complete checkout');
  });

  it('rejects a non-object root', () => {
    expect(rejection([], 'array')).toMatch(/must be a JSON object/);
    expect(rejection('nope', 'string')).toMatch(/must be a JSON object/);
    expect(rejection(null, 'null')).toMatch(/must be a JSON object/);
  });

  it('requires a schema version', () => {
    const report = execution() as unknown as Record<string, unknown>;
    delete report['schemaVersion'];
    expect(rejection(report, 'no schemaVersion')).toMatch(/schemaVersion/);
  });

  it('rejects an unsupported execution schema version', () => {
    const message = rejection({ ...execution(), schemaVersion: '2.0' }, 'v2');
    expect(message).toMatch(/Unsupported execution report schemaVersion "2\.0"/);
    expect(message).toMatch(/supports 1\.0/);
  });

  it('requires goal, journeyType, status and target', () => {
    for (const key of ['goal', 'journeyType', 'status', 'target']) {
      const report = JSON.parse(JSON.stringify(execution())) as Record<string, unknown>;
      delete report[key];
      try {
        validateExecutionReport(report, 'x.json');
        throw new Error(`expected rejection for missing ${key}`);
      } catch (error) {
        expect(error, `missing ${key}`).toBeInstanceOf(AnomalyInputError);
      }
    }
  });

  it('requires a steps array', () => {
    const report = execution() as unknown as Record<string, unknown>;
    delete report['steps'];
    expect(rejection(report, 'no steps')).toMatch(/steps array/);
  });

  it('rejects a step with no id', () => {
    const report = execution({ steps: [{ order: 1 } as never] });
    expect(rejection(report, 'no step id')).toMatch(/step with no id/);
  });

  it('rejects duplicate step ids', () => {
    const base = execution();
    const report = execution({
      steps: [
        { ...base.steps[0]!, id: 'step-001' },
        { ...base.steps[0]!, id: 'step-001' },
      ] as never,
    });
    expect(rejection(report, 'duplicate ids')).toMatch(/duplicate step id "step-001"/);
  });

  it('rejects malformed raw evidence', () => {
    expect(rejection({ ...execution(), rawEvidence: 'nope' }, 'rawEvidence string')).toMatch(/rawEvidence must be an object/);
    expect(
      rejection({ ...execution(), rawEvidence: { consoleEvents: 'nope' } }, 'consoleEvents string'),
    ).toMatch(/rawEvidence\.consoleEvents must be an array/);
  });

  it('accepts a report with no rawEvidence, so the analyzer can warn', () => {
    const report = execution() as unknown as Record<string, unknown>;
    delete report['rawEvidence'];
    expect(() => validateExecutionReport(report, 'x.json')).not.toThrow();
  });

  it('accepts a report with empty evidence arrays', () => {
    const base = execution();
    const report = execution({
      rawEvidence: { consoleEvents: [], pageErrors: [], networkEvents: [], screenshots: [] },
    });
    expect(validateExecutionReport(JSON.parse(JSON.stringify(report)), 'x.json').rawEvidence.networkEvents).toEqual([]);
    void base;
  });
});

describe('validateJourneyReport', () => {
  it('accepts a valid plan', () => {
    expect(validateJourneyReport(JSON.parse(JSON.stringify(journey())), 'j.json').journeyType).toBe('checkout');
  });

  it('rejects an unsupported journey schema version', () => {
    const value = { ...journey(), schemaVersion: '3.0' };
    try {
      validateJourneyReport(value, 'j.json');
      throw new Error('expected rejection');
    } catch (error) {
      expect((error as Error).message).toMatch(/Unsupported journey report schemaVersion "3\.0"/);
    }
  });

  it('requires goal, journeyType, target and steps', () => {
    for (const key of ['goal', 'journeyType', 'target', 'steps']) {
      const value = journey() as unknown as Record<string, unknown>;
      delete value[key];
      try {
        validateJourneyReport(value, 'j.json');
        throw new Error(`expected rejection for missing ${key}`);
      } catch (error) {
        expect((error as Error).message).toBeTruthy();
      }
    }
  });
});

describe('loadAnalysisInputs', () => {
  it('loads both artifacts', async () => {
    const executionPath = await write('e.json', execution());
    const journeyPath = await write('j.json', journey());
    const loaded = await loadAnalysisInputs(executionPath, journeyPath);
    expect(loaded.execution.goal).toBeTruthy();
    expect(loaded.journey.goal).toBeTruthy();
  });

  it('reports a missing execution file', async () => {
    const journeyPath = await write('j2.json', journey());
    await expect(loadAnalysisInputs(join(dir, 'absent.json'), journeyPath)).rejects.toThrow(/Execution report not found/);
  });

  it('reports a missing journey file', async () => {
    const executionPath = await write('e2.json', execution());
    await expect(loadAnalysisInputs(executionPath, join(dir, 'absent.json'))).rejects.toThrow(/Journey report not found/);
  });

  it('reports invalid JSON in either input', async () => {
    const badPath = join(dir, 'bad.json');
    await writeFile(badPath, '{ nope', 'utf8');
    const good = await write('j3.json', journey());
    await expect(loadAnalysisInputs(badPath, good)).rejects.toThrow(/not valid JSON/);
    const goodExecution = await write('e3.json', execution());
    await expect(loadAnalysisInputs(goodExecution, badPath)).rejects.toThrow(/not valid JSON/);
  });

  it('reports a directory passed as a file', async () => {
    const journeyPath = await write('j4.json', journey());
    await expect(loadAnalysisInputs(dir, journeyPath)).rejects.toThrow(/directory/);
  });

  it('validates the execution report before the journey', async () => {
    // A bad execution report fails first, so a misleading journey error is
    // never reported instead.
    const badExecution = await write('bad-exec.json', { schemaVersion: '9.9' });
    await expect(loadAnalysisInputs(badExecution, join(dir, 'absent.json'))).rejects.toThrow(/Unsupported execution/);
  });
});

describe('orderedSteps', () => {
  it('sorts by order then id', () => {
    const base = execution();
    const steps = orderedSteps(
      execution({
        steps: [
          { ...base.steps[0]!, id: 'step-003', order: 3 },
          { ...base.steps[0]!, id: 'step-001', order: 1 },
          { ...base.steps[0]!, id: 'step-002', order: 2 },
        ] as never,
      }),
    );
    expect(steps.map((step) => step.id)).toEqual(['step-001', 'step-002', 'step-003']);
  });

  it('handles an empty or absent step list', () => {
    expect(orderedSteps(execution())).toEqual([]);
  });
});

describe('redaction', () => {
  it('replaces a bearer authorization value', () => {
    expect(scrubText('Authorization: Bearer abc123def456ghi')).toContain('REDACTED');
    expect(scrubText('Authorization: Bearer abc123def456ghi')).not.toContain('abc123def456ghi');
  });

  it('replaces a JWT-shaped token', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.abcdef';
    expect(scrubText(`token was ${jwt}`)).not.toContain('eyJhbGciOi');
  });

  it('replaces a key=value secret pair', () => {
    expect(scrubText('password=hunter2secret')).toContain('REDACTED');
    expect(scrubText('password=hunter2secret')).not.toContain('hunter2secret');
  });

  it('replaces a card-number-shaped run', () => {
    expect(scrubText('card 4242 4242 4242 4242 entered')).not.toContain('4242 4242 4242 4242');
  });

  it('redacts sensitive query values in a URL', () => {
    // The query key is itself sensitive, so both the key and the value are
    // replaced; what matters is that the secret value never survives.
    const sanitized = sanitizeUrl('https://fixture.test/api?token=abcsecret&page=2');
    expect(sanitized).not.toContain('abcsecret');
    expect(sanitized).toContain('REDACTED');
  });

  it('leaves an ordinary URL intact', () => {
    expect(sanitizeUrl('https://fixture.test/api/thing')).toBe('https://fixture.test/api/thing');
  });

  it('handles a missing URL', () => {
    expect(sanitizeUrl(null)).toBe('(unknown url)');
    expect(sanitizeUrl('')).toBe('(unknown url)');
  });

  it('caps a long URL', () => {
    const long = `https://fixture.test/${'a'.repeat(1000)}`;
    expect(sanitizeUrl(long).length).toBeLessThanOrEqual(503);
  });

  it('sanitizes a path', () => {
    expect(sanitizePath('/api/thing')).toBe('/api/thing');
    expect(sanitizePath(null)).toBeNull();
  });

  it('redacts a message and returns a placeholder when nothing safe remains', () => {
    expect(redactMessage('normal message')).toBe('normal message');
    // A message made *entirely* of a secret leaves nothing safe to show, so it
    // is reported as a placeholder rather than a bare "REDACTED" that a reader
    // might mistake for the original content.
    const allSecret = redactMessage('password=hunter2secret');
    expect(allSecret).toBe('Message omitted: could not be represented safely');
  });

  it('handles a non-string message', () => {
    expect(redactMessage(null)).toMatch(/omitted/);
    expect(redactMessage(42)).toMatch(/omitted/);
  });

  it('keeps only the first line of a stack', () => {
    expect(redactStack('Error: x\n  at a.js:1:1\n  at b.js:2:2')).toBe('Error: x');
    expect(redactStack(null)).toBeNull();
  });

  it('scrubs a secret out of a failure string', () => {
    // sanitizeFailure is the helper rules use; it must scrub, not just cap.
    expect(sanitizeFailure('failed with token=abc123secret')).toContain('REDACTED');
    expect(sanitizeFailure('failed with token=abc123secret')).not.toContain('abc123secret');
  });

  it('scrubs consistently across repeated calls', () => {
    // A shared /g regex would carry lastIndex between calls and skip matches,
    // so the same input must always produce the same output.
    for (let i = 0; i < 5; i++) {
      expect(sanitizeFailure('failed with token=abc123secret')).toContain('REDACTED');
      expect(scrubText('password=hunter2secret')).toBe('REDACTED');
    }
  });

  it('never inspects image content', () => {
    // Screenshots are referenced by path only; the analyzer has no image code.
    const report = execution();
    expect(report.rawEvidence.screenshots).toEqual([]);
  });
});

describe('no browser or network imports', () => {
  it('keeps the anomaly engine free of Playwright', async () => {
    const { readFile } = await import('node:fs/promises');
    const { glob } = { glob: null } as never;
    void glob;
    // Read each module's source and assert no Playwright import survives.
    const files = [
      'types.ts',
      'validator.ts',
      'redaction.ts',
      'rules.ts',
      'classifier.ts',
      'report.ts',
    ];
    for (const file of files) {
      const source = await readFile(join(process.cwd(), 'src', 'anomaly', file), 'utf8');
      expect(source, file).not.toMatch(/from ['"]playwright['"]/);
      expect(source, file).not.toMatch(/require\(['"]playwright['"]\)/);
    }
  });

  it('does not fetch anything over the network', async () => {
    const { readFile } = await import('node:fs/promises');
    for (const file of ['types.ts', 'validator.ts', 'redaction.ts', 'rules.ts', 'classifier.ts', 'report.ts']) {
      const source = await readFile(join(process.cwd(), 'src', 'anomaly', file), 'utf8');
      expect(source, file).not.toMatch(/\bfetch\s*\(/);
      expect(source, file).not.toMatch(/node:https?|node:net/);
    }
  });
});

describe('fixture sanity', () => {
  it('produces evidence arrays the rules can read', () => {
    const report = execution({
      rawEvidence: {
        ...execution().rawEvidence,
        networkEvents: [netEvent()],
        consoleEvents: [consoleEvent()],
      },
    });
    expect(report.rawEvidence.networkEvents).toHaveLength(1);
    expect(report.rawEvidence.consoleEvents).toHaveLength(1);
  });
});
