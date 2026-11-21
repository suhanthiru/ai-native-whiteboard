import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'sidecar/test/**/*.test.ts', 'app/src/**/*.test.{ts,tsx}'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: ['packages/sdk/src/**', 'sidecar/src/**', 'app/src/core/**', 'app/src/shell/keystone.ts'],
      exclude: ['**/*.test.*', 'sidecar/src/index.ts', 'sidecar/src/adapters/netGuardPreload.ts'],
      reporter: ['text-summary', 'text'],
    },
  },
})
