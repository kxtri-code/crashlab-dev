import { describe, expect, it } from 'vitest';
import {
  canonicalizeFingerprintInputs,
  computeFingerprint,
  fingerprintPayload,
  hashFixture,
  nodeMajorMinor,
  FINGERPRINT_FIELDS,
} from '../../src/provenance/fingerprint.js';
import {
  sanitizeAppBuildId,
  sanitizeDataId,
  sanitizeEnvironmentId,
  sanitizeIdentifier,
  safeTargetOrigin,
  safeVersion,
} from '../../src/provenance/redaction.js';
import {
  buildEnvironmentProvenance,
  collectRuntimeProvenance,
  provenanceFromReport,
  toEnvironmentReference,
} from '../../src/provenance/reportMetadata.js';
import { compareEnvironments, describeComparison } from '../../src/provenance/comparison.js';
import { PROVENANCE_SCHEMA_VERSION, UnsafeIdentifierError, MAX_IDENTIFIER_LENGTH } from '../../src/provenance/types.js';
import type { EnvironmentReference, FingerprintInput } from '../../src/provenance/types.js';
import type { ProvenanceFacts } from '../../src/provenance/reportMetadata.js';

/** Baseline fingerprint inputs, valid for every assertion. */
function inputs(overrides: Partial<FingerprintInput> = {}): Partial<FingerprintInput> {
  return {
    targetOrigin: 'https://staging.example.test',
    browserName: 'chromium',
    browserVersion: '153.0.8010.12',
    nodeMajorMinor: '22.23',
    platform: 'win32',
    architecture: 'x64',
    headless: true,
    safeTestMode: true,
    timeoutMs: 15000,
    journeySchemaVersion: '1.0',
    executorVersion: '0.1.0',
    plannerVersion: '0.1.0',
    applicationBuildId: 'build-001',
    environmentId: 'local-shop',
    testDataFixtureId: 'fixture-v1',
    ...overrides,
  };
}

/** Baseline provenance facts. */
function facts(overrides: Partial<ProvenanceFacts> = {}): ProvenanceFacts {
  return {
    targetUrl: 'https://staging.example.test/checkout?token=supersecret',
    browserVersion: '153.0.8010.12',
    headless: true,
    timeoutMs: 15000,
    safeTestMode: true,
    journeySchemaVersion: '1.0',
    testDataFixtureHash: null,
    ...overrides,
  };
}

describe('identifier validation', () => {
  it('accepts a short opaque identifier', () => {
    expect(sanitizeEnvironmentId('local-shop')).toBe('local-shop');
    expect(sanitizeAppBuildId('build-001')).toBe('build-001');
    expect(sanitizeDataId('fake_fixture.v1')).toBe('fake_fixture.v1');
  });

  it('treats absent or empty values as null rather than erroring', () => {
    for (const value of [null, undefined, '', '   ']) {
      expect(sanitizeEnvironmentId(value)).toBeNull();
    }
  });

  it('rejects a filesystem path rather than trimming it', () => {
    // A quiet trim would half-write a local path into a durable report.
    expect(() => sanitizeEnvironmentId('C:\\Users\\someone')).toThrow(UnsafeIdentifierError);
    expect(() => sanitizeEnvironmentId('/home/someone/shop')).toThrow(/filesystem separators/);
  });

  it('rejects a URL', () => {
    expect(() => sanitizeEnvironmentId('https://example.test')).toThrow(/a URL/);
  });

  it('rejects an authorization value or token', () => {
    expect(() => sanitizeEnvironmentId('Bearer abcdef123456')).toThrow();
    expect(() => sanitizeEnvironmentId('eyJhbGciOiJIUzI1NiJ9abcdef')).toThrow(/a token/);
  });

  it('rejects a card number', () => {
    expect(() => sanitizeIdentifier('4242424242424242', 'test id')).toThrow(/card number/);
  });

  it('rejects a credential-like assignment and whitespace', () => {
    expect(() => sanitizeIdentifier('token=abc', 'test id')).toThrow();
    expect(() => sanitizeIdentifier('has space', 'test id')).toThrow();
  });

  it('rejects an over-long identifier', () => {
    expect(() => sanitizeEnvironmentId('a'.repeat(MAX_IDENTIFIER_LENGTH + 1))).toThrow(/exceeds/);
  });

  it('accepts one at exactly the limit', () => {
    expect(sanitizeEnvironmentId('a'.repeat(MAX_IDENTIFIER_LENGTH))).toHaveLength(MAX_IDENTIFIER_LENGTH);
  });
});

describe('safe target origin', () => {
  it('reduces a URL to its origin', () => {
    expect(safeTargetOrigin('https://example.test/checkout?token=abc#frag')).toEqual({
      origin: 'https://example.test',
      unresolved: false,
    });
  });

  it('removes the query string entirely', () => {
    expect(safeTargetOrigin('https://example.test/p?password=hunter2').origin).toBe('https://example.test');
  });

  it('removes the hash fragment', () => {
    expect(safeTargetOrigin('https://example.test/p#secret-anchor').origin).toBe('https://example.test');
  });

  it('keeps a distinguishing port', () => {
    expect(safeTargetOrigin('http://127.0.0.1:8080/x').origin).toBe('http://127.0.0.1:8080');
  });

  it('never exposes a file path', () => {
    const result = safeTargetOrigin('file:///C:/Users/someone/secret/page.html');
    expect(result.origin).not.toContain('someone');
    expect(result.origin).not.toContain('secret');
  });

  it('marks an unparseable target unresolved rather than guessing', () => {
    expect(safeTargetOrigin('not a url')).toEqual({ origin: null, unresolved: true });
    expect(safeTargetOrigin(null)).toEqual({ origin: null, unresolved: true });
  });
});

describe('fingerprint determinism', () => {
  it('produces the same fingerprint for the same inputs', () => {
    expect(computeFingerprint(inputs())).toBe(computeFingerprint(inputs()));
  });

  it('produces a stable fingerprint across many calls', () => {
    const first = computeFingerprint(inputs());
    for (let i = 0; i < 5; i++) expect(computeFingerprint(inputs())).toBe(first);
  });

  it('changes when the browser version changes', () => {
    expect(computeFingerprint(inputs({ browserVersion: '154.0.0.0' }))).not.toBe(computeFingerprint(inputs()));
  });

  it('changes when the application build ID changes', () => {
    expect(computeFingerprint(inputs({ applicationBuildId: 'build-002' }))).not.toBe(computeFingerprint(inputs()));
  });

  it('changes when the environment ID changes', () => {
    expect(computeFingerprint(inputs({ environmentId: 'other-shop' }))).not.toBe(computeFingerprint(inputs()));
  });

  it('changes when the safe-test configuration changes', () => {
    expect(computeFingerprint(inputs({ safeTestMode: false }))).not.toBe(computeFingerprint(inputs()));
  });

  it('is unaffected by attempt number, which is not an input at all', () => {
    // Attempt identity lives in the report, never in the fingerprint inputs.
    const payload = fingerprintPayload(inputs());
    expect(payload).not.toMatch(/attempt/i);
  });

  it('is unaffected by timestamps, which are not an input at all', () => {
    const payload = fingerprintPayload(inputs());
    expect(payload).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('uses a fixed field order, so key ordering cannot change the hash', () => {
    const reordered = Object.fromEntries(Object.entries(inputs()).reverse());
    expect(computeFingerprint(reordered)).toBe(computeFingerprint(inputs()));
  });

  it('represents missing optional metadata consistently', () => {
    // Absent and explicitly null must hash identically, so two runs with the
    // same declared provenance compare equal.
    const absent = canonicalizeFingerprintInputs({ targetOrigin: 'https://a.test' });
    const explicit = canonicalizeFingerprintInputs({ targetOrigin: 'https://a.test', applicationBuildId: null });
    expect(absent.applicationBuildId).toBeNull();
    expect(explicit).toEqual(absent);
    expect(computeFingerprint({ targetOrigin: 'https://a.test' })).toBe(
      computeFingerprint({ targetOrigin: 'https://a.test', applicationBuildId: null }),
    );
  });

  it('includes every declared fingerprint field', () => {
    const canonical = canonicalizeFingerprintInputs(inputs());
    expect(Object.keys(canonical).sort()).toEqual([...FINGERPRINT_FIELDS].sort());
  });

  it('returns null when there is nothing to fingerprint', () => {
    // A hash of nothing is a stable string that means nothing.
    expect(computeFingerprint({})).toBeNull();
  });

  it('produces a sha256-prefixed digest', () => {
    expect(computeFingerprint(inputs())).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('runtime and version helpers', () => {
  it('collects safe runtime facts with no path or environment dump', () => {
    const runtime = collectRuntimeProvenance();
    expect(runtime.nodeVersion).toBe(process.versions.node);
    expect(runtime.platform).toBe(process.platform);
    expect(runtime.architecture).toBe(process.arch);
    const serialized = JSON.stringify(runtime);
    expect(serialized).not.toMatch(/[\\/]|[A-Z]:|process\.env|home/i);
  });

  it('reduces a version to major.minor, so a patch bump is the same environment', () => {
    expect(nodeMajorMinor('v22.23.2')).toBe('22.23');
    expect(nodeMajorMinor('22.23.2')).toBe('22.23');
    expect(nodeMajorMinor('v24.0.0')).toBe('24.0');
  });

  it('coerces an absent version to a fallback', () => {
    expect(safeVersion(undefined)).toBe('unknown');
    expect(safeVersion('')).toBe('unknown');
    expect(safeVersion(' 1.2.3 ')).toBe('1.2.3');
  });

  it('hashes fixture bytes deterministically', () => {
    const bytes = new TextEncoder().encode('{"email":"a@b.test"}');
    expect(hashFixture(bytes)).toBe(hashFixture(bytes));
    expect(hashFixture(bytes)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('provenance assembly', () => {
  it('assembles every documented section', () => {
    const provenance = buildEnvironmentProvenance(
      facts(),
      collectRuntimeProvenance(),
      { environmentId: 'local-shop', appBuildId: 'build-001', dataId: 'fixture-v1' },
    );

    expect(provenance.schemaVersion).toBe(PROVENANCE_SCHEMA_VERSION);
    expect(provenance.target).toBeDefined();
    expect(provenance.runtime).toBeDefined();
    expect(provenance.browser).toBeDefined();
    expect(provenance.configuration).toBeDefined();
    expect(provenance.source).toBeDefined();
    expect(provenance.application).toEqual({ buildId: 'build-001', environmentId: 'local-shop' });
    expect(provenance.testData).toEqual({ fixtureId: 'fixture-v1', fixtureHash: null });
    expect(provenance.fingerprint).toMatch(/^sha256:/);
  });

  it('records null for identifiers the caller did not supply', () => {
    const provenance = buildEnvironmentProvenance(facts(), collectRuntimeProvenance());
    expect(provenance.application).toEqual({ buildId: null, environmentId: null });
    expect(provenance.testData.fixtureHash).toBeNull();
  });

  it('records a fixture hash only when the caller opted in', () => {
    const bytes = new TextEncoder().encode('{"password":"x"}');
    const without = buildEnvironmentProvenance(
      facts({ testDataFixtureHash: hashFixture(bytes) }),
      collectRuntimeProvenance(),
    );
    const with_ = buildEnvironmentProvenance(
      facts({ testDataFixtureHash: hashFixture(bytes) }),
      collectRuntimeProvenance(),
      { hashTestData: true },
    );
    // Opt-in: a hash is an identity marker, not secret protection, so it is
    // never taken without being asked for.
    expect(without.testData.fixtureHash).toBeNull();
    expect(with_.testData.fixtureHash).toMatch(/^sha256:/);
  });

  it('never records the fixture path or its contents', () => {
    const provenance = buildEnvironmentProvenance(
      facts({ testDataFixtureHash: hashFixture(new TextEncoder().encode('{"password":"hunter2"}')) }),
      collectRuntimeProvenance(),
      { dataId: 'fixture-v1', hashTestData: true },
    );
    const serialized = JSON.stringify(provenance);
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toMatch(/[A-Z]:\\|\.json\b/);
  });

  it('refuses an unsafe caller identifier rather than writing it', () => {
    expect(() =>
      buildEnvironmentProvenance(facts(), collectRuntimeProvenance(), {
        environmentId: 'C:\\Users\\someone\\shop',
      }),
    ).toThrow(UnsafeIdentifierError);
  });

  it('never records a token or query value from the target URL', () => {
    const provenance = buildEnvironmentProvenance(
      facts({ targetUrl: 'https://staging.example.test/checkout?token=supersecret#frag' }),
      collectRuntimeProvenance(),
    );
    const serialized = JSON.stringify(provenance);
    expect(serialized).not.toContain('supersecret');
    expect(serialized).not.toContain('checkout');
    expect(provenance.target.origin).toBe('https://staging.example.test');
  });

  it('never records a username, home directory, or absolute path', () => {
    const provenance = buildEnvironmentProvenance(
      facts({ targetUrl: `file:///C:/Users/someone/private/page.html` }),
      collectRuntimeProvenance(),
    );
    const serialized = JSON.stringify(provenance);
    expect(serialized).not.toContain('someone');
    expect(serialized).not.toContain('private');
    expect(serialized).not.toMatch(/[A-Z]:\\\\/);
  });

  it('carries no secret, password, cookie, or payment field', () => {
    const provenance = buildEnvironmentProvenance(facts(), collectRuntimeProvenance(), {
      environmentId: 'local-shop',
    });
    const serialized = JSON.stringify(provenance).toLowerCase();
    for (const forbidden of ['password', 'cookie', 'authorization', 'card', 'cvv', 'ssn', 'token']) {
      expect(serialized, forbidden).not.toContain(forbidden);
    }
  });
});

describe('environment reference', () => {
  it('summarizes a provenance record', () => {
    const provenance = buildEnvironmentProvenance(facts(), collectRuntimeProvenance(), {
      environmentId: 'local-shop',
      appBuildId: 'build-001',
    });
    const reference = toEnvironmentReference(provenance);
    expect(reference.fingerprint).toBe(provenance.fingerprint);
    expect(reference.origin).toBe('https://staging.example.test');
    expect(reference.environmentId).toBe('local-shop');
    expect(reference.applicationBuildId).toBe('build-001');
  });

  it('returns an all-null reference for absent provenance', () => {
    // Legacy compatibility: absent reads as unknown, never invented.
    const reference = toEnvironmentReference(null);
    expect(reference.fingerprint).toBeNull();
    expect(reference.origin).toBeNull();
    expect(reference.environmentId).toBeNull();
    expect(reference.browserName).toBe('unknown');
  });

  it('reads provenance off a report, tolerating absence', () => {
    expect(provenanceFromReport({ environment: { fingerprint: 'sha256:x' } })).not.toBeNull();
    expect(provenanceFromReport({})).toBeNull();
    expect(provenanceFromReport(null)).toBeNull();
    expect(provenanceFromReport('nope')).toBeNull();
  });
});

describe('environment comparison', () => {
  const original: EnvironmentReference = {
    fingerprint: 'sha256:aaa',
    origin: 'https://a.test',
    browserName: 'chromium',
    browserVersion: '153.0',
    environmentId: 'local-shop',
    applicationBuildId: 'build-001',
  };

  it('is same when every attempt matches the original', () => {
    const result = compareEnvironments(original, [
      { attempt: 1, fingerprint: 'sha256:aaa', environmentId: 'local-shop', applicationBuildId: 'build-001' },
      { attempt: 2, fingerprint: 'sha256:aaa', environmentId: 'local-shop', applicationBuildId: 'build-001' },
    ]);
    expect(result.classification).toBe('same');
    expect(result.differences).toEqual([]);
  });

  it('is different and names a changed identifier', () => {
    const result = compareEnvironments(original, [
      { attempt: 1, fingerprint: 'sha256:bbb', environmentId: 'local-shop', applicationBuildId: 'build-002' },
    ]);
    expect(result.classification).toBe('different');
    expect(result.differences).toContain('applicationBuildId');
  });

  it('names an unidentified difference rather than guessing a field', () => {
    const result = compareEnvironments(original, [
      { attempt: 1, fingerprint: 'sha256:bbb', environmentId: 'local-shop', applicationBuildId: 'build-001' },
    ]);
    expect(result.classification).toBe('different');
    // Only the hash differs, so the field is honestly unnamed.
    expect(result.differences).toEqual(['fingerprintInputs']);
  });

  it('is unknown when the original has no provenance', () => {
    const result = compareEnvironments(
      { fingerprint: null, origin: null, browserName: 'unknown', browserVersion: 'unknown', environmentId: null, applicationBuildId: null },
      [{ attempt: 1, fingerprint: 'sha256:aaa', environmentId: null, applicationBuildId: null }],
    );
    expect(result.classification).toBe('unknown');
    expect(result.unknownReason).toBeTruthy();
  });

  it('is unknown when no attempt recorded provenance', () => {
    const result = compareEnvironments(original, [
      { attempt: 1, fingerprint: null, environmentId: null, applicationBuildId: null },
    ]);
    expect(result.classification).toBe('unknown');
  });

  it('is unknown when there are no attempts at all', () => {
    expect(compareEnvironments(original, []).classification).toBe('unknown');
  });

  it('describes each classification without overclaiming', () => {
    expect(describeComparison('same')).toMatch(/same recorded environment/);
    expect(describeComparison('different', ['applicationBuildId'])).toMatch(/different recorded environments/);
    expect(describeComparison('unknown')).toMatch(/provenance was incomplete/);
    for (const classification of ['same', 'different', 'unknown'] as const) {
      expect(describeComparison(classification)).not.toMatch(/proves|definite|identical/i);
    }
  });
});
