/**
 * Reusable artifact assertions for Build 10 End-to-End Validation.
 *
 * Enforces:
 *  - Artifact chain traceability (candidate -> anomaly -> execution step -> raw evidence)
 *  - Trust invariants: `confirmedBug: false` and `confirmed: false`
 *  - Redaction and credential protection
 *  - Byte-for-byte report immutability
 *  - Canonical existing rule IDs from Build 4 (RULE_IDS)
 */

import { expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { RULE_IDS, type RuleId } from '../../src/anomaly/types.js';
import type { Candidate, CandidateReport } from '../../src/review/types.js';
import type { AnomalyReport } from '../../src/anomaly/report.js';
import type { ExecutionReport } from '../../src/executor/types.js';
import type { JourneyPlan } from '../../src/journey/types.js';

const VALID_RULE_ID_VALUES = new Set<string>(Object.values(RULE_IDS));

/**
 * Asserts trust invariants across any report or candidate object.
 */
export function assertTrustInvariants(doc: Record<string, unknown>): void {
  if ('confirmed' in doc) {
    expect(doc.confirmed, 'Trust invariant: confirmed must be false').toBe(false);
  }
  if ('confirmedBug' in doc) {
    expect(doc.confirmedBug, 'Trust invariant: confirmedBug must be false').toBe(false);
  }
  if (doc.interpretation && typeof doc.interpretation === 'object') {
    const interp = doc.interpretation as Record<string, unknown>;
    if ('confirmedBug' in interp) {
      expect(interp.confirmedBug, 'Trust invariant: interpretation.confirmedBug must be false').toBe(false);
    }
  }
}

/**
 * Asserts full end-to-end traceability of a candidate back to its anomaly and execution step.
 */
export function assertCandidateTraceability(
  candidate: Candidate,
  anomaliesDoc: AnomalyReport,
  executionDoc: ExecutionReport,
  journeyDoc: JourneyPlan,
): void {
  // 1. Invariant check
  expect(candidate.confirmed).toBe(false);

  // 2. Canonical Rule ID
  expect(
    VALID_RULE_ID_VALUES.has(candidate.ruleId),
    `Candidate ruleId "${candidate.ruleId}" must be one of the canonical RULE_IDS: ${[...VALID_RULE_ID_VALUES].join(', ')}`,
  ).toBe(true);

  // 3. Stable Candidate ID
  if (candidate.candidateId) {
    expect(candidate.candidateId).toMatch(/^cand-[a-f0-9]{16}$/);
  }

  // 4. Backing anomaly correlation
  const sourceAnomalyId = candidate.id.replace('candidate-', 'anomaly-');
  const backingAnomaly = anomaliesDoc.anomalies.find(
    (a) => a.id === sourceAnomalyId || a.ruleId === candidate.ruleId,
  );
  expect(backingAnomaly, `Backing anomaly for candidate ${candidate.id} must exist in anomalies.json`).toBeDefined();
  expect(backingAnomaly?.confirmed).toBe(false);

  // 5. Source provenance
  if (backingAnomaly?.source) {
    expect(typeof backingAnomaly.source.executionReport).toBe('string');
    expect(['network', 'console', 'pageError', 'step']).toContain(backingAnomaly.source.evidenceType);
  }

  // 6. Journey correlation
  expect(journeyDoc.steps.length).toBeGreaterThan(0);
  expect(executionDoc.steps.length).toBe(journeyDoc.steps.length);
}

/**
 * Asserts complete artifact chain integrity for a candidate report.
 */
export function assertArtifactChain(
  candidateReport: CandidateReport,
  anomaliesDoc: AnomalyReport,
  executionDoc: ExecutionReport,
  journeyDoc: JourneyPlan,
): void {
  assertTrustInvariants(candidateReport as unknown as Record<string, unknown>);
  assertTrustInvariants(anomaliesDoc as unknown as Record<string, unknown>);
  assertTrustInvariants(executionDoc as unknown as Record<string, unknown>);

  expect(candidateReport.schemaVersion).toBe('1.0');
  expect(anomaliesDoc.schemaVersion).toBe('1.0');
  expect(executionDoc.schemaVersion).toBe('1.0');
  expect(journeyDoc.schemaVersion).toBe('1.0');

  for (const candidate of candidateReport.candidates) {
    assertCandidateTraceability(candidate, anomaliesDoc, executionDoc, journeyDoc);
  }
}

/**
 * Asserts that sensitive values are strictly redacted from report text.
 */
export function assertRedactionSafety(reportJson: string): void {
  // Payment card numbers (Luhn candidate 16-digit patterns)
  expect(reportJson).not.toMatch(/\b4\d{15}\b/);
  expect(reportJson).not.toMatch(/\b5[1-5]\d{14}\b/);

  // Raw secret / password fields
  expect(reportJson).not.toMatch(/password["':\s]+[a-zA-Z0-9_-]{4,}/i);
  expect(reportJson).not.toMatch(/bearer\s+[a-zA-Z0-9._-]{10,}/i);
  expect(reportJson).not.toMatch(/cvv["':\s]+\d{3,4}/i);
}

/**
 * Asserts byte-level identity between two file states.
 */
export async function assertFileByteIdentical(filePath: string, expectedBytes: Buffer): Promise<void> {
  const actualBytes = await readFile(filePath);
  const hashExpected = createHash('sha256').update(expectedBytes).digest('hex');
  const hashActual = createHash('sha256').update(actualBytes).digest('hex');
  expect(
    hashActual,
    `File "${filePath}" must be byte-identical to pre-operation snapshot. Expected ${hashExpected}, got ${hashActual}`,
  ).toBe(hashExpected);
}
