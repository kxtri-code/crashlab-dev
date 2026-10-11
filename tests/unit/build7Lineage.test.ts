import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildBaseline,
  readBaseline,
  writeBaseline,
} from '../../src/baseline/writer.js';
import { validateBaselineId, validateParentBaseline } from '../../src/baseline/validator.js';
import {
  findLatestCompatibleBaseline,
  listBaselines,
  resolveBaselinePath,
} from '../../src/baseline/registry.js';
import { BaselineError, MAX_LINEAGE_DEPTH } from '../../src/baseline/types.js';
import type { Baseline, BaselineIdentity } from '../../src/baseline/types.js';
import { buildCandidateReport, summarizeCandidateReport } from '../../src/review/candidateReport.js';
import type { ReviewInput } from '../../src/review/candidateReport.js';
import { parseBaselineArgs, runBaselineCommand } from '../../src/cli/baselineCommand.js';
import { parseReviewArgs, runReviewCommand } from '../../src/cli/reviewCommand.js';
import { writeReport } from '../../src/report/write.js';
import {
  abortedExecution,
  anomalyReportWith,
  baselineOf,
  checkoutJourney,
  cleanExecution,
  http404,
  http500,
  identityOf,
  reproductionWith,
  toSignals,
} from '../fixtures/build6Fixtures.js';

let testDir: string;

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'crashlab-build7-'));
});

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true });
});

function makeIdentity(overrides: Partial<BaselineIdentity> = {}): BaselineIdentity {
  const base = identityOf(cleanExecution(), checkoutJourney());
  return { ...base, ...overrides };
}

function createReviewInput(overrides: Partial<ReviewInput> = {}): ReviewInput {
  const plan = checkoutJourney();
  const exec = cleanExecution();
  return {
    baseline: null,
    execution: exec,
    anomalies: anomalyReportWith([http500()]),
    reproduction: reproductionWith([{ anomalyId: 'anomaly-001', ruleId: 'HTTP_5XX' }]),
    journey: plan,
    paths: {
      execution: 'reports/execution.json',
      anomalies: 'reports/anomalies.json',
      reproduction: 'reports/reproduction.json',
      journey: 'reports/journey.json',
      baseline: null,
    },
    ...overrides,
  };
}

describe('Build 7: Baseline IDs and path resolution', () => {
  it('validates safe baseline IDs and rejects unsafe ones', () => {
    expect(() => validateBaselineId('safe-baseline-v1')).not.toThrow();
    expect(() => validateBaselineId('checkout_2026_01')).not.toThrow();

    expect(() => validateBaselineId('')).toThrow(BaselineError);
    expect(() => validateBaselineId('   ')).toThrow(BaselineError);
    expect(() => validateBaselineId('bad/id')).toThrow(BaselineError);
    expect(() => validateBaselineId('bad\\id')).toThrow(BaselineError);
    expect(() => validateBaselineId('../traversal')).toThrow(BaselineError);
    expect(() => validateBaselineId('has space')).toThrow(BaselineError);
    expect(() => validateBaselineId('control\x00char')).toThrow(BaselineError);
  });

  it('resolves baseline path safely and rejects unsafe references', () => {
    const resolved = resolveBaselinePath('good-v1', 'reports/baselines');
    expect(resolved).toContain('reports');
    expect(resolved).toContain('good-v1.json');

    const explicitPath = resolveBaselinePath('reports/baselines/explicit.json', 'reports/baselines');
    expect(explicitPath).toContain('explicit.json');

    expect(() => resolveBaselinePath('../traversal', 'reports/baselines')).toThrow(BaselineError);
    expect(() => resolveBaselinePath('bad/id', 'reports/baselines')).toThrow(BaselineError);
    expect(() => resolveBaselinePath('', 'reports/baselines')).toThrow(BaselineError);
  });
});

describe('Build 7: Baseline lineage and parent validation', () => {
  it('validates a baseline candidate without a parent (root baseline)', () => {
    const parentValidation = validateParentBaseline('root-v1', makeIdentity(), null);
    expect(parentValidation.valid).toBe(true);
    expect(parentValidation.blockers).toHaveLength(0);
    expect(parentValidation.lineage.parentBaselineId).toBeNull();
    expect(parentValidation.lineage.rootBaselineId).toBe('root-v1');
    expect(parentValidation.lineage.depth).toBe(0);
    expect(parentValidation.lineage.ancestors).toEqual([]);
    expect(parentValidation.lineage.truncated).toBe(false);
  });

  it('validates a baseline candidate with a valid compatible parent', () => {
    const parent = baselineOf({ baselineId: 'root-v1', identity: makeIdentity() });
    const parentValidation = validateParentBaseline('child-v2', makeIdentity(), parent);
    expect(parentValidation.valid).toBe(true);
    expect(parentValidation.lineage.parentBaselineId).toBe('root-v1');
    expect(parentValidation.lineage.rootBaselineId).toBe('root-v1');
    expect(parentValidation.lineage.depth).toBe(1);
    expect(parentValidation.lineage.ancestors).toEqual(['root-v1']);
    expect(parentValidation.lineage.truncated).toBe(false);
  });

  it('rejects self-parentage', () => {
    const parent = baselineOf({ baselineId: 'same-id', identity: makeIdentity() });
    const parentValidation = validateParentBaseline('same-id', makeIdentity(), parent);
    expect(parentValidation.valid).toBe(false);
    expect(parentValidation.blockers.some((b) => b.includes('cannot be its own parent'))).toBe(true);
  });

  it('rejects cycles in lineage', () => {
    const parent = baselineOf({
      baselineId: 'parent-v2',
      identity: makeIdentity(),
      lineage: {
        parentBaselineId: 'child-v3',
        rootBaselineId: 'child-v3',
        depth: 1,
        ancestors: ['child-v3'],
        truncated: false,
      },
    });
    const parentValidation = validateParentBaseline('child-v3', makeIdentity(), parent);
    expect(parentValidation.valid).toBe(false);
    expect(parentValidation.blockers.some((b) => b.includes('Cycle detected'))).toBe(true);
  });

  it('rejects parent with mismatched target origin', () => {
    const parent = baselineOf({
      baselineId: 'other-origin',
      identity: makeIdentity({ targetOrigin: 'https://other.example.test' }),
    });
    const parentValidation = validateParentBaseline('child-v2', makeIdentity({ targetOrigin: 'https://shop.example.test' }), parent);
    expect(parentValidation.valid).toBe(false);
    expect(parentValidation.blockers.some((b) => b.includes('target origin'))).toBe(true);
  });

  it('rejects parent with mismatched journey hash', () => {
    const parent = baselineOf({
      baselineId: 'other-journey',
      identity: makeIdentity({ journeyHash: 'hash-aaa' }),
    });
    const parentValidation = validateParentBaseline('child-v2', makeIdentity({ journeyHash: 'hash-bbb' }), parent);
    expect(parentValidation.valid).toBe(false);
    expect(parentValidation.blockers.some((b) => b.includes('journey hash mismatch'))).toBe(true);
  });

  it('rejects parent with mismatched application build ID', () => {
    const parent = baselineOf({
      baselineId: 'other-build',
      identity: makeIdentity({ applicationBuildId: 'build-100' }),
    });
    const parentValidation = validateParentBaseline('child-v2', makeIdentity({ applicationBuildId: 'build-200' }), parent);
    expect(parentValidation.valid).toBe(false);
    expect(parentValidation.blockers.some((b) => b.includes('application build'))).toBe(true);
  });

  it('truncates lineage when max depth is exceeded', () => {
    const deepAncestors = Array.from({ length: MAX_LINEAGE_DEPTH }, (_, i) => `ancestor-${i}`);
    const deepParent = baselineOf({
      baselineId: 'deep-parent',
      identity: makeIdentity(),
      lineage: {
        parentBaselineId: deepAncestors[MAX_LINEAGE_DEPTH - 1] ?? null,
        rootBaselineId: 'ancestor-0',
        depth: MAX_LINEAGE_DEPTH,
        ancestors: deepAncestors,
        truncated: false,
      },
    });
    const parentValidation = validateParentBaseline('deep-child', makeIdentity(), deepParent);
    expect(parentValidation.valid).toBe(true);
    expect(parentValidation.lineage.truncated).toBe(true);
    expect(parentValidation.lineage.depth).toBe(MAX_LINEAGE_DEPTH);
  });
});

describe('Build 7: Baseline construction and immutability', () => {
  it('builds a baseline with parent lineage metadata', () => {
    const parent = baselineOf({ baselineId: 'root-v1', identity: makeIdentity() });
    const baseline = buildBaseline({
      baselineId: 'v2-release',
      name: 'Release V2',
      execution: cleanExecution(),
      anomalies: anomalyReportWith([]),
      journey: checkoutJourney(),
      acceptedSignalIds: [],
      confirmedBy: 'tester',
      paths: { execution: 'exec.json', anomalies: 'anom.json', journey: 'jour.json' },
      parentBaseline: parent,
    });

    expect(baseline.parentBaselineId).toBe('root-v1');
    expect(baseline.lineage.parentBaselineId).toBe('root-v1');
    expect(baseline.lineage.rootBaselineId).toBe('root-v1');
    expect(baseline.lineage.depth).toBe(1);
    expect(baseline.lineage.ancestors).toEqual(['root-v1']);
  });

  it('writes and reads a baseline file preserving lineage', async () => {
    const baselineDir = join(testDir, 'baselines-store');
    const b1 = buildBaseline({
      baselineId: 'store-v1',
      name: 'Store V1',
      execution: cleanExecution(),
      anomalies: anomalyReportWith([]),
      journey: checkoutJourney(),
      acceptedSignalIds: [],
      confirmedBy: 'tester',
      paths: { execution: 'exec.json', anomalies: 'anom.json', journey: 'jour.json' },
      baselineDir,
    });

    const writtenPath = await writeBaseline(b1, baselineDir);
    expect(existsSync(writtenPath)).toBe(true);

    const loaded = await readBaseline(writtenPath);
    expect(loaded.baselineId).toBe('store-v1');
    expect(loaded.parentBaselineId).toBeNull();
    expect(loaded.lineage.depth).toBe(0);

    const b2 = buildBaseline({
      baselineId: 'store-v2',
      name: 'Store V2',
      execution: cleanExecution(),
      anomalies: anomalyReportWith([]),
      journey: checkoutJourney(),
      acceptedSignalIds: [],
      confirmedBy: 'tester',
      paths: { execution: 'exec.json', anomalies: 'anom.json', journey: 'jour.json' },
      parentBaseline: loaded,
      baselineDir,
    });

    const writtenPath2 = await writeBaseline(b2, baselineDir);
    const loaded2 = await readBaseline(writtenPath2);
    expect(loaded2.baselineId).toBe('store-v2');
    expect(loaded2.parentBaselineId).toBe('store-v1');
    expect(loaded2.lineage.ancestors).toEqual(['store-v1']);
    expect(loaded2.lineage.depth).toBe(1);

    // Duplicate ID must be rejected without mutating existing file
    const contentBefore = await readFile(writtenPath, 'utf8');
    await expect(writeBaseline(b1, baselineDir)).rejects.toThrow(BaselineError);
    const contentAfter = await readFile(writtenPath, 'utf8');
    expect(contentAfter).toBe(contentBefore);
  });
});

describe('Build 7: Registry listing, filtering, and deterministic sorting', () => {
  it('lists and filters baselines deterministically', async () => {
    const baselineDir = join(testDir, 'filter-baselines');
    const baseIdent = makeIdentity({ targetOrigin: 'https://shop.example.test', applicationBuildId: 'build-1' });

    const b1 = baselineOf({ baselineId: 'base-01', identity: baseIdent });
    const b2 = baselineOf({
      baselineId: 'base-02',
      identity: makeIdentity({ targetOrigin: 'https://other.example.test', applicationBuildId: 'build-2' }),
    });

    await writeBaseline(b1, baselineDir);
    await writeBaseline(b2, baselineDir);

    const all = await listBaselines({ baselineDir });
    expect(all.length).toBe(2);

    const filteredOrigin = await listBaselines({
      baselineDir,
      filters: { targetOrigin: 'https://shop.example.test' },
    });
    expect(filteredOrigin.length).toBe(1);
    expect(filteredOrigin[0]!.baselineId).toBe('base-01');

    const filteredBuild = await listBaselines({
      baselineDir,
      filters: { applicationBuildId: 'build-2' },
    });
    expect(filteredBuild.length).toBe(1);
    expect(filteredBuild[0]!.baselineId).toBe('base-02');
  });
});

describe('Build 7: Review selection mode and latest-compatible resolution', () => {
  it('parses review arguments and enforces mutual exclusivity', () => {
    const parsedValid = parseReviewArgs(['--baseline', 'good-v1']);
    expect(parsedValid.valid).toBe(true);
    expect(parsedValid.baselinePath).toBe('good-v1');
    expect(parsedValid.latestCompatible).toBe(false);

    const parsedLatest = parseReviewArgs(['--latest-compatible']);
    expect(parsedLatest.valid).toBe(true);
    expect(parsedLatest.latestCompatible).toBe(true);
    expect(parsedLatest.baselinePath).toBeNull();

    const parsedConflicting = parseReviewArgs(['--baseline', 'good-v1', '--latest-compatible']);
    expect(parsedConflicting.valid).toBe(false);
    expect(parsedConflicting.error).toContain('mutually exclusive');
  });

  it('finds the newest compatible baseline among candidates', async () => {
    const baselineDir = join(testDir, 'selection-baselines');
    const ident = makeIdentity();

    const b1 = baselineOf({ baselineId: 'shop-v1', identity: ident });
    const b2 = baselineOf({
      baselineId: 'shop-v2',
      identity: ident,
      parentBaselineId: 'shop-v1',
      lineage: { parentBaselineId: 'shop-v1', rootBaselineId: 'shop-v1', depth: 1, ancestors: ['shop-v1'], truncated: false },
    });
    const bIncompatible = baselineOf({
      baselineId: 'shop-other',
      identity: makeIdentity({ targetOrigin: 'https://incompatible.example.test' }),
    });

    await writeBaseline(b1, baselineDir);
    await writeBaseline(b2, baselineDir);
    await writeBaseline(bIncompatible, baselineDir);

    const result = await findLatestCompatibleBaseline(ident, baselineDir);
    expect(result.selectedBaseline).not.toBeNull();
    expect(result.selectedBaseline?.baselineId).toBe('shop-v2');
    expect(result.candidateDecisions.length).toBe(3);
    const incompDecision = result.candidateDecisions.find((c) => c.baselineId === 'shop-other');
    expect(incompDecision?.compatible).toBe(false);
  });

  it('returns null and candidate decisions if no compatible baseline exists', async () => {
    const baselineDir = join(testDir, 'none-compatible');
    const ident = makeIdentity({ targetOrigin: 'https://brand-new.example.test' });

    const b1 = baselineOf({ baselineId: 'shop-v1', identity: makeIdentity() });
    await writeBaseline(b1, baselineDir);

    const result = await findLatestCompatibleBaseline(ident, baselineDir);
    expect(result.selectedBaseline).toBeNull();
    expect(result.candidateDecisions.length).toBe(1);
    expect(result.candidateDecisions[0]!.compatible).toBe(false);
  });
});

describe('Build 7: Historical classifications and reintroduced signals', () => {
  it('classifies a signal as reintroduced when present in ancestor, resolved in parent, and reappearing now', () => {
    const sig500 = toSignals([http500()])[0]!;

    // Ancestor v1 had the 500 error
    const ancestorV1 = baselineOf({
      baselineId: 'ancestor-v1',
      identity: makeIdentity(),
      signals: [sig500],
    });

    // Parent v2 was clean: error was resolved
    const parentV2 = baselineOf({
      baselineId: 'parent-v2',
      identity: makeIdentity(),
      signals: [], // absent
      parentBaselineId: 'ancestor-v1',
      lineage: {
        parentBaselineId: 'ancestor-v1',
        rootBaselineId: 'ancestor-v1',
        depth: 1,
        ancestors: ['ancestor-v1'],
        truncated: false,
      },
    });

    // Current run reproduces the 500 error again
    const input = createReviewInput({
      baseline: parentV2,
      ancestorBaselines: [ancestorV1],
      selectionMode: 'latest-compatible',
    });

    const report = buildCandidateReport(input);
    expect(report.summary.reintroduced).toBe(1);
    expect(report.summary.novel).toBe(0);
    expect(report.candidates[0]!.classification).toBe('reintroduced');
    expect(report.candidates[0]!.message).toContain('reappeared');
    expect(report.candidates[0]!.confirmed).toBe(false);
    expect(report.interpretation.confirmedBug).toBe(false);
  });

  it('classifies as novel if absent from baseline and all ancestors', () => {
    const ancestorV1 = baselineOf({ baselineId: 'ancestor-v1', identity: makeIdentity(), signals: [] });
    const parentV2 = baselineOf({
      baselineId: 'parent-v2',
      identity: makeIdentity(),
      signals: [],
      parentBaselineId: 'ancestor-v1',
    });

    const input = createReviewInput({
      baseline: parentV2,
      ancestorBaselines: [ancestorV1],
      selectionMode: 'explicit',
    });

    const report = buildCandidateReport(input);
    expect(report.summary.novel).toBe(1);
    expect(report.summary.reintroduced).toBe(0);
    expect(report.candidates[0]!.classification).toBe('novel');
    expect(report.candidates[0]!.confirmed).toBe(false);
    expect(report.interpretation.confirmedBug).toBe(false);
  });

  it('classifies as persistent if present in selected baseline', () => {
    const sig500 = toSignals([http500()])[0]!;
    const baseline = baselineOf({
      baselineId: 'parent-v1',
      identity: makeIdentity(),
      signals: [sig500],
    });

    const input = createReviewInput({
      baseline,
      selectionMode: 'explicit',
    });

    const report = buildCandidateReport(input);
    expect(report.summary.persistent).toBe(1);
    expect(report.candidates[0]!.classification).toBe('persistent');
    expect(report.candidates[0]!.confirmed).toBe(false);
    expect(report.interpretation.confirmedBug).toBe(false);
  });

  it('classifies as changed when matching same rule and step with differing safe details', () => {
    const anomaly502 = {
      ...http500('anomaly-001'),
      details: {
        method: 'POST',
        statusCode: 502,
        resourceType: 'fetch',
        url: 'https://shop.example.test/api/orders',
      },
    };
    const sig502 = toSignals([anomaly502])[0]!;
    const baseline = baselineOf({
      baselineId: 'parent-v1',
      identity: makeIdentity(),
      signals: [sig502],
    });

    // Current run has status 500 on the same endpoint
    const input = createReviewInput({
      baseline,
      anomalies: anomalyReportWith([http500('anomaly-001')]),
      reproduction: reproductionWith([{ anomalyId: 'anomaly-001', ruleId: 'HTTP_5XX' }]),
      selectionMode: 'explicit',
    });

    const report = buildCandidateReport(input);
    expect(report.summary.changed).toBe(1);
    const changedCand = report.candidates.find((c) => c.classification === 'changed');
    expect(changedCand).toBeDefined();
    expect(changedCand!.classification).toBe('changed');
    expect(changedCand!.confirmed).toBe(false);
  });

  it('classifies as resolved when signal in baseline is absent from a clean reproduced run', () => {
    const sig404 = toSignals([http404()])[0]!;
    const baseline = baselineOf({
      baselineId: 'parent-v1',
      identity: makeIdentity(),
      signals: [sig404],
    });

    const input = createReviewInput({
      baseline,
      anomalies: anomalyReportWith([]),
      reproduction: reproductionWith([]),
      selectionMode: 'explicit',
    });

    const report = buildCandidateReport(input);
    expect(report.summary.resolved).toBe(1);
    const resolvedCand = report.candidates.find((c) => c.classification === 'resolved');
    expect(resolvedCand).toBeDefined();
    expect(resolvedCand?.classification).toBe('resolved');
  });

  it('classifies missing baseline signals as unknown rather than resolved if current run was aborted', () => {
    const sig404 = toSignals([http404()])[0]!;
    const baseline = baselineOf({
      baselineId: 'parent-v1',
      identity: makeIdentity(),
      signals: [sig404],
    });

    const input = createReviewInput({
      baseline,
      execution: abortedExecution(),
      anomalies: anomalyReportWith([]),
      reproduction: reproductionWith([]),
      selectionMode: 'explicit',
    });

    const report = buildCandidateReport(input);
    expect(report.summary.resolved).toBe(0);
    expect(report.summary.unknown).toBe(1);
    const cand = report.candidates[0]!;
    expect(cand.classification).toBe('unknown');
    expect(cand.message).toContain('aborted');
  });

  it('classifies missing baseline signals as unknown if reproduction is inconclusive or blocked', () => {
    const sig404 = toSignals([http404()])[0]!;
    const baseline = baselineOf({
      baselineId: 'parent-v1',
      identity: makeIdentity(),
      signals: [sig404],
    });

    const input = createReviewInput({
      baseline,
      anomalies: anomalyReportWith([]),
      reproduction: null,
      selectionMode: 'explicit',
    });

    const report = buildCandidateReport(input);
    expect(report.summary.resolved).toBe(0);
    expect(report.summary.unknown).toBe(1);
    expect(report.candidates[0]!.classification).toBe('unknown');
  });
});

describe('Build 7: Verification limitations and report determinism', () => {
  it('exposes limitations for partial baselines and operator-declared ancestors', () => {
    const ancestor = baselineOf({
      baselineId: 'ancestor-declared',
      identity: makeIdentity(),
    });
    ancestor.status = 'known-good-declared';

    const baseline = baselineOf({
      baselineId: 'child-partial',
      identity: makeIdentity(),
      parentBaselineId: 'ancestor-declared',
    });
    baseline.status = 'known-good-partial';
    baseline.verification.complete = false;
    baseline.verification.unverifiedAssertions = 1;
    baseline.verification.coverage = 'executed-steps-only';

    const input = createReviewInput({
      baseline,
      ancestorBaselines: [ancestor],
      selectionMode: 'explicit',
    });

    const report = buildCandidateReport(input);
    expect(report.comparisonLimitations.some((l) => l.includes('partially verified'))).toBe(true);
    expect(report.comparisonLimitations.some((l) => l.includes('operator-declared'))).toBe(true);
  });

  it('preserves determinism across repeated review report generation', () => {
    const baseline = baselineOf({ baselineId: 'stable-v1', identity: makeIdentity() });
    const input = createReviewInput({ baseline, selectionMode: 'explicit' });

    const report1 = buildCandidateReport(input);
    const report2 = buildCandidateReport(input);
    expect(JSON.stringify(report1)).toBe(JSON.stringify(report2));
  });

  it('never mutates input reports or baseline during review', () => {
    const baseline = baselineOf({ baselineId: 'immutable-v1', identity: makeIdentity() });
    const input = createReviewInput({ baseline, selectionMode: 'explicit' });

    const baselineSnapshot = JSON.stringify(baseline);
    const journeySnapshot = JSON.stringify(input.journey);
    const executionSnapshot = JSON.stringify(input.execution);
    const anomaliesSnapshot = JSON.stringify(input.anomalies);
    const reproductionSnapshot = JSON.stringify(input.reproduction);

    buildCandidateReport(input);

    expect(JSON.stringify(baseline)).toBe(baselineSnapshot);
    expect(JSON.stringify(input.journey)).toBe(journeySnapshot);
    expect(JSON.stringify(input.execution)).toBe(executionSnapshot);
    expect(JSON.stringify(input.anomalies)).toBe(anomaliesSnapshot);
    expect(JSON.stringify(input.reproduction)).toBe(reproductionSnapshot);
  });
});

describe('Build 7: Review report provenance and lineage exposure', () => {
  it('records selectionMode, lineage, decisions, and history in CandidateReport', () => {
    const ancestor = baselineOf({ baselineId: 'ancestor-v1', identity: makeIdentity() });
    const baseline = baselineOf({
      baselineId: 'child-v2',
      identity: makeIdentity(),
      parentBaselineId: 'ancestor-v1',
      lineage: {
        parentBaselineId: 'ancestor-v1',
        rootBaselineId: 'ancestor-v1',
        depth: 1,
        ancestors: ['ancestor-v1'],
        truncated: false,
      },
    });

    const input = createReviewInput({
      baseline,
      ancestorBaselines: [ancestor],
      selectionMode: 'latest-compatible',
      candidatesConsidered: [
        {
          baselineId: 'child-v2',
          report: 'reports/baselines/child-v2.json',
          compatible: true,
          reason: null,
          createdAt: baseline.createdAt,
        },
      ],
    });

    const report = buildCandidateReport(input);
    expect(report.selectionMode).toBe('latest-compatible');
    expect(report.selectedBaselineId).toBe('child-v2');
    expect(report.parentBaselineId).toBe('ancestor-v1');
    expect(report.lineage?.ancestors).toEqual(['ancestor-v1']);
    expect(report.candidatesConsidered).toHaveLength(1);
    expect(report.history).toBeDefined();
    expect(report.history!.length).toBeGreaterThanOrEqual(1);
    expect(report.history![0]!.baselineId).toBe('child-v2');

    const summaryText = summarizeCandidateReport(report);
    expect(summaryText).toContain('Selection Mode:');
    expect(summaryText).toContain('latest-compatible');
    expect(summaryText).toContain('Parent Baseline:');
    expect(summaryText).toContain('ancestor-v1');
    expect(summaryText).toContain('Lineage Depth:');
  });
});

describe('Build 7: CLI integration for baseline and review', () => {
  it('parses baseline flags including --parent-baseline and --list', () => {
    const listArgs = parseBaselineArgs(['--list', '--filter-origin', 'https://example.test']);
    expect(listArgs.valid).toBe(true);
    expect(listArgs.list).toBe(true);
    expect(listArgs.filterOrigin).toBe('https://example.test');

    const parentArgs = parseBaselineArgs([
      '--baseline-id',
      'child-v2',
      '--parent-baseline',
      'parent-v1',
      '--confirm-known-good',
    ]);
    expect(parentArgs.valid).toBe(true);
    expect(parentArgs.baselineId).toBe('child-v2');
    expect(parentArgs.parentBaseline).toBe('parent-v1');
  });

  it('runs baseline command in --list mode successfully', async () => {
    const code = await runBaselineCommand(['--list', '--baseline-dir', join(testDir, 'empty-dir')]);
    expect(code).toBe(0);
  });

  it('executes end-to-end baseline creation with parent and review with --latest-compatible', async () => {
    const runDir = join(testDir, 'e2e-run');
    const baselineDir = join(runDir, 'baselines');
    const execPath = join(runDir, 'execution.json');
    const anomPath = join(runDir, 'anomalies.json');
    const jourPath = join(runDir, 'journey.json');
    const reproPath = join(runDir, 'reproduction.json');
    const candidatePath = join(runDir, 'candidates.json');

    const exec = cleanExecution();
    const plan = checkoutJourney();
    const anoms = anomalyReportWith([]);
    const repro = reproductionWith([]);

    await writeReport(exec, execPath);
    await writeReport(plan, jourPath);
    await writeReport(anoms, anomPath);
    await writeReport(repro, reproPath);

    // 1. Create root baseline
    const exit1 = await runBaselineCommand([
      '--execution', execPath,
      '--anomalies', anomPath,
      '--journey', jourPath,
      '--baseline-id', 'cli-root-v1',
      '--name', 'CLI Root V1',
      '--baseline-dir', baselineDir,
      '--confirm-known-good',
    ]);
    expect(exit1).toBe(0);

    // 2. Create child baseline with --parent-baseline
    const exit2 = await runBaselineCommand([
      '--execution', execPath,
      '--anomalies', anomPath,
      '--journey', jourPath,
      '--baseline-id', 'cli-child-v2',
      '--name', 'CLI Child V2',
      '--parent-baseline', 'cli-root-v1',
      '--baseline-dir', baselineDir,
      '--confirm-known-good',
    ]);
    expect(exit2).toBe(0);

    const childBaseline = await readBaseline(resolveBaselinePath('cli-child-v2', baselineDir));
    expect(childBaseline.parentBaselineId).toBe('cli-root-v1');
    expect(childBaseline.lineage.ancestors).toEqual(['cli-root-v1']);

    // 3. Review with --latest-compatible
    const exit3 = await runReviewCommand([
      '--execution', execPath,
      '--anomalies', anomPath,
      '--journey', jourPath,
      '--reproduction', reproPath,
      '--baseline-dir', baselineDir,
      '--latest-compatible',
      '--output', candidatePath,
    ]);
    expect(exit3).toBe(0);
    expect(existsSync(candidatePath)).toBe(true);

    const reportContent = JSON.parse(await readFile(candidatePath, 'utf8'));
    expect(reportContent.selectionMode).toBe('latest-compatible');
    expect(reportContent.selectedBaselineId).toBe('cli-child-v2');
    expect(reportContent.parentBaselineId).toBe('cli-root-v1');
    expect(reportContent.interpretation.confirmedBug).toBe(false);

    // 4. Review with --latest-compatible when no baselines compatible (empty dir)
    const emptyBaselineDir = join(runDir, 'empty-baselines');
    const exit4 = await runReviewCommand([
      '--execution', execPath,
      '--anomalies', anomPath,
      '--journey', jourPath,
      '--reproduction', reproPath,
      '--baseline-dir', emptyBaselineDir,
      '--latest-compatible',
    ]);
    expect(exit4).toBe(1);
  });
});
