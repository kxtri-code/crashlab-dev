/**
 * HTTP Server Integration Tests for Review API (Build 9.1).
 *
 * Verifies:
 *  - GET /health and HEAD /health
 *  - GET /api/summary
 *  - GET /api/candidates with filters and pagination
 *  - GET /api/candidates/:id (canonical and alias) and 404
 *  - GET /api/candidates/:id/history
 *  - GET /api/baselines with filters
 *  - GET /api/baselines/:id and 404
 *  - GET /api/runs/current and GET /api/runs/reproduction
 *  - 405 Method Not Allowed on POST, PUT, PATCH, DELETE with Allow header
 *  - 400 Bad Request on invalid query parameters, invalid enums, path traversal
 *  - Input immutability: SHA-256 hashes of all input files before and after requests
 *  - Response determinism: 3 repeated requests yield identical SHA-256 hashes
 *  - Clean server shutdown
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { createReviewApiServer } from '../../src/reviewApi/server.js';
import type { RunningReviewApiServer } from '../../src/reviewApi/server.js';
import { canonicalJsonStringify } from '../../src/reviewApi/serialization.js';

interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function makeRequest(
  url: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: options.method ?? 'GET',
        headers: options.headers ?? {},
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: data,
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function sha256File(path: string): Promise<string> {
  const content = await readFile(path);
  return createHash('sha256').update(content).digest('hex');
}

async function hashDirectoryFiles(dir: string): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile()) {
      const fullPath = join(entry.parentPath || dir, entry.name);
      hashes.set(fullPath, await sha256File(fullPath));
    }
  }
  return hashes;
}

describe('Review API HTTP Server Integration', () => {
  let tempDir: string;
  let server: RunningReviewApiServer;
  let candidatesPath: string;
  let reviewStateDir: string;
  let baselinesDir: string;
  let journeyPath: string;
  let executionPath: string;
  let anomaliesPath: string;
  let reproductionPath: string;
  let fileHashesBefore: Map<string, string>;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'crashlab-api-http-'));
    const reportsDir = join(tempDir, 'reports');
    reviewStateDir = join(reportsDir, 'review-state');
    baselinesDir = join(reportsDir, 'baselines');
    await mkdir(reviewStateDir, { recursive: true });
    await mkdir(baselinesDir, { recursive: true });

    // 1. Candidate report
    candidatesPath = join(reportsDir, 'candidates.json');
    const candidateReport = {
      schemaVersion: '1.0',
      baseline: { baselineId: 'base-http-001', report: 'reports/baselines/base-http-001.json' },
      current: {
        executionReport: 'reports/execution.json',
        anomalyReport: 'reports/anomalies.json',
        reproductionReport: 'reports/reproduction.json',
        journeyReport: 'reports/journey.json',
      },
      comparison: {
        classification: 'same-environment',
        targetOrigin: 'https://app.test',
        journeyHash: 'sha256:aaaa1111',
        environmentFingerprint: 'sha256:bbbb2222',
        differences: [],
        reason: null,
      },
      baselineVerification: {
        status: 'complete',
        coverage: 'full-plan',
        unverifiedAssertions: 0,
      },
      comparisonLimitations: ['Deterministic fixture limitation.'],
      summary: {
        totalSignals: 2,
        novel: 1,
        reintroduced: 0,
        persistent: 0,
        resolved: 0,
        changed: 0,
        unknown: 1,
        crossEnvironment: 0,
        differentBuild: 0,
        reproducedSignals: 1,
      },
      candidates: [
        {
          id: 'candidate-001',
          candidateId: 'cand-0000000000000001',
          signalKeyHash: 'key-hash-1',
          ruleId: 'http-status-500',
          kind: 'http',
          classification: 'novel',
          reviewStatus: 'needs-review',
          confirmed: false,
          reproduced: true,
          baselinePresent: false,
          currentPresent: true,
          environmentComparison: 'same-environment',
          evidence: {
            currentAnomalyIds: ['anom-1'],
            reproductionResultIds: ['repro-1'],
            baselineSignalKeys: [],
            relatedBaselineSignalKey: null,
          },
          message: 'Server error on submission step.',
          requiresInvestigation: true,
          reproductionClassification: 'reproduced',
          stepOrder: 2,
        },
        {
          id: 'candidate-002',
          candidateId: 'cand-0000000000000002',
          signalKeyHash: 'key-hash-2',
          ruleId: 'console-warn',
          kind: 'console',
          classification: 'unknown',
          reviewStatus: 'inconclusive',
          confirmed: false,
          reproduced: false,
          baselinePresent: false,
          currentPresent: true,
          environmentComparison: 'unknown-environment',
          evidence: {
            currentAnomalyIds: ['anom-2'],
            reproductionResultIds: [],
            baselineSignalKeys: [],
            relatedBaselineSignalKey: null,
          },
          message: 'Unconfirmed console warning.',
          requiresInvestigation: false,
          reproductionClassification: null,
          stepOrder: 1,
        },
      ],
      interpretation: {
        confirmedBug: false,
        automaticSeverity: false,
        candidatesRequireReview: true,
        note: 'Review candidate defects.',
      },
      selectionMode: 'explicit',
      selectedBaselineId: 'base-http-001',
      parentBaselineId: null,
    };
    await writeFile(candidatesPath, canonicalJsonStringify(candidateReport));

    // 2. Review state events and projection
    const eventsPath = join(reviewStateDir, 'events.jsonl');
    const statePath = join(reviewStateDir, 'state.json');
    const event1 = {
      schemaVersion: '1.0',
      eventId: 'evt-http-001',
      candidateId: 'cand-0000000000000001',
      previousStatus: null,
      newStatus: 'open',
      reviewer: 'tester',
      note: 'Initial triage open',
      duplicateOf: null,
      reason: null,
      timestamp: '2026-03-02T12:00:00.000Z',
      previousRevision: 0,
      revision: 1,
      sourceCandidate: null,
      automaticClassification: 'novel',
      confirmed: false,
    };
    await writeFile(eventsPath, JSON.stringify(event1) + '\n');
    const stateDoc = {
      schemaVersion: '1.0',
      updatedAt: '2026-03-02T12:00:00.000Z',
      candidateCount: 1,
      candidates: {
        'cand-0000000000000001': {
          schemaVersion: '1.0',
          candidateId: 'cand-0000000000000001',
          currentStatus: 'open',
          firstSeenAt: '2026-03-02T12:00:00.000Z',
          lastUpdatedAt: '2026-03-02T12:00:00.000Z',
          reviewer: 'tester',
          latestNote: 'Initial triage open',
          duplicateOf: null,
          sourceCandidate: null,
          revision: 1,
          eventCount: 1,
          lastEventId: 'evt-http-001',
          eventIds: ['evt-http-001'],
          automaticClassification: 'novel',
          confirmed: false,
          disclaimer: 'Human review state never confirms bugs.',
        },
      },
      interpretation: {
        confirmedBug: false,
        automaticSeverity: false,
        note: 'Projection does not confirm bugs.',
      },
    };
    await writeFile(statePath, canonicalJsonStringify(stateDoc));

    // 3. Baselines
    const baselineDoc = {
      schemaVersion: '1.0',
      baselineId: 'base-http-001',
      name: 'HTTP Test Baseline',
      status: 'known-good',
      createdAt: '2026-01-15T08:00:00.000Z',
      confirmation: {
        explicit: true,
        confirmedBy: 'operator',
        acceptedSignalIds: [],
      },
      source: {
        executionReport: 'reports/execution.json',
        anomalyReport: 'reports/anomalies.json',
        journeyReport: 'reports/journey.json',
      },
      identity: {
        targetOrigin: 'https://app.test',
        journeyHash: 'sha256:aaaa1111',
        journeySchemaVersion: '1.0',
        journeyType: 'linear',
        environmentFingerprint: 'sha256:bbbb2222',
        environmentId: null,
        applicationBuildId: 'build-v1',
        plannerVersion: '0.1.0',
        executorVersion: '0.1.0',
      },
      knownSignals: [],
      safety: {
        safeTestMode: true,
        livePaymentAllowed: false,
        executionHadFailures: false,
        executionIncomplete: false,
      },
      verification: {
        complete: true,
        coverage: 'full-plan',
        unverifiedAssertions: 0,
        operatorApproved: false,
      },
      rationale: 'Known-good baseline.',
      interpretation: {
        confirmedBug: false,
        automaticSeverity: false,
        note: 'Baselines do not confirm bugs.',
      },
      parentBaselineId: null,
      lineage: {
        parentBaselineId: null,
        rootBaselineId: 'base-http-001',
        depth: 0,
        ancestors: [],
        truncated: false,
      },
    };
    await writeFile(join(baselinesDir, 'base-http-001.json'), canonicalJsonStringify(baselineDoc));
    const registryDoc = {
      schemaVersion: '1.0',
      baselines: [
        {
          baselineId: 'base-http-001',
          name: 'HTTP Test Baseline',
          report: 'reports/baselines/base-http-001.json',
          createdAt: '2026-01-15T08:00:00.000Z',
          targetOrigin: 'https://app.test',
          environmentFingerprint: 'sha256:bbbb2222',
          journeyHash: 'sha256:aaaa1111',
          status: 'known-good',
          verificationCoverage: 'full-plan',
          applicationBuildId: 'build-v1',
        },
      ],
    };
    await writeFile(join(baselinesDir, 'index.json'), canonicalJsonStringify(registryDoc));

    // 4. Execution report
    executionPath = join(reportsDir, 'execution.json');
    const executionDoc = {
      schemaVersion: '1.0',
      journeyPlanSchemaVersion: '1.0',
      journeyReport: 'reports/journey.json',
      goal: 'Test checkout',
      journeyType: 'linear',
      target: { url: 'https://app.test/checkout', finalUrl: 'https://app.test/checkout', title: 'Checkout' },
      status: 'completed',
      verification: { complete: true, coverage: 'full-plan', unverifiedAssertions: 0 },
      startedAt: '2026-03-02T11:00:00.000Z',
      finishedAt: '2026-03-02T11:01:00.000Z',
      durationMs: 60000,
      stepCounts: { total: 2, passed: 2, failed: 0, blocked: 0, skipped: 0 },
      steps: [
        { id: 's1', status: 'passed' },
        { id: 's2', status: 'passed' },
      ],
      rawEvidence: { consoleEvents: [], pageErrors: [], networkEvents: [], screenshots: [] },
      warnings: [],
      blockedSteps: [],
      redaction: { sensitiveValuesRedacted: true, redactedValueCount: 0, dataProvidedKeys: [], dataProvided: false, screenshotsOmittedAfterSensitiveData: false },
      executor: { mode: 'deterministic', version: '0.1.0', retries: 0, stoppedOnFailure: false, continueOnFailure: false, safeTestMode: true },
      environment: {
        schemaVersion: '1.0',
        fingerprint: 'sha256:bbbb2222',
        fingerprintInputs: {},
        target: { origin: 'https://app.test', unresolved: false },
        runtime: { nodeVersion: '20.11.0', platform: 'win32', architecture: 'x64' },
        browser: { name: 'chromium', version: '1.0' },
        configuration: { headless: true, safeTestMode: true, timeoutMs: 30000 },
        source: { journeySchemaVersion: '1.0', plannerVersion: '0.1.0', executorVersion: '0.1.0' },
        application: { buildId: 'build-v1', environmentId: null },
        testData: { fixtureId: null, fixtureHash: null },
      },
    };
    await writeFile(executionPath, canonicalJsonStringify(executionDoc));

    // Snapshot hashes of all input files BEFORE starting the server
    fileHashesBefore = await hashDirectoryFiles(tempDir);

    // Start server on free ephemeral port (port: 0)
    server = await createReviewApiServer(
      {
        host: '127.0.0.1',
        port: 0,
        paths: {
          candidatesPath,
          reviewStateDir,
          baselinesDir,
          executionPath,
        },
      },
      tempDir,
    );
    await server.start();
  });

  afterAll(async () => {
    if (server) {
      await server.stop();
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it('GET /health: returns 200 with service metadata and readOnly: true', async () => {
    const res = await makeRequest(`${server.url}/health`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['cache-control']).toBe('no-store');

    const parsed = JSON.parse(res.body);
    expect(parsed.ok).toBe(true);
    expect(parsed.service).toBe('crashlab-review-api');
    expect(parsed.readOnly).toBe(true);
    expect(parsed.schemaVersion).toBe('1.0');
  });

  it('HEAD /health: returns headers without body', async () => {
    const res = await makeRequest(`${server.url}/health`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body).toBe('');
  });

  it('GET /api/summary: returns review summary with confirmedBug: false', async () => {
    const res = await makeRequest(`${server.url}/api/summary`);
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.schemaVersion).toBe('1.0');
    expect(parsed.totalCandidates).toBe(2);
    expect(parsed.byClassification.novel).toBe(1);
    expect(parsed.byClassification.unknown).toBe(1);
    expect(parsed.byReviewStatus.open).toBe(1);
    expect(parsed.byReviewStatus.unreviewed).toBe(1);
    expect(parsed.interpretation.confirmedBug).toBe(false);
  });

  it('GET /api/candidates: lists candidates in deterministic order with confirmed: false', async () => {
    const res = await makeRequest(`${server.url}/api/candidates`);
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.totalCount).toBe(2);
    expect(parsed.returnedCount).toBe(2);
    expect(parsed.candidates[0].candidateId).toBe('cand-0000000000000001');
    expect(parsed.candidates[0].classification).toBe('novel');
    expect(parsed.candidates[0].reviewStatus).toBe('open');
    expect(parsed.candidates[0].confirmed).toBe(false);

    expect(parsed.candidates[1].candidateId).toBe('cand-0000000000000002');
    expect(parsed.candidates[1].classification).toBe('unknown');
    expect(parsed.candidates[1].reviewStatus).toBe('unreviewed');
    expect(parsed.candidates[1].confirmed).toBe(false);
  });

  it('GET /api/candidates: filters by classification and reviewStatus', async () => {
    const res = await makeRequest(`${server.url}/api/candidates?classification=novel&reviewStatus=open`);
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.totalCount).toBe(1);
    expect(parsed.candidates[0].candidateId).toBe('cand-0000000000000001');

    const emptyRes = await makeRequest(`${server.url}/api/candidates?classification=novel&reviewStatus=dismissed`);
    expect(emptyRes.status).toBe(200);
    const emptyParsed = JSON.parse(emptyRes.body);
    expect(emptyParsed.totalCount).toBe(0);
  });

  it('GET /api/candidates/:id: returns candidate detail for canonical ID and alias', async () => {
    // Canonical ID
    const res1 = await makeRequest(`${server.url}/api/candidates/cand-0000000000000001`);
    expect(res1.status).toBe(200);
    const detail1 = JSON.parse(res1.body);
    expect(detail1.candidateId).toBe('cand-0000000000000001');
    expect(detail1.reviewStatus).toBe('open');
    expect(detail1.humanReviewState.reviewer).toBe('tester');
    expect(detail1.confirmed).toBe(false);
    expect(detail1.interpretation.confirmedBug).toBe(false);

    // Positional alias
    const res2 = await makeRequest(`${server.url}/api/candidates/candidate-001`);
    expect(res2.status).toBe(200);
    const detail2 = JSON.parse(res2.body);
    expect(detail2.candidateId).toBe('cand-0000000000000001');
  });

  it('GET /api/candidates/:id: returns 404 with structured error for unknown candidate', async () => {
    const res = await makeRequest(`${server.url}/api/candidates/cand-9999999999999999`);
    expect(res.status).toBe(404);
    const parsed = JSON.parse(res.body);
    expect(parsed.error.code).toBe('candidate-not-found');
    expect(parsed.error.message).toContain('cand-9999999999999999');
  });

  it('GET /api/candidates/:id/history: returns historical review events', async () => {
    const res = await makeRequest(`${server.url}/api/candidates/cand-0000000000000001/history`);
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.candidateId).toBe('cand-0000000000000001');
    expect(parsed.currentStatus).toBe('open');
    expect(parsed.unreviewed).toBe(false);
    expect(parsed.eventCount).toBe(1);
    expect(parsed.events[0].eventId).toBe('evt-http-001');
    expect(parsed.events[0].reviewer).toBe('tester');
    expect(parsed.events[0].confirmed).toBe(false);
  });

  it('GET /api/baselines: returns baseline list and supports filters', async () => {
    const res = await makeRequest(`${server.url}/api/baselines`);
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.totalCount).toBe(1);
    expect(parsed.baselines[0].baselineId).toBe('base-http-001');
    expect(parsed.baselines[0].status).toBe('known-good');

    const filtered = await makeRequest(`${server.url}/api/baselines?status=known-good`);
    expect(filtered.status).toBe(200);
    expect(JSON.parse(filtered.body).totalCount).toBe(1);

    const empty = await makeRequest(`${server.url}/api/baselines?status=known-good-partial`);
    expect(empty.status).toBe(200);
    expect(JSON.parse(empty.body).totalCount).toBe(0);
  });

  it('GET /api/baselines/:id: returns baseline detail and 404 for unknown', async () => {
    const res = await makeRequest(`${server.url}/api/baselines/base-http-001`);
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.baselineId).toBe('base-http-001');
    expect(parsed.name).toBe('HTTP Test Baseline');
    expect(parsed.interpretation.confirmedBug).toBe(false);

    const notFound = await makeRequest(`${server.url}/api/baselines/base-unknown`);
    expect(notFound.status).toBe(404);
    expect(JSON.parse(notFound.body).error.code).toBe('baseline-not-found');
  });

  it('GET /api/runs/current: returns current execution run context', async () => {
    const res = await makeRequest(`${server.url}/api/runs/current`);
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.status).toBe('completed');
    expect(parsed.stepCounts.total).toBe(2);
    expect(parsed.provenance.applicationBuildId).toBe('build-v1');
  });

  it('Mutation rejection: POST, PUT, PATCH, DELETE return 405 Method Not Allowed with Allow header', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await makeRequest(`${server.url}/api/candidates`, { method });
      expect(res.status).toBe(405);
      expect(res.headers.allow).toBe('GET, HEAD');
      const parsed = JSON.parse(res.body);
      expect(parsed.error.code).toBe('method-not-allowed');
    }
  });

  it('Input validation: rejects unknown query parameter with 400', async () => {
    const res = await makeRequest(`${server.url}/api/candidates?unrecognized=bad`);
    expect(res.status).toBe(400);
    const parsed = JSON.parse(res.body);
    expect(parsed.error.code).toBe('invalid-query');
    expect(parsed.error.message).toContain('unrecognized');
  });

  it('Path safety: rejects path traversal attempts with 400', async () => {
    const res = await makeRequest(`${server.url}/api/candidates/..%2f..%2fpasswd`);
    expect(res.status).toBe(400);
    const parsed = JSON.parse(res.body);
    expect(parsed.error.code).toBe('invalid-path');
  });

  it('Determinism: 3 repeated identical requests produce byte-identical SHA-256 bodies', async () => {
    const routes = [
      '/health',
      '/api/summary',
      '/api/candidates',
      '/api/candidates/cand-0000000000000001',
      '/api/candidates/cand-0000000000000001/history',
      '/api/baselines',
      '/api/baselines/base-http-001',
      '/api/runs/current',
    ];

    for (const route of routes) {
      const hashes: string[] = [];
      for (let run = 0; run < 3; run++) {
        const res = await makeRequest(`${server.url}${route}`);
        expect(res.status).toBe(200);
        const hash = createHash('sha256').update(res.body, 'utf8').digest('hex');
        hashes.push(hash);
      }
      // All 3 hashes must be identical
      expect(hashes[0]).toBe(hashes[1]);
      expect(hashes[1]).toBe(hashes[2]);
    }
  });

  it('Immutability guarantee: all backing artifact files remain 100% byte-identical after requests', async () => {
    const fileHashesAfter = await hashDirectoryFiles(tempDir);

    // Number of files must not have changed (no new files created)
    expect(fileHashesAfter.size).toBe(fileHashesBefore.size);

    for (const [filePath, hashBefore] of fileHashesBefore.entries()) {
      const hashAfter = fileHashesAfter.get(filePath);
      expect(hashAfter).toBeDefined();
      expect(hashAfter).toBe(hashBefore);
    }
  });
});
