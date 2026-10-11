/**
 * Unit Tests for Review UI API Client (Build 9.2).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReviewApiClient, ReadOnlyApiError } from '../../src/reviewUi/apiClient.js';

describe('Review UI: API Client Read-Only Enforcement', () => {
  let client: ReviewApiClient;

  beforeEach(() => {
    client = new ReviewApiClient('http://127.0.0.1:3210');
  });

  it('rejects all mutation methods immediately without issuing requests', async () => {
    // Attempt POST
    await expect(
      // @ts-expect-error testing runtime refusal of illegal method
      client.request('/api/candidates', { method: 'POST' }),
    ).rejects.toThrow('strictly read-only');

    // Attempt PUT
    await expect(
      // @ts-expect-error testing runtime refusal of illegal method
      client.request('/api/candidates/cand-1', { method: 'PUT' }),
    ).rejects.toThrow('strictly read-only');

    // Attempt PATCH
    await expect(
      // @ts-expect-error testing runtime refusal of illegal method
      client.request('/api/candidates/cand-1', { method: 'PATCH' }),
    ).rejects.toThrow('strictly read-only');

    // Attempt DELETE
    await expect(
      // @ts-expect-error testing runtime refusal of illegal method
      client.request('/api/candidates/cand-1', { method: 'DELETE' }),
    ).rejects.toThrow('strictly read-only');
  });

  it('fetches summary via GET request', async () => {
    const mockSummary = {
      schemaVersion: '1.0',
      totalCandidates: 3,
      byClassification: { novel: 2, persistent: 1 },
      byReviewStatus: { unreviewed: 3 },
      requiringInvestigation: 2,
      reproducedCount: 1,
      unknownCount: 0,
      withLimitationsCount: 0,
      baseline: null,
      reviewState: { candidateCount: 0, updatedAt: null },
      provenance: {
        targetOrigin: 'http://127.0.0.1',
        journeyHash: 'sha256:abc',
        applicationBuildId: null,
        environmentFingerprint: null,
      },
      interpretation: {
        confirmedBug: false as const,
        automaticSeverity: false as const,
        note: 'leads',
      },
    };

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => mockSummary,
    } as Response);

    const result = await client.getSummary();
    expect(result).toEqual(mockSummary);
    expect(fetchSpy).toHaveBeenCalledWith('http://127.0.0.1:3210/api/summary', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });

    fetchSpy.mockRestore();
  });

  it('builds query parameters correctly for getCandidates', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ totalCount: 0, candidates: [] }),
    } as Response);

    await client.getCandidates({
      classification: 'novel',
      reviewStatus: 'open',
      kind: 'http',
      limit: 10,
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:3210/api/candidates?classification=novel&reviewStatus=open&kind=http&limit=10',
      {
        method: 'GET',
        headers: { Accept: 'application/json' },
      },
    );

    fetchSpy.mockRestore();
  });

  it('parses structured API errors into ReadOnlyApiError', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({
        error: {
          code: 'candidate-not-found',
          message: 'Candidate cand-999 not found',
        },
      }),
    } as Response);

    await expect(client.getCandidateDetail('cand-999')).rejects.toThrow(ReadOnlyApiError);

    fetchSpy.mockRestore();
  });
});
