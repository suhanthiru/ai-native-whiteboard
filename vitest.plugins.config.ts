import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const setup = fileURLToPath(new URL('./test/plugin-setup.ts', import.meta.url))

/** Used by the plugin loader to run each plugin's plugin.test.ts (with --root <plugin dir>). */
export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: [setup],
    include: ['plugin.test.{ts,tsx}'],
    testTimeout: 30_000,
    passWithNoTests: false,
  },
})
