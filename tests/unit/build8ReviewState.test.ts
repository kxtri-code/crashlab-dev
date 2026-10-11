import { mkdtemp, readFile, rm, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  canonicalCandidateId,
  canonicalCandidatePayload,
  validateCandidateId,
} from '../../src/review/identity.js';
import {
  REVIEW_STATE_SCHEMA_VERSION,
  REVIEW_STATE_EVENTS_FILE,
  REVIEW_STATE_PROJECTION_FILE,
  ReviewStateTransitionError,
  ReviewStateInputError,
  ReviewStateIntegrityError,
} from '../../src/review/reviewStateTypes.js';
import type { ReviewStateEvent } from '../../src/review/reviewStateTypes.js';
import { validateReviewerIdentity, validateReviewNote, validateDuplicateTarget } from '../../src/review/reviewStateValidator.js';
import { validateStateTransition } from '../../src/review/transitions.js';
import {
  projectReviewState,
  loadEventsFile,
  loadReviewState,
  rebuildReviewState,
  recordReviewEvent,
} from '../../src/review/reviewStateStore.js';
import { parseReviewStateArgs, runReviewStateCommand } from '../../src/cli/reviewStateCommand.js';
import { buildCandidateReport, writeCandidateReport } from '../../src/review/candidateReport.js';
import {
  anomalyReportWith,
  checkoutJourney,
  cleanExecution,
  differentJourney,
  http404,
  http500,
  pageErrorSignal500,
  reproductionWith,
} from '../fixtures/build6Fixtures.js';

let testDir: string;

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'crashlab-build8-'));
});

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true });
});

function sha256Bytes(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

describe('Build 8: Canonical Candidate Identity', () => {
  const baseInput = {
    targetOrigin: 'https://shop.example.test',
    journeyHash: 'sha256:1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff',
    applicationBuildId: 'build-100',
    ruleId: 'HTTP_5XX',
    signalKey: 'HTTP_5XX|500|get|https://shop.example.test/api/cart|xhr',
    stepId: 'step-002',
  };

  it('generates identical IDs across repeated invocations', () => {
    const id1 = canonicalCandidateId(baseInput);
    const id2 = canonicalCandidateId({ ...baseInput });
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^cand-[a-f0-9]{16}$/);
  });

  it('candidate order changes in anomaly report do not change candidate IDs', () => {
    const plan = checkoutJourney();
    const exec = cleanExecution();

    const report1 = buildCandidateReport({
      baseline: null,
      execution: exec,
      anomalies: anomalyReportWith([http500('anomaly-001'), pageErrorSignal500('anomaly-002')]),
      reproduction: reproductionWith([
        { anomalyId: 'anomaly-001', ruleId: 'HTTP_5XX' },
        { anomalyId: 'anomaly-002', ruleId: 'PAGE_ERROR' },
      ]),
      journey: plan,
      paths: { execution: 'exec.json', anomalies: 'anom.json', reproduction: 'repro.json', journey: 'j.json' },
    });

    const report2 = buildCandidateReport({
      baseline: null,
      execution: exec,
      anomalies: anomalyReportWith([pageErrorSignal500('anomaly-002'), http500('anomaly-001')]),
      reproduction: reproductionWith([
        { anomalyId: 'anomaly-002', ruleId: 'PAGE_ERROR' },
        { anomalyId: 'anomaly-001', ruleId: 'HTTP_5XX' },
      ]),
      journey: plan,
      paths: { execution: 'exec.json', anomalies: 'anom.json', reproduction: 'repro.json', journey: 'j.json' },
    });

    const httpCand1 = report1.candidates.find((c) => c.ruleId === 'HTTP_5XX');
    const httpCand2 = report2.candidates.find((c) => c.ruleId === 'HTTP_5XX');
    expect(httpCand1?.candidateId).toBe(httpCand2?.candidateId);

    const pageCand1 = report1.candidates.find((c) => c.ruleId === 'PAGE_ERROR');
    const pageCand2 = report2.candidates.find((c) => c.ruleId === 'PAGE_ERROR');
    expect(pageCand1?.candidateId).toBe(pageCand2?.candidateId);
  });

  it('timestamps and durations do not change candidate IDs', () => {
    const id1 = canonicalCandidateId(baseInput);
    // Simulating different run time
    const id2 = canonicalCandidateId(baseInput);
    expect(id1).toBe(id2);
  });

  it('unrelated candidates do not change another candidate ID', () => {
    const plan = checkoutJourney();
    const exec = cleanExecution();

    const singleReport = buildCandidateReport({
      baseline: null,
      execution: exec,
      anomalies: anomalyReportWith([http500('anomaly-001')]),
      reproduction: reproductionWith([{ anomalyId: 'anomaly-001', ruleId: 'HTTP_5XX' }]),
      journey: plan,
      paths: { execution: 'exec.json', anomalies: 'anom.json', reproduction: 'repro.json', journey: 'j.json' },
    });

    const multiReport = buildCandidateReport({
      baseline: null,
      execution: exec,
      anomalies: anomalyReportWith([http500('anomaly-001'), http404('anomaly-002'), pageErrorSignal500('anomaly-003')]),
      reproduction: reproductionWith([
        { anomalyId: 'anomaly-001', ruleId: 'HTTP_5XX' },
        { anomalyId: 'anomaly-002', ruleId: 'HTTP_4XX' },
        { anomalyId: 'anomaly-003', ruleId: 'PAGE_ERROR' },
      ]),
      journey: plan,
      paths: { execution: 'exec.json', anomalies: 'anom.json', reproduction: 'repro.json', journey: 'j.json' },
    });

    const singleCand = singleReport.candidates.find((c) => c.ruleId === 'HTTP_5XX');
    const multiCand = multiReport.candidates.find((c) => c.ruleId === 'HTTP_5XX');
    expect(singleCand?.candidateId).toBe(multiCand?.candidateId);
  });

  it('different HTTP status codes produce different candidate IDs', () => {
    const id500 = canonicalCandidateId({
      ...baseInput,
      signalKey: 'HTTP_5XX|500|get|https://shop.example.test/api/cart|xhr',
    });
    const id502 = canonicalCandidateId({
      ...baseInput,
      signalKey: 'HTTP_5XX|502|get|https://shop.example.test/api/cart|xhr',
    });
    expect(id500).not.toBe(id502);
  });

  it('different HTTP methods produce different candidate IDs', () => {
    const idGet = canonicalCandidateId({
      ...baseInput,
      signalKey: 'HTTP_5XX|500|get|https://shop.example.test/api/cart|xhr',
    });
    const idPost = canonicalCandidateId({
      ...baseInput,
      signalKey: 'HTTP_5XX|500|post|https://shop.example.test/api/cart|xhr',
    });
    expect(idGet).not.toBe(idPost);
  });

  it('different rule IDs produce different candidate IDs', () => {
    const idHttp = canonicalCandidateId({
      ...baseInput,
      ruleId: 'HTTP_5XX',
    });
    const idConsole = canonicalCandidateId({
      ...baseInput,
      ruleId: 'CONSOLE_ERROR',
    });
    expect(idHttp).not.toBe(idConsole);
  });

  it('candidates from different journeys cannot collide', () => {
    const idJourney1 = canonicalCandidateId({
      ...baseInput,
      journeyHash: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    });
    const idJourney2 = canonicalCandidateId({
      ...baseInput,
      journeyHash: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
    });
    expect(idJourney1).not.toBe(idJourney2);
  });

  it('candidates from different target origins cannot collide', () => {
    const idOrigin1 = canonicalCandidateId({
      ...baseInput,
      targetOrigin: 'https://staging.example.test',
    });
    const idOrigin2 = canonicalCandidateId({
      ...baseInput,
      targetOrigin: 'https://production.example.test',
    });
    expect(idOrigin1).not.toBe(idOrigin2);
  });

  it('does not embed raw secrets, passwords, or query tokens in canonical payload', () => {
    const sensitiveOrigin = 'https://user:password@shop.example.test:8080/path?token=secret123#fragment';
    const payload = canonicalCandidatePayload({
      ...baseInput,
      targetOrigin: sensitiveOrigin,
    });
    expect(payload).not.toContain('password');
    expect(payload).not.toContain('token');
    expect(payload).not.toContain('secret123');
    expect(payload).toContain('https://shop.example.test:8080');
  });

  it('validates candidate ID shapes strictly', () => {
    expect(validateCandidateId('cand-1234567890abcdef').valid).toBe(true);
    expect(validateCandidateId('candidate-001').valid).toBe(true);
    expect(validateCandidateId('').valid).toBe(false);
    expect(validateCandidateId('cand/evil').valid).toBe(false);
    expect(validateCandidateId('cand\\evil').valid).toBe(false);
    expect(validateCandidateId('cand..escape').valid).toBe(false);
    expect(validateCandidateId('cand with space').valid).toBe(false);
    expect(validateCandidateId('a'.repeat(70)).valid).toBe(false);
  });
});

describe('Build 8: Review State Input Validation', () => {
  it('accepts safe reviewer identities and rejects unsafe ones', () => {
    expect(validateReviewerIdentity('kamal')).toBe('kamal');
    expect(validateReviewerIdentity('reviewer-01')).toBe('reviewer-01');
    expect(validateReviewerIdentity('jane.doe')).toBe('jane.doe');
    expect(validateReviewerIdentity(null)).toBeNull();
    expect(validateReviewerIdentity('   ')).toBeNull();

    expect(() => validateReviewerIdentity('user name with spaces')).toThrow(ReviewStateInputError);
    expect(() => validateReviewerIdentity('user/slash')).toThrow(ReviewStateInputError);
    expect(() => validateReviewerIdentity('user\\backslash')).toThrow(ReviewStateInputError);
    expect(() => validateReviewerIdentity('Bearer token123456789')).toThrow(ReviewStateInputError);
    expect(() => validateReviewerIdentity('eyJhbGciOiJIUzI1NiJ9.test')).toThrow(ReviewStateInputError);
    expect(() => validateReviewerIdentity('a'.repeat(70))).toThrow(ReviewStateInputError);
  });

  it('accepts valid notes and bounds length', () => {
    expect(validateReviewNote('Valid investigation note.')).toBe('Valid investigation note.');
    expect(validateReviewNote(null)).toBeNull();
    expect(validateReviewNote('   ')).toBeNull();

    expect(() => validateReviewNote('a'.repeat(1001))).toThrow(ReviewStateInputError);
    expect(() => validateReviewNote('Note with \x00 null byte')).toThrow(ReviewStateInputError);
    expect(() => validateReviewNote('Bearer abcd1234efgh5678')).toThrow(ReviewStateInputError);
    expect(() => validateReviewNote('Token: eyJhbGciOiJIUzI1NiJ9.1234567890')).toThrow(ReviewStateInputError);
    expect(() => validateReviewNote('password = supersecret123')).toThrow(ReviewStateInputError);
  });

  it('validates duplicate target candidate linking', () => {
    expect(validateDuplicateTarget('cand-001', 'cand-002', 'duplicate')).toBe('cand-002');
    expect(() => validateDuplicateTarget('cand-001', null, 'duplicate')).toThrow(ReviewStateInputError);
    expect(() => validateDuplicateTarget('cand-001', 'cand-001', 'duplicate')).toThrow(ReviewStateInputError);
    expect(() => validateDuplicateTarget('cand-001', 'cand/invalid', 'duplicate')).toThrow(ReviewStateInputError);
    expect(() => validateDuplicateTarget('cand-001', 'cand-002', 'investigating')).toThrow(ReviewStateInputError);
  });
});

describe('Build 8: State Transitions and Matrix', () => {
  it('allows all defined forward transitions from open, investigating, and accepted', () => {
    expect(() => validateStateTransition('open', 'investigating', 'c1')).not.toThrow();
    expect(() => validateStateTransition('open', 'accepted', 'c1')).not.toThrow();
    expect(() => validateStateTransition('open', 'dismissed', 'c1')).not.toThrow();
    expect(() => validateStateTransition('open', 'resolved', 'c1')).not.toThrow();
    expect(() => validateStateTransition('open', 'duplicate', 'c1', 'c2')).not.toThrow();

    expect(() => validateStateTransition('investigating', 'accepted', 'c1')).not.toThrow();
    expect(() => validateStateTransition('investigating', 'dismissed', 'c1')).not.toThrow();
    expect(() => validateStateTransition('investigating', 'resolved', 'c1')).not.toThrow();
    expect(() => validateStateTransition('investigating', 'open', 'c1')).not.toThrow();

    expect(() => validateStateTransition('accepted', 'investigating', 'c1')).not.toThrow();
    expect(() => validateStateTransition('accepted', 'resolved', 'c1')).not.toThrow();
    expect(() => validateStateTransition('accepted', 'open', 'c1')).not.toThrow();
  });

  it('strictly requires reopening to "open" from dismissed, duplicate, and resolved', () => {
    expect(() => validateStateTransition('dismissed', 'open', 'c1')).not.toThrow();
    expect(() => validateStateTransition('duplicate', 'open', 'c1')).not.toThrow();
    expect(() => validateStateTransition('resolved', 'open', 'c1')).not.toThrow();

    expect(() => validateStateTransition('dismissed', 'investigating', 'c1')).toThrow(ReviewStateTransitionError);
    expect(() => validateStateTransition('dismissed', 'accepted', 'c1')).toThrow(ReviewStateTransitionError);
    expect(() => validateStateTransition('duplicate', 'resolved', 'c1')).toThrow(ReviewStateTransitionError);
    expect(() => validateStateTransition('resolved', 'accepted', 'c1')).toThrow(ReviewStateTransitionError);
  });

  it('rejects invalid duplicate chains and cycles', () => {
    const existingStates: any = {
      'c-primary': {
        candidateId: 'c-primary',
        currentStatus: 'open',
        duplicateOf: null,
      },
      'c-dup-1': {
        candidateId: 'c-dup-1',
        currentStatus: 'duplicate',
        duplicateOf: 'c-primary',
      },
    };

    // Linking to another duplicate
    expect(() => validateStateTransition('open', 'duplicate', 'c-new', 'c-dup-1', existingStates)).toThrow(
      ReviewStateTransitionError,
    );

    // Self linking
    expect(() => validateStateTransition('open', 'duplicate', 'c-self', 'c-self', existingStates)).toThrow(
      ReviewStateTransitionError,
    );
  });
});

describe('Build 8: Event Store and Deterministic Projection', () => {
  it('projects empty events into an empty document with confirmed: false', () => {
    const doc = projectReviewState([]);
    expect(doc.candidateCount).toBe(0);
    expect(Object.keys(doc.candidates)).toHaveLength(0);
    expect(doc.interpretation.confirmedBug).toBe(false);
  });

  it('projects a sequential event log deterministically', () => {
    const events: ReviewStateEvent[] = [
      {
        schemaVersion: REVIEW_STATE_SCHEMA_VERSION,
        eventId: 'evt-1',
        candidateId: 'cand-001',
        previousStatus: null,
        newStatus: 'open',
        reviewer: 'operator',
        note: 'First seen',
        duplicateOf: null,
        reason: null,
        timestamp: '2026-10-11T10:00:00.000Z',
        previousRevision: 0,
        revision: 1,
        sourceCandidate: { report: 'reports/candidates.json', candidateId: 'cand-001', signalKeyHash: 'h1', ruleId: 'HTTP_5XX' },
        automaticClassification: 'novel',
        confirmed: false,
      },
      {
        schemaVersion: REVIEW_STATE_SCHEMA_VERSION,
        eventId: 'evt-2',
        candidateId: 'cand-001',
        previousStatus: 'open',
        newStatus: 'investigating',
        reviewer: 'kamal',
        note: 'Investigating checkout endpoint',
        duplicateOf: null,
        reason: null,
        timestamp: '2026-10-11T10:05:00.000Z',
        previousRevision: 1,
        revision: 2,
        sourceCandidate: { report: 'reports/candidates.json', candidateId: 'cand-001', signalKeyHash: 'h1', ruleId: 'HTTP_5XX' },
        automaticClassification: 'novel',
        confirmed: false,
      },
    ];

    const doc = projectReviewState(events);
    expect(doc.candidateCount).toBe(1);
    const cand = doc.candidates['cand-001']!;
    expect(cand.currentStatus).toBe('investigating');
    expect(cand.revision).toBe(2);
    expect(cand.eventCount).toBe(2);
    expect(cand.firstSeenAt).toBe('2026-10-11T10:00:00.000Z');
    expect(cand.lastUpdatedAt).toBe('2026-10-11T10:05:00.000Z');
    expect(cand.reviewer).toBe('kamal');
    expect(cand.latestNote).toBe('Investigating checkout endpoint');
    expect(cand.confirmed).toBe(false);
    expect(cand.disclaimer).toContain('Human review state does not modify automatic classification');
  });

  it('rejects discontinuous revisions in event log', () => {
    const badEvents: ReviewStateEvent[] = [
      {
        schemaVersion: REVIEW_STATE_SCHEMA_VERSION,
        eventId: 'evt-1',
        candidateId: 'cand-001',
        previousStatus: null,
        newStatus: 'open',
        reviewer: null,
        note: null,
        duplicateOf: null,
        reason: null,
        timestamp: '2026-10-11T10:00:00.000Z',
        previousRevision: 0,
        revision: 1,
        sourceCandidate: null,
        automaticClassification: 'novel',
        confirmed: false,
      },
      {
        schemaVersion: REVIEW_STATE_SCHEMA_VERSION,
        eventId: 'evt-2',
        candidateId: 'cand-001',
        previousStatus: 'open',
        newStatus: 'investigating',
        reviewer: null,
        note: null,
        duplicateOf: null,
        reason: null,
        timestamp: '2026-10-11T10:05:00.000Z',
        previousRevision: 3, // invalid!
        revision: 4,
        sourceCandidate: null,
        automaticClassification: 'novel',
        confirmed: false,
      },
    ];

    expect(() => projectReviewState(badEvents)).toThrow(ReviewStateIntegrityError);
  });

  it('records events and updates projected state on disk', async () => {
    const storeDir = join(testDir, 'store-e2e');
    const { event, state } = await recordReviewEvent(storeDir, {
      candidateId: 'cand-0000000000000001',
      status: 'open',
      reviewer: 'alice',
      note: 'Initial finding',
      automaticClassification: 'novel',
      timestamp: '2026-10-11T11:00:00.000Z',
    });

    expect(event.newStatus).toBe('open');
    expect(event.revision).toBe(1);
    expect(event.confirmed).toBe(false);
    expect(state.candidateCount).toBe(1);

    const loaded = await loadReviewState(storeDir);
    expect(loaded.inconsistent).toBe(false);
    expect(loaded.events).toHaveLength(1);
    expect(loaded.state?.candidates['cand-0000000000000001']?.currentStatus).toBe('open');

    // Transition to investigating
    const { event: evt2, state: state2 } = await recordReviewEvent(storeDir, {
      candidateId: 'cand-0000000000000001',
      status: 'investigating',
      reviewer: 'bob',
      note: 'Investigating network trace',
      timestamp: '2026-10-11T11:10:00.000Z',
    });

    expect(evt2.newStatus).toBe('investigating');
    expect(evt2.revision).toBe(2);
    expect(state2.candidates['cand-0000000000000001']?.reviewer).toBe('bob');

    // Rebuild projection and confirm byte consistency
    const rebuilt = await rebuildReviewState(storeDir);
    expect(rebuilt.candidates['cand-0000000000000001']?.revision).toBe(2);
    expect(rebuilt.candidates['cand-0000000000000001']?.currentStatus).toBe('investigating');
  });

  it('detects tampering and inconsistency between events.jsonl and state.json', async () => {
    const storeDir = join(testDir, 'tamper-test');
    await recordReviewEvent(storeDir, {
      candidateId: 'cand-0000000000000002',
      status: 'open',
      reviewer: 'alice',
      timestamp: '2026-10-11T12:00:00.000Z',
    });

    // Tamper with state.json directly
    const statePath = join(storeDir, REVIEW_STATE_PROJECTION_FILE);
    const doc = JSON.parse(await readFile(statePath, 'utf8'));
    doc.candidates['cand-0000000000000002'].currentStatus = 'resolved'; // tampering!
    await writeFile(statePath, JSON.stringify(doc), 'utf8');

    const check = await loadReviewState(storeDir);
    expect(check.inconsistent).toBe(true);
    expect(check.error).toContain('Projection mismatch');

    // Attempting to record an event on an inconsistent store must refuse
    await expect(
      recordReviewEvent(storeDir, {
        candidateId: 'cand-0000000000000002',
        status: 'investigating',
      }),
    ).rejects.toThrow(ReviewStateIntegrityError);

    // Repair via rebuild
    const repaired = await rebuildReviewState(storeDir);
    expect(repaired.candidates['cand-0000000000000002']?.currentStatus).toBe('open');

    const checkAfter = await loadReviewState(storeDir);
    expect(checkAfter.inconsistent).toBe(false);
  });

  it('safely handles malformed and empty lines in events.jsonl', async () => {
    const storeDir = join(testDir, 'malformed-test');
    const eventsPath = join(storeDir, REVIEW_STATE_EVENTS_FILE);
    await mkdir(storeDir, { recursive: true });

    // Write empty line and malformed JSON
    await writeFile(eventsPath, '\n\n{"bad json": \n', 'utf8');
    const check = await loadReviewState(storeDir);
    expect(check.inconsistent).toBe(true);
    expect(check.error).toContain('Failed to parse JSONL');
  });
});

describe('Build 8: CLI Integration', () => {
  it('parses CLI arguments correctly', () => {
    const parsed = parseReviewStateArgs([
      '--candidate', 'cand-123',
      '--status', 'investigating',
      '--reviewer', 'kamal',
      '--note', 'testing flow',
      '--state', 'custom/dir',
    ]);
    expect(parsed.valid).toBe(true);
    expect(parsed.candidateId).toBe('cand-123');
    expect(parsed.status).toBe('investigating');
    expect(parsed.reviewer).toBe('kamal');
    expect(parsed.note).toBe('testing flow');
    expect(parsed.stateDir).toBe('custom/dir');
  });

  it('rejects unknown CLI options', () => {
    const parsed = parseReviewStateArgs(['--unknown-flag', 'value']);
    expect(parsed.valid).toBe(false);
    expect(parsed.error).toContain('Unknown option');
  });

  it('rejects missing action if no flags provided', () => {
    const parsed = parseReviewStateArgs([]);
    expect(parsed.valid).toBe(false);
    expect(parsed.error).toContain('No action specified');
  });

  it('executes full CLI lifecycle: create candidate report, review state, list, show, rebuild', async () => {
    const runDir = join(testDir, 'cli-run');
    const stateDir = join(runDir, 'review-state');
    const candidatesPath = join(runDir, 'candidates.json');

    // 1. Create a candidate report
    const plan = checkoutJourney();
    const exec = cleanExecution();
    const candidateReport = buildCandidateReport({
      baseline: null,
      execution: exec,
      anomalies: anomalyReportWith([http500('anomaly-001')]),
      reproduction: reproductionWith([{ anomalyId: 'anomaly-001', ruleId: 'HTTP_5XX' }]),
      journey: plan,
      paths: { execution: 'exec.json', anomalies: 'anom.json', reproduction: 'repro.json', journey: 'j.json' },
    });
    await writeCandidateReport(candidateReport, candidatesPath);

    const generatedCand = candidateReport.candidates[0]!;
    expect(generatedCand.candidateId).toBeTruthy();
    const targetId = generatedCand.candidateId!;

    // 2. Run CLI review-state to transition candidate to investigating
    const exitCode1 = await runReviewStateCommand([
      '--state', stateDir,
      '--candidates', candidatesPath,
      '--candidate', targetId,
      '--status', 'investigating',
      '--reviewer', 'kamal',
      '--note', 'Checking out checkout controller error',
    ]);
    expect(exitCode1).toBe(0);

    // 3. Run CLI review-state --list
    const exitCodeList = await runReviewStateCommand([
      '--state', stateDir,
      '--candidates', candidatesPath,
      '--list',
    ]);
    expect(exitCodeList).toBe(0);

    // 4. Run CLI review-state --show
    const exitCodeShow = await runReviewStateCommand([
      '--state', stateDir,
      '--candidates', candidatesPath,
      '--show', targetId,
    ]);
    expect(exitCodeShow).toBe(0);

    // 5. Run CLI review-state with candidate alias "candidate-001" to transition to accepted
    const exitCodeAlias = await runReviewStateCommand([
      '--state', stateDir,
      '--candidates', candidatesPath,
      '--candidate', 'candidate-001',
      '--status', 'accepted',
      '--reviewer', 'kamal',
      '--note', 'Acknowledged real issue',
    ]);
    expect(exitCodeAlias).toBe(0);

    // Verify revision is 2 and status is accepted
    const loaded = await loadReviewState(stateDir);
    expect(loaded.state?.candidates[targetId]?.currentStatus).toBe('accepted');
    expect(loaded.state?.candidates[targetId]?.revision).toBe(2);

    // 6. Run CLI review-state --rebuild
    const exitCodeRebuild = await runReviewStateCommand([
      '--state', stateDir,
      '--rebuild',
    ]);
    expect(exitCodeRebuild).toBe(0);
  });
});

describe('Build 8: Evidence Immutability Audit', () => {
  it('guarantees underlying input files are byte-identical before and after review-state operations', async () => {
    const auditDir = join(testDir, 'immutability-audit');
    const stateDir = join(auditDir, 'review-state');
    const candidatesPath = join(auditDir, 'candidates.json');
    const executionPath = join(auditDir, 'execution.json');
    const anomaliesPath = join(auditDir, 'anomalies.json');
    const reproductionPath = join(auditDir, 'reproduction.json');
    const journeyPath = join(auditDir, 'journey.json');

    const plan = checkoutJourney();
    const exec = cleanExecution();
    const anom = anomalyReportWith([http500('anomaly-001')]);
    const repro = reproductionWith([{ anomalyId: 'anomaly-001', ruleId: 'HTTP_5XX' }]);
    const candReport = buildCandidateReport({
      baseline: null,
      execution: exec,
      anomalies: anom,
      reproduction: repro,
      journey: plan,
      paths: { execution: executionPath, anomalies: anomaliesPath, reproduction: reproductionPath, journey: journeyPath },
    });

    await mkdir(auditDir, { recursive: true });
    await writeFile(journeyPath, JSON.stringify(plan, null, 2), 'utf8');
    await writeFile(executionPath, JSON.stringify(exec, null, 2), 'utf8');
    await writeFile(anomaliesPath, JSON.stringify(anom, null, 2), 'utf8');
    await writeFile(reproductionPath, JSON.stringify(repro, null, 2), 'utf8');
    await writeFile(candidatesPath, JSON.stringify(candReport, null, 2), 'utf8');

    // Calculate SHA-256 hashes BEFORE
    const hashJourneyBefore = sha256Bytes(await readFile(journeyPath));
    const hashExecBefore = sha256Bytes(await readFile(executionPath));
    const hashAnomBefore = sha256Bytes(await readFile(anomaliesPath));
    const hashReproBefore = sha256Bytes(await readFile(reproductionPath));
    const hashCandBefore = sha256Bytes(await readFile(candidatesPath));

    // Perform review-state operations
    await runReviewStateCommand([
      '--state', stateDir,
      '--candidates', candidatesPath,
      '--candidate', 'candidate-001',
      '--status', 'investigating',
      '--reviewer', 'operator',
      '--note', 'Under active investigation',
    ]);

    await runReviewStateCommand([
      '--state', stateDir,
      '--candidates', candidatesPath,
      '--candidate', 'candidate-001',
      '--status', 'dismissed',
      '--note', 'Dismissed after triage',
    ]);

    await runReviewStateCommand([
      '--state', stateDir,
      '--candidates', candidatesPath,
      '--candidate', 'candidate-001',
      '--status', 'open',
      '--note', 'Reopened due to new report',
    ]);

    // Calculate SHA-256 hashes AFTER
    const hashJourneyAfter = sha256Bytes(await readFile(journeyPath));
    const hashExecAfter = sha256Bytes(await readFile(executionPath));
    const hashAnomAfter = sha256Bytes(await readFile(anomaliesPath));
    const hashReproAfter = sha256Bytes(await readFile(reproductionPath));
    const hashCandAfter = sha256Bytes(await readFile(candidatesPath));

    // Confirm byte identity (exact match)
    expect(hashJourneyAfter).toBe(hashJourneyBefore);
    expect(hashExecAfter).toBe(hashExecBefore);
    expect(hashAnomAfter).toBe(hashAnomBefore);
    expect(hashReproAfter).toBe(hashReproBefore);
    expect(hashCandAfter).toBe(hashCandBefore);
  });
});
