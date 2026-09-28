import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_OUTPUT_PATH, resolveOutputPath, writeReport } from '../../src/report/write.js';
import { buildReport } from '../../src/report/build.js';
import type { BuildReportInput } from '../../src/report/build.js';

const input: BuildReportInput = {
  inputUrl: 'https://x.test/',
  finalUrl: 'https://x.test/',
  title: 'Fixture',
  redirected: false,
  secureContext: true,
  userAgent: 'test-agent',
  viewport: { width: 1280, height: 800 },
  durationMs: 10,
  navigationTimings: { domContentLoadedMs: null, loadMs: null, timeSinceNavigationMs: null },
  config: { headless: true, timeoutMs: 30000, settleMs: 1000, slowMoMs: 0, ignoreHttpsErrors: false, domScope: [] },
  detectedPageType: 'unknown',
  pageTypeConfidence: 0,
  pageTypeReason: 'none',
  pageTypeCandidates: [],
  visibleTextSample: '',
  visibleTextLength: 0,
  readyState: 'complete',
  htmlLang: null,
  canonicalUrl: null,
  metaDescription: null,
  elements: [],
  forms: [],
  network: [],
  console: [],
  errors: [],
  scoutErrors: [],
  warnings: [],
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('resolveOutputPath', () => {
  it('resolves against the working directory', () => {
    expect(resolveOutputPath('reports/scout.json', 'work')).toBe(join(resolve('work'), 'reports', 'scout.json'));
  });

  it('keeps the default path under the working directory', () => {
    expect(resolveOutputPath(undefined, 'work')).toBe(join(resolve('work'), 'reports', 'scout.json'));
  });

  it('is absolute', () => {
    expect(isAbsolute(resolveOutputPath(DEFAULT_OUTPUT_PATH, 'work'))).toBe(true);
  });
});

describe('writeReport', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'crashlab-write-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates missing directories and writes parseable JSON', async () => {
    const target = join(dir, 'nested', 'deeper', 'scout.json');
    const written = await writeReport(buildReport(input), target);
    expect(written).toBe(target);

    const parsed = JSON.parse(await readFile(target, 'utf8')) as { meta: { tool: string } };
    expect(parsed.meta.tool).toBe('CrashLab Scout');
  });

  it('overwrites an existing report', async () => {
    const target = join(dir, 'scout.json');
    await writeReport(buildReport(input), target);
    await writeReport(buildReport({ ...input, title: 'Second run' }), target);
    const parsed = JSON.parse(await readFile(target, 'utf8')) as { target: { title: string } };
    expect(parsed.target.title).toBe('Second run');
  });
});
