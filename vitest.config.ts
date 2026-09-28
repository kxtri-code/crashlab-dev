import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Browser-backed specs launch Chromium against a local fixture server.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
