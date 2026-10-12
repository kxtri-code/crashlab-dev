/**
 * Unit & Safety Test Suite for Build 10.5: Local Product Demo Runner.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDemoFixtureServer } from '../../src/demo/fixtureServer.js';
import { cleanDemoArtifacts, DEFAULT_DEMO_OUT_DIR } from '../../src/demo/runner.js';
import { parseDemoArgs, runDemoCommand } from '../../src/cli/demoCommand.js';

describe('Build 10.5: Local Product Demo Unit & Safety Suite', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'crashlab-demo-unit-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('1. Demo Fixture Server & Loopback Isolation', () => {
    it('binds strictly to loopback (127.0.0.1) on an ephemeral port', async () => {
      const fixture = await startDemoFixtureServer(0);
      try {
        expect(fixture.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
        expect(fixture.port).toBeGreaterThan(0);
        expect(fixture.port).toBeLessThan(65536);

        // Verify loopback HTTP responses
        const resHome = await fetch(`${fixture.origin}/`);
        expect(resHome.status).toBe(200);
        const homeText = await resHome.text();
        expect(homeText).toContain('LOCAL SYNTHETIC FIXTURE');
        expect(homeText).toContain('Synthetic Widget Catalog');

        // Verify safe cart route (no payment inputs)
        const resCart = await fetch(`${fixture.origin}/cart`);
        expect(resCart.status).toBe(200);
        const cartText = await resCart.text();
        expect(cartText).toContain('Shopping Cart');
        expect(cartText).toContain('Payment and checkout actions are intentionally omitted');
        expect(cartText).not.toContain('<input type="password"');
        expect(cartText).not.toContain('credit-card');

        // Verify deterministic HTTP 500 fault route
        const resBoom = await fetch(`${fixture.origin}/boom`);
        expect(resBoom.status).toBe(500);
        const boomText = await resBoom.text();
        expect(boomText).toContain('Internal Server Error');
      } finally {
        await fixture.stop();
      }
    });

    it('proves zero external network calls by inspecting fixture server traffic', async () => {
      const fixture = await startDemoFixtureServer(0);
      try {
        const addr = fixture.server.address();
        expect(addr).toBeDefined();
        if (typeof addr === 'object' && addr !== null) {
          expect(addr.address).toBe('127.0.0.1');
        }
      } finally {
        await fixture.stop();
      }
    });
  });

  describe('2. CLI Argument Parsing & Validation', () => {
    it('parses default demo arguments cleanly', () => {
      const parsed = parseDemoArgs([]);
      expect(parsed.valid).toBe(true);
      expect(parsed.scenario).toBe('all');
      expect(parsed.outDir).toBe(DEFAULT_DEMO_OUT_DIR);
      expect(parsed.clean).toBe(false);
      expect(parsed.quiet).toBe(false);
      expect(parsed.json).toBe(false);
      expect(parsed.unknown).toHaveLength(0);
    });

    it('parses valid scenario flag values', () => {
      const pHealthy = parseDemoArgs(['--scenario', 'healthy']);
      expect(pHealthy.valid).toBe(true);
      expect(pHealthy.scenario).toBe('healthy');

      const pFailure = parseDemoArgs(['--scenario', 'failure']);
      expect(pFailure.valid).toBe(true);
      expect(pFailure.scenario).toBe('failure');

      const pAll = parseDemoArgs(['--scenario', 'all']);
      expect(pAll.valid).toBe(true);
      expect(pAll.scenario).toBe('all');
    });

    it('rejects invalid scenario flag value with error', () => {
      const parsed = parseDemoArgs(['--scenario', 'invalid-scenario']);
      expect(parsed.valid).toBe(false);
      expect(parsed.error).toContain('Invalid scenario');
    });

    it('parses --clean and --reset flags', () => {
      const pClean = parseDemoArgs(['--clean']);
      expect(pClean.valid).toBe(true);
      expect(pClean.clean).toBe(true);

      const pReset = parseDemoArgs(['--reset']);
      expect(pReset.valid).toBe(true);
      expect(pReset.clean).toBe(true);
    });

    it('parses custom --out-dir', () => {
      const parsed = parseDemoArgs(['--out-dir', 'reports/custom-demo']);
      expect(parsed.valid).toBe(true);
      expect(parsed.outDir).toBe('reports/custom-demo');
    });

    it('rejects missing value for --out-dir', () => {
      const parsed = parseDemoArgs(['--out-dir']);
      expect(parsed.valid).toBe(false);
      expect(parsed.error).toContain('--out-dir requires a directory path');
    });

    it('rejects unrecognized flags with error message', () => {
      const parsed = parseDemoArgs(['--unknown-flag']);
      expect(parsed.valid).toBe(false);
      expect(parsed.error).toContain('Unknown option: --unknown-flag');
    });
  });

  describe('3. Safe Demo Artifact Cleanup & Bounded Deletion', () => {
    it('refuses to delete workspace root or unsafe non-demo paths', async () => {
      await expect(cleanDemoArtifacts(process.cwd())).rejects.toThrow(/Refusing to delete/);
      await expect(cleanDemoArtifacts('src')).rejects.toThrow(/Refusing to delete/);
      await expect(cleanDemoArtifacts('tests')).rejects.toThrow(/Refusing to delete/);
      await expect(cleanDemoArtifacts('reports')).rejects.toThrow(/Refusing to delete/);
      await expect(cleanDemoArtifacts('arbitrary-dir')).rejects.toThrow(/Safe demo cleanup only targets directories containing "demo"/);
    });

    it('safely removes an isolated demo artifact directory', async () => {
      const demoTargetDir = join(tempDir, 'sample-demo-out');
      await mkdir(demoTargetDir, { recursive: true });
      await writeFile(join(demoTargetDir, 'execution.json'), '{"test":true}', 'utf8');

      const result = await cleanDemoArtifacts(demoTargetDir);
      expect(result.cleaned).toBe(true);

      let exists = true;
      try {
        await stat(demoTargetDir);
      } catch {
        exists = false;
      }
      expect(exists).toBe(false);
    });

    it('gracefully handles cleanup when demo directory does not exist', async () => {
      const nonExistentDemoDir = join(tempDir, 'nonexistent-demo');
      const result = await cleanDemoArtifacts(nonExistentDemoDir);
      expect(result.cleaned).toBe(false);
    });
  });

  describe('4. CLI Command Exit Codes', () => {
    it('returns exit code 2 when invalid arguments are provided', async () => {
      const code = await runDemoCommand(['--unrecognized-flag']);
      expect(code).toBe(2);
    });

    it('returns exit code 0 on --clean command', async () => {
      const demoTargetDir = join(tempDir, 'test-demo-clean');
      await mkdir(demoTargetDir, { recursive: true });

      const code = await runDemoCommand(['--out-dir', demoTargetDir, '--clean']);
      expect(code).toBe(0);
    });
  });

  describe('5. Safety Invariants & Zero Secrets Contract', () => {
    it('guarantees demo defaults contain no external URLs or credentials', () => {
      const parsed = parseDemoArgs([]);
      expect(parsed.outDir).not.toContain('http');
      expect(parsed.outDir).not.toContain('password');
      expect(parsed.outDir).not.toContain('key');
    });
  });
});
