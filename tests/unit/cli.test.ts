import { describe, expect, it, vi } from 'vitest';
import { main, parseArgs, toScoutOptions, USAGE } from '../../src/cli.js';

describe('parseArgs', () => {
  it('treats a bare URL as a scout run with defaults', () => {
    const args = parseArgs(['https://example.com']);
    expect(args.command).toBe('scout');
    expect(args.url).toBe('https://example.com');
    expect(args.headless).toBe(true);
    expect(args.outputPath).toBe('reports/scout.json');
    expect(args.timeoutMs).toBe(30000);
  });

  it('accepts the explicit scout subcommand', () => {
    expect(parseArgs(['scout', 'https://example.com']).url).toBe('https://example.com');
  });

  it('expands a bare host to https', () => {
    expect(parseArgs(['example.com']).url).toBe('https://example.com');
  });

  it('reads space-separated flag values', () => {
    const args = parseArgs(['https://x.test', '--out', 'out/custom.json', '--timeout', '5000']);
    expect(args.outputPath).toBe('out/custom.json');
    expect(args.timeoutMs).toBe(5000);
  });

  it('reads inline flag values', () => {
    const args = parseArgs(['https://x.test', '--out=out/inline.json', '--timeout=7000']);
    expect(args.outputPath).toBe('out/inline.json');
    expect(args.timeoutMs).toBe(7000);
  });

  it('handles --visible and --insecure as bare booleans', () => {
    const args = parseArgs(['https://x.test', '--visible', '--insecure']);
    expect(args.headless).toBe(false);
    expect(args.ignoreHttpsErrors).toBe(true);
  });

  it('parses a viewport', () => {
    expect(parseArgs(['https://x.test', '--viewport', '390x844']).viewport).toEqual({ width: 390, height: 844 });
  });

  it('returns help when no URL is given', () => {
    expect(parseArgs([]).command).toBe('help');
    expect(parseArgs(['scout']).command).toBe('help');
  });

  it('returns help for -h, --help and help', () => {
    expect(parseArgs(['--help']).command).toBe('help');
    expect(parseArgs(['-h']).command).toBe('help');
    expect(parseArgs(['help']).command).toBe('help');
  });

  it('returns version for -v, --version and version', () => {
    expect(parseArgs(['--version']).command).toBe('version');
    expect(parseArgs(['-v']).command).toBe('version');
  });

  it('rejects an unknown flag instead of silently ignoring it', () => {
    const args = parseArgs(['https://x.test', '--nope']);
    expect(args.valid).toBe(false);
    expect(args.error).toContain('--nope');
  });

  it('rejects a flag with a missing value', () => {
    const args = parseArgs(['https://x.test', '--out']);
    expect(args.valid).toBe(false);
    expect(args.error).toContain('requires a value');
  });

  it('rejects a second bare URL', () => {
    const args = parseArgs(['https://x.test', 'https://y.test']);
    expect(args.valid).toBe(false);
  });

  it('documents the authorized-targets safety note in usage', () => {
    expect(USAGE).toContain('authorized');
  });
});

describe('main', () => {
  it('exits 0 and prints usage for a bare invocation', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(await main([])).toBe(0);
      expect(spy.mock.calls.flat().join('\n')).toContain('Usage:');
    } finally {
      spy.mockRestore();
    }
  });

  it('exits 2 for an unknown flag, even though command defaults to help', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await main(['https://x.test', '--nope'])).toBe(2);
      expect(err.mock.calls.flat().join('\n')).toContain('--nope');
      out.mockRestore();
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });

  it('exits 2 when a flag is missing its value', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(await main(['https://x.test', '--out'])).toBe(2);
    } finally {
      err.mockRestore();
      out.mockRestore();
    }
  });

  it('exits 0 for --version', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(await main(['--version'])).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('toScoutOptions', () => {
  it('carries the parsed values into the scout options', () => {
    const args = parseArgs(['example.com', '--visible', '--timeout', '1234', '--settle', '50']);
    const options = toScoutOptions(args);
    expect(options).toMatchObject({
      url: 'https://example.com',
      headless: false,
      timeoutMs: 1234,
      settleMs: 50,
    });
  });
});
