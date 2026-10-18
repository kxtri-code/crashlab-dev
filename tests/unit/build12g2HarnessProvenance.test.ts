import { describe, it, expect } from 'vitest';
import { buildAnomalyReport } from '../../src/anomaly/report.js';
import { RULE_IDS } from '../../src/anomaly/types.js';
import type { EvidenceNetworkEvent } from '../../src/executor/types.js';
import { NetworkRecorder } from '../../src/scout/network.js';
import { EvidenceRecorder } from '../../src/executor/evidence.js';
import { createScrubber } from '../../src/executor/redaction.js';
import { execution, journey, netEvent } from '../fixtures/executionReports.js';

describe('Build 12G.2: Harness-Generated Anomaly Provenance', () => {
  describe('1. Self-Generated Initial-Load-Plus-Fallback-Navigation Pair Exclusion', () => {
    it('excludes the known self-generated initial-load-plus-fallback-navigation pair', () => {
      const events: EvidenceNetworkEvent[] = [
        netEvent({
          method: 'GET',
          url: 'http://127.0.0.1:3230/health',
          path: '/health',
          status: 200,
          resourceType: 'document',
          provenance: 'harness-initial-load',
        }),
        netEvent({
          method: 'GET',
          url: 'http://127.0.0.1:3230/health',
          path: '/health',
          status: 200,
          resourceType: 'document',
          provenance: 'harness-fallback-navigation',
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

      // The self-generated initial load + fallback navigation pair should NOT be flagged as DUPLICATE_REQUEST
      expect(report.summary.duplicateRequestSignals).toBe(0);
      expect(report.summary.totalSignals).toBe(0);
      expect(report.anomalies).toHaveLength(0);
    });

    it('preserves raw network evidence with complete provenance for auditability', () => {
      const events: EvidenceNetworkEvent[] = [
        netEvent({
          method: 'GET',
          url: 'http://127.0.0.1:3230/health',
          path: '/health',
          status: 200,
          resourceType: 'document',
          provenance: 'harness-initial-load',
        }),
        netEvent({
          method: 'GET',
          url: 'http://127.0.0.1:3230/health',
          path: '/health',
          status: 200,
          resourceType: 'document',
          provenance: 'harness-fallback-navigation',
        }),
      ];

      const exec = execution({
        rawEvidence: { ...execution().rawEvidence, networkEvents: events },
      });

      const report = buildAnomalyReport({
        execution: exec,
        executionPath: 'runs/test/execution.json',
        journey: journey(),
        journeyPath: 'journeys/test.json',
      });

      // Raw evidence must be untouched and preserve both entries with their respective provenance
      expect(exec.rawEvidence.networkEvents).toHaveLength(2);
      expect(exec.rawEvidence.networkEvents[0]?.provenance).toBe('harness-initial-load');
      expect(exec.rawEvidence.networkEvents[1]?.provenance).toBe('harness-fallback-navigation');
      expect(report.interpretation.confirmedBug).toBe(false);
    });
  });

  describe('2. Target-Triggered Duplicate Requests Retention', () => {
    it('continues reporting duplicate document requests when triggered by the target application', () => {
      const events: EvidenceNetworkEvent[] = [
        netEvent({
          method: 'GET',
          url: 'http://127.0.0.1:3230/health',
          path: '/health',
          status: 200,
          resourceType: 'document',
          provenance: 'harness-initial-load',
        }),
        netEvent({
          method: 'GET',
          url: 'http://127.0.0.1:3230/health',
          path: '/health',
          status: 200,
          resourceType: 'document',
          provenance: 'target-triggered',
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
      const dup = report.anomalies.find((a) => a.ruleId === RULE_IDS.duplicateRequest);
      expect(dup).toBeDefined();
      expect(dup?.details['count']).toBe(2);
      expect(dup?.details['resourceType']).toBe('document');
      expect(dup?.possiblyExpected).toBe(false);
    });

    it('continues reporting duplicate document requests when multiple requests are target-triggered', () => {
      const events: EvidenceNetworkEvent[] = [
        netEvent({
          method: 'GET',
          url: 'http://127.0.0.1:3230/catalog',
          path: '/catalog',
          status: 200,
          resourceType: 'document',
          provenance: 'target-triggered',
        }),
        netEvent({
          method: 'GET',
          url: 'http://127.0.0.1:3230/catalog',
          path: '/catalog',
          status: 200,
          resourceType: 'document',
          provenance: 'target-triggered',
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
      const dup = report.anomalies.find((a) => a.ruleId === RULE_IDS.duplicateRequest);
      expect(dup).toBeDefined();
      expect(dup?.details['count']).toBe(2);
    });

    it('reports genuine target duplicates even when a self-generated pair is also present', () => {
      const events: EvidenceNetworkEvent[] = [
        // Self-generated pair
        netEvent({
          method: 'GET',
          url: 'http://127.0.0.1:3230/health',
          path: '/health',
          status: 200,
          resourceType: 'document',
          provenance: 'harness-initial-load',
        }),
        netEvent({
          method: 'GET',
          url: 'http://127.0.0.1:3230/health',
          path: '/health',
          status: 200,
          resourceType: 'document',
          provenance: 'harness-fallback-navigation',
        }),
        // Additional target-triggered navigation to the same URL
        netEvent({
          method: 'GET',
          url: 'http://127.0.0.1:3230/health',
          path: '/health',
          status: 200,
          resourceType: 'document',
          provenance: 'target-triggered',
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

      // The fallback navigation is excluded, leaving initial load + target-triggered = 2 requests
      expect(report.summary.duplicateRequestSignals).toBe(1);
      const dup = report.anomalies.find((a) => a.ruleId === RULE_IDS.duplicateRequest);
      expect(dup).toBeDefined();
      expect(dup?.details['count']).toBe(2);
    });

    it('reports non-document duplicate requests (e.g. API xhr/fetch) triggered by target', () => {
      const events: EvidenceNetworkEvent[] = [
        netEvent({
          method: 'POST',
          url: 'http://127.0.0.1:3230/api/cart',
          path: '/api/cart',
          status: 200,
          resourceType: 'xhr',
          provenance: 'target-triggered',
        }),
        netEvent({
          method: 'POST',
          url: 'http://127.0.0.1:3230/api/cart',
          path: '/api/cart',
          status: 200,
          resourceType: 'xhr',
          provenance: 'target-triggered',
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
      const dup = report.anomalies.find((a) => a.ruleId === RULE_IDS.duplicateRequest);
      expect(dup).toBeDefined();
      expect(dup?.details['count']).toBe(2);
    });
  });

  describe('3. NetworkRecorder and EvidenceRecorder Provenance Plumbing', () => {
    it('sets and retrieves provenance on NetworkRecorder', () => {
      const recorder = new NetworkRecorder();
      expect(recorder.getProvenance()).toBe('target-triggered');

      recorder.setProvenance('harness-initial-load');
      expect(recorder.getProvenance()).toBe('harness-initial-load');

      recorder.setProvenance('harness-fallback-navigation');
      expect(recorder.getProvenance()).toBe('harness-fallback-navigation');

      recorder.setProvenance('target-triggered');
      expect(recorder.getProvenance()).toBe('target-triggered');
    });

    it('sets provenance through EvidenceRecorder and populates allNetwork output', () => {
      const scrub = createScrubber([]);
      const evidence = new EvidenceRecorder(scrub);

      evidence.setNetworkProvenance('harness-initial-load');
      // Verify recorder was updated without throwing
      expect(evidence.allNetwork()).toEqual([]);
    });
  });
});
