/**
 * Regression Unit Tests for Build 12G.1: Dashboard Polish and Anomaly Review.
 *
 * Verifies:
 * 1. Automatic re-fetch of GET /api/v1/runs/:id/artifacts and candidate defect list
 *    when a run reaches a terminal state (completed/failed/blocked/cancelled)
 * 2. Deterministic, safe artifact download filename resolution:
 *    - text/plain -> .txt or .log
 *    - application/json -> .json
 *    - safe fallback -> .bin for unknown content types
 * 3. Anomaly Review & Invariants:
 *    - DUPLICATE_REQUEST detection accurately identifies repeated document/API requests
 *    - Genuine anomalies are NOT suppressed or hidden
 *    - Repeatable asset types are flagged possiblyExpected while document requests remain unsuppressed
 */

import { describe, it, expect } from 'vitest';
import {
  resolveArtifactExtension,
  resolveArtifactFilename,
  CLIENT_JS_BUNDLE,
} from '../../src/product/dashboard/index.js';
import { buildAnomalyReport } from '../../src/anomaly/report.js';
import { RULE_IDS } from '../../src/anomaly/types.js';
import type { ExecutionReport, EvidenceNetworkEvent } from '../../src/executor/types.js';
import type { JourneyPlan } from '../../src/journey/types.js';

describe('Build 12G.1 Item 1: Dashboard Auto-Hydration for Artifacts', () => {
  it('bundles auto-fetch for artifacts and candidates when a run reaches terminal status', () => {
    // Assert client bundle contains the auto-hydration logic on terminal status transition
    expect(CLIENT_JS_BUNDLE).toContain("api.getJson('/api/v1/runs/' + runId + '/artifacts?workspaceId=' + wsId)");
    expect(CLIENT_JS_BUNDLE).toContain("api.getJson('/api/v1/runs/' + runId + '/candidates?workspaceId=' + wsId)");
    expect(CLIENT_JS_BUNDLE).toContain('state.artifacts = artRes.value.data.artifacts || [];');
  });

  it('verifies PollingManager stops polling before attempting terminal artifact re-fetch', () => {
    const terminalCheckIndex = CLIENT_JS_BUNDLE.indexOf("terminalStatuses.includes(state.selectedRun.status)");
    expect(terminalCheckIndex).toBeGreaterThan(-1);

    const stopPollerIndex = CLIENT_JS_BUNDLE.indexOf("this.stop()", terminalCheckIndex);
    const fetchArtIndex = CLIENT_JS_BUNDLE.indexOf("/api/v1/runs/' + runId + '/artifacts", terminalCheckIndex);

    expect(stopPollerIndex).toBeGreaterThan(-1);
    expect(fetchArtIndex).toBeGreaterThan(stopPollerIndex);
  });
});

describe('Build 12G.1 Item 2: Artifact Download Filename Handling', () => {
  it('resolves text/plain log artifacts to .log extension', () => {
    const ext = resolveArtifactExtension('log', 'text/plain');
    expect(ext).toBe('log');

    const filename = resolveArtifactFilename('log', 'art-12345678-abcd', 'text/plain; charset=utf-8');
    expect(filename).toBe('artifact-log-art-1234.log');
  });

  it('resolves text/plain non-log artifacts to .txt extension', () => {
    const ext = resolveArtifactExtension('notes', 'text/plain');
    expect(ext).toBe('txt');

    const filename = resolveArtifactFilename('notes', 'art-87654321-efgh', 'text/plain');
    expect(filename).toBe('artifact-notes-art-8765.txt');
  });

  it('resolves application/json to .json extension', () => {
    const execExt = resolveArtifactExtension('execution', 'application/json');
    expect(execExt).toBe('json');
    expect(resolveArtifactFilename('execution', 'art-exec-1111', 'application/json')).toBe('artifact-execution-art-exec.json');

    const anomExt = resolveArtifactExtension('anomalies', 'application/json; charset=utf-8');
    expect(anomExt).toBe('json');
    expect(resolveArtifactFilename('anomalies', 'art-anom-2222', 'application/json')).toBe('artifact-anomalies-art-anom.json');
  });

  it('resolves image formats to their respective extensions', () => {
    expect(resolveArtifactExtension('screenshot', 'image/png')).toBe('png');
    expect(resolveArtifactExtension('screenshot', 'image/jpeg')).toBe('jpg');
    expect(resolveArtifactExtension('screenshot', 'image/webp')).toBe('webp');
  });

  it('preserves safe fallback (.bin) for unknown or missing content types', () => {
    expect(resolveArtifactExtension('unknown', 'application/octet-stream')).toBe('bin');
    expect(resolveArtifactExtension('custom', 'binary/unknown')).toBe('bin');
    expect(resolveArtifactExtension('blob', '')).toBe('bin');
    expect(resolveArtifactExtension('blob', null)).toBe('bin');

    const filename = resolveArtifactFilename('unknown', 'art-99999999', 'application/octet-stream');
    expect(filename).toBe('artifact-unknown-art-9999.bin');
  });

  it('sanitizes artifact IDs and types with illegal characters', () => {
    const filename = resolveArtifactFilename('type/bad!@#', 'id/with$special%chars', 'application/json');
    expect(filename).toMatch(/^artifact-[a-zA-Z0-9_-]+-[a-zA-Z0-9_-]+\.json$/);
  });

  it('verifies client bundle invokes resolveArtifactFilename in downloadArtifact', () => {
    expect(CLIENT_JS_BUNDLE).toContain('function resolveArtifactFilename(type, id, contentType)');
    expect(CLIENT_JS_BUNDLE).toContain('a.download = resolveArtifactFilename(art.type, art.id, art.contentType);');
  });
});

import { execution, journey, netEvent } from '../fixtures/executionReports.js';

describe('Build 12G.1 Item 3: Controlled Fixture DUPLICATE_REQUEST Anomaly Review', () => {
  it('accurately identifies synthetic repeated document requests without suppression', () => {
    // Initial page load request + step-001 navigate request
    const events: EvidenceNetworkEvent[] = [
      netEvent({
        method: 'GET',
        url: 'http://127.0.0.1:3230/health',
        path: '/health',
        status: 200,
        resourceType: 'document',
      }),
      netEvent({
        method: 'GET',
        url: 'http://127.0.0.1:3230/health',
        path: '/health',
        status: 200,
        resourceType: 'document',
      }),
    ];

    const report = buildAnomalyReport({
      execution: execution({
        rawEvidence: { ...execution().rawEvidence, networkEvents: events },
      }),
      executionPath: 'runs/test/execution.json',
      journey: journey(),
      journeyPath: 'journeys/test.json',
    });

    // Confirms genuine repeated document requests are detected and NOT suppressed
    expect(report.summary.totalSignals).toBe(1);
    expect(report.summary.duplicateRequestSignals).toBe(1);

    const dupSignal = report.anomalies.find(a => a.ruleId === RULE_IDS.duplicateRequest);
    expect(dupSignal).toBeDefined();
    expect(dupSignal?.kind).toBe('duplicate-request');
    expect(dupSignal?.signalLevel).toBe('info');
    expect(dupSignal?.details['count']).toBe(2);
    expect(dupSignal?.details['resourceType']).toBe('document');
    // Document repeats are not asset-like, so possiblyExpected remains false
    expect(dupSignal?.possiblyExpected).toBe(false);
  });

  it('marks repeated asset requests as possiblyExpected', () => {
    const events: EvidenceNetworkEvent[] = [
      netEvent({
        method: 'GET',
        url: 'http://127.0.0.1:3230/static/logo.png',
        path: '/static/logo.png',
        status: 200,
        resourceType: 'image',
      }),
      netEvent({
        method: 'GET',
        url: 'http://127.0.0.1:3230/static/logo.png',
        path: '/static/logo.png',
        status: 200,
        resourceType: 'image',
      }),
    ];

    const report = buildAnomalyReport({
      execution: execution({
        rawEvidence: { ...execution().rawEvidence, networkEvents: events },
      }),
      executionPath: 'runs/test/execution.json',
      journey: journey(),
      journeyPath: 'journeys/test.json',
    });

    expect(report.summary.duplicateRequestSignals).toBe(1);
    const dupSignal = report.anomalies.find(a => a.ruleId === RULE_IDS.duplicateRequest);
    expect(dupSignal?.possiblyExpected).toBe(true);
  });

  it('emits zero duplicate signals when network requests are unique', () => {
    const events: EvidenceNetworkEvent[] = [
      netEvent({
        method: 'GET',
        url: 'http://127.0.0.1:3230/health',
        path: '/health',
        status: 200,
        resourceType: 'document',
      }),
      netEvent({
        method: 'GET',
        url: 'http://127.0.0.1:3230/api/version',
        path: '/api/version',
        status: 200,
        resourceType: 'xhr',
      }),
    ];

    const report = buildAnomalyReport({
      execution: execution({
        rawEvidence: { ...execution().rawEvidence, networkEvents: events },
      }),
      executionPath: 'runs/test/execution.json',
      journey: journey(),
      journeyPath: 'journeys/test.json',
    });

    expect(report.summary.totalSignals).toBe(0);
    expect(report.summary.duplicateRequestSignals).toBe(0);
    expect(report.anomalies).toHaveLength(0);
  });
});
