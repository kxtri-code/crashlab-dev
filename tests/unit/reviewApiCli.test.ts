/**
 * CLI Unit Tests for Review API Command (Build 9.1).
 *
 * Validates argument parsing, flags, default options, validation errors,
 * and clean startup and shutdown behavior.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseReviewApiArgs,
  runReviewApiCommand,
  REVIEW_API_FLAGS,
  REVIEW_API_USAGE,
} from '../../src/cli/reviewApiCommand.js';

describe('Review API CLI Command', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'crashlab-api-cli-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('recognizes all declared flags and defines usage text', () => {
    expect(REVIEW_API_FLAGS).toContain('--candidates');
    expect(REVIEW_API_FLAGS).toContain('--review-state');
    expect(REVIEW_API_FLAGS).toContain('--baselines');
    expect(REVIEW_API_FLAGS).toContain('--host');
    expect(REVIEW_API_FLAGS).toContain('--port');
    expect(REVIEW_API_FLAGS).toContain('--help');
    expect(REVIEW_API_USAGE).toContain('Review API (Read-Only)');
  });

  it('uses safe default host (127.0.0.1) and port (3210)', () => {
    const parsed = parseReviewApiArgs([]);
    expect(parsed.valid).toBe(true);
    expect(parsed.host).toBe('127.0.0.1');
    expect(parsed.port).toBe(3210);
    expect(parsed.candidatesPath).toBe('reports/candidates.json');
    expect(parsed.reviewStateDir).toBe('reports/review-state');
    expect(parsed.baselinesDir).toBe('reports/baselines');
  });

  it('parses custom host, port, and report paths', () => {
    const parsed = parseReviewApiArgs([
      '--host',
      '127.0.0.1',
      '--port',
      '8080',
      '--candidates',
      'custom/candidates.json',
      '--review-state',
      'custom/state',
      '--baselines',
      'custom/baselines',
    ]);
    expect(parsed.valid).toBe(true);
    expect(parsed.host).toBe('127.0.0.1');
    expect(parsed.port).toBe(8080);
    expect(parsed.candidatesPath).toBe('custom/candidates.json');
    expect(parsed.reviewStateDir).toBe('custom/state');
    expect(parsed.baselinesDir).toBe('custom/baselines');
  });

  it('rejects unknown flags with valid: false and code 2', async () => {
    const parsed = parseReviewApiArgs(['--unknown-flag', 'value']);
    expect(parsed.valid).toBe(false);
    expect(parsed.error).toContain('Unrecognised flag(s): --unknown-flag');

    const exitCode = await runReviewApiCommand(['--unknown-flag']);
    expect(exitCode).toBe(2);
  });

  it('rejects invalid port values (out of range, non-numeric)', () => {
    const outOfRange = parseReviewApiArgs(['--port', '70000']);
    expect(outOfRange.valid).toBe(false);
    expect(outOfRange.error).toContain('Port must be between 0 and 65535');

    const negativePort = parseReviewApiArgs(['--port', '-1']);
    expect(negativePort.valid).toBe(false);

    const nonNumeric = parseReviewApiArgs(['--port', 'abc']);
    expect(nonNumeric.valid).toBe(false);
    expect(nonNumeric.error).toContain('Port must be numeric');
  });

  it('rejects invalid host values containing whitespace or illegal characters', () => {
    const invalidHost = parseReviewApiArgs(['--host', 'invalid host with spaces']);
    expect(invalidHost.valid).toBe(false);
    expect(invalidHost.error).toContain('Host contains invalid or whitespace characters');
  });

  it('rejects missing argument values for flags', () => {
    const missingCand = parseReviewApiArgs(['--candidates']);
    expect(missingCand.valid).toBe(false);
    expect(missingCand.error).toContain('--candidates requires a file path');

    const missingPort = parseReviewApiArgs(['--port']);
    expect(missingPort.valid).toBe(false);
    expect(missingPort.error).toContain('--port requires a port number');
  });

  it('returns code 1 when backing candidates artifact does not exist', async () => {
    const exitCode = await runReviewApiCommand([
      '--candidates',
      join(tempDir, 'nonexistent-candidates.json'),
    ]);
    expect(exitCode).toBe(1);
  });

  it('returns code 1 when candidates artifact is malformed JSON', async () => {
    const malformedPath = join(tempDir, 'malformed-candidates.json');
    await writeFile(malformedPath, '{ not valid json');

    const exitCode = await runReviewApiCommand([
      '--candidates',
      malformedPath,
    ]);
    expect(exitCode).toBe(1);
  });
});
