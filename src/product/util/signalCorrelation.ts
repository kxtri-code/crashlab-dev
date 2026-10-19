/**
 * Signal Correlation & Duplicate Guidance Utility — Build 12K.1.
 *
 * Correlates related candidate defect findings (e.g., HTTP 500 server error
 * and its downstream browser console errors) so operators understand they represent
 * one underlying defect cascade rather than multiple independent product faults.
 *
 * Invariant Preservation:
 * - confirmedBug: false
 * - confirmed: false
 * - Raw evidence and logs are always preserved.
 */

import type { CandidateReference } from '../types/candidate.js';

export interface CorrelatedFindingGroup {
  readonly groupId: string;
  readonly correlationType: 'http_5xx_cascade' | 'network_error_cascade';
  readonly primaryRuleId: string;
  readonly primaryCandidateId: string;
  readonly secondaryCandidateIds: readonly string[];
  readonly title: string;
  readonly explanation: string;
  readonly duplicateGuidance: string;
}

export interface CorrelationAnalysisResult {
  readonly hasCorrelatedSignals: boolean;
  readonly groups: readonly CorrelatedFindingGroup[];
  readonly candidateCorrelationMap: Readonly<Record<string, {
    readonly isPrimary: boolean;
    readonly primaryCandidateId: string;
    readonly groupId: string;
    readonly label: string;
  }>>;
}

/**
 * Analyzes candidate findings for a run and identifies correlated cascades.
 */
export function analyzeSignalCorrelation(
  candidates: readonly CandidateReference[],
): CorrelationAnalysisResult {
  if (!candidates || candidates.length <= 1) {
    return {
      hasCorrelatedSignals: false,
      groups: [],
      candidateCorrelationMap: {},
    };
  }

  // Look for HTTP 5XX candidates
  const http5xxCandidates = candidates.filter(
    (c) =>
      c.ruleId.toUpperCase().includes('5XX') ||
      c.ruleId.toUpperCase().includes('HTTP_5') ||
      c.classification.toUpperCase().includes('500') ||
      c.classification.toUpperCase().includes('HTTP_5XX'),
  );

  // Look for downstream console error candidates
  const consoleErrorCandidates = candidates.filter(
    (c) =>
      c.ruleId.toUpperCase().includes('CONSOLE') ||
      c.classification.toUpperCase().includes('CONSOLE'),
  );

  // Look for network failure candidates
  const networkFailureCandidates = candidates.filter(
    (c) =>
      c.ruleId.toUpperCase().includes('NETWORK') ||
      c.classification.toUpperCase().includes('NETWORK'),
  );

  const groups: CorrelatedFindingGroup[] = [];
  const correlationMap: Record<string, {
    isPrimary: boolean;
    primaryCandidateId: string;
    groupId: string;
    label: string;
  }> = {};

  // Case 1: HTTP 5XX triggers console errors
  if (http5xxCandidates.length > 0 && consoleErrorCandidates.length > 0) {
    const primary = http5xxCandidates[0]!;
    const secondaries = consoleErrorCandidates.filter((c) => c.id !== primary.id);

    if (secondaries.length > 0) {
      const groupId = `group-http500-${primary.id.slice(0, 8)}`;
      groups.push({
        groupId,
        correlationType: 'http_5xx_cascade',
        primaryRuleId: primary.ruleId,
        primaryCandidateId: primary.id,
        secondaryCandidateIds: secondaries.map((s) => s.id),
        title: 'Server Fault Defect Cascade (HTTP 500 & Client Console Errors)',
        explanation:
          'An HTTP 500 Internal Server Error was observed alongside browser console errors during journey execution. ' +
          'When the server fails with status 500, downstream client-side fetch or XHR requests fail and emit errors to the browser console. ' +
          'These signals likely represent one underlying issue rather than multiple independent defects.',
        duplicateGuidance:
          'Before marking secondary console error findings as "Duplicate": verify that they occurred as a direct result ' +
          'of the failed HTTP 500 request. Marking as duplicate links the findings and prevents double-counting without altering ' +
          'raw evidence, logs, or trust invariants (confirmedBug: false, confirmed: false).',
      });

      correlationMap[primary.id] = {
        isPrimary: true,
        primaryCandidateId: primary.id,
        groupId,
        label: 'Primary Root Cause (Server HTTP 500)',
      };

      for (const sec of secondaries) {
        correlationMap[sec.id] = {
          isPrimary: false,
          primaryCandidateId: primary.id,
          groupId,
          label: `Downstream cascade of ${primary.ruleId} (${primary.id.slice(0, 10)})`,
        };
      }
    }
  }

  return {
    hasCorrelatedSignals: groups.length > 0,
    groups,
    candidateCorrelationMap: correlationMap,
  };
}
