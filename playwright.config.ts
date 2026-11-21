import { defineConfig } from '@playwright/test'

/**
 * Browser E2E. Runs its own sidecar (port 4329) and Vite (port 1430) against a
 * temporary copy of plugins/ and the demo board (tests/e2e/setup.ts runs before the sidecar), so
 * approving plugins here never touches the real plugins/approved.json.
 * Uses the installed Microsoft Edge (no browser download).
 */
const E2E_DIR = '.wb/e2e'
const SIDECAR_PORT = 4329
const WEB_PORT = 1430

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    channel: process.env.PW_CHANNEL ?? 'msedge',
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      // Prepare the isolated copy first, then start the sidecar on it.
      command: 'npx tsx tests/e2e/setup.ts && npx tsx sidecar/src/index.ts',
      url: `http://127.0.0.1:${SIDECAR_PORT}/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        WB_PORT: String(SIDECAR_PORT),
        WB_NO_MCP_CONFIG: '1',
        WB_PLUGINS_DIR: `${E2E_DIR}/plugins`,
        WB_BOARDS_DIR: `${E2E_DIR}/boards`,
        WB_RUNTIME_DIR: `${E2E_DIR}/runtime`,
        WB_EXTRA_ORIGINS: `http://127.0.0.1:${WEB_PORT},http://localhost:${WEB_PORT}`,
        WB_CLAUDE_BIN: 'wb-no-brain-in-e2e',
        WB_PYTHON: 'wb-no-python-in-e2e',
      },
    },
    {
      command: 'npm run dev -w app',
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: { VITE_PORT: String(WEB_PORT), VITE_WB_SIDECAR_HTTP: `http://127.0.0.1:${SIDECAR_PORT}` },
    },
  ],
})
