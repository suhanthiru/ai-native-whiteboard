import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

const PLUGINS = join(process.cwd(), '.wb', 'e2e', 'plugins')
const FIRST_PARTY = ['explainer', 'mcap-playback', 'mermaid', 'sensor-viz', 'stream-plot']

async function command(page: Page, text: string): Promise<void> {
  const input = page.getByTestId('command-input')
  await input.fill(text)
  await input.press('Enter')
}

/** Click Keep/Allow on every approval card until the given plugins are active. */
async function approveUntilActive(page: Page, names: string[]): Promise<void> {
  await page.getByTestId('plugins-button').click()
  const deadline = Date.now() + 90_000
  for (;;) {
    const states = await Promise.all(names.map((n) => page.getByTestId(`plugin-${n}`).getAttribute('data-state', { timeout: 2000 }).catch(() => null)))
    if (states.every((s) => s === 'active')) break
    if (Date.now() > deadline) throw new Error(`plugins not active: ${names.map((n, i) => `${n}=${states[i]}`).join(', ')}`)
    // Cards animate out after a click, so click with a short timeout and look again.
    await page.getByTestId('approval-yes').first().click({ timeout: 2000 }).catch(() => undefined)
    await page.waitForTimeout(300)
  }
  await page.getByTestId('plugins-button').click()
}

test.describe.configure({ mode: 'serial' })

test('opens the demo board with its model', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('board-title')).toHaveText('Titan')
  await expect(page.getByTestId('stage').locator('canvas')).toBeVisible()
})

test('drives the model from text commands', async ({ page }) => {
  await page.goto('/')
  await command(page, '/explode 0.5')
  await expect(page.getByTestId('toast').filter({ hasText: 'Exploded to 50%' })).toBeVisible()
  await command(page, '/focus left wheel encoder')
  await expect(page.getByTestId('toast').filter({ hasText: 'Focused on left_encoder' })).toBeVisible()
  await command(page, '/annotate left_encoder | Counts wheel ticks')
  await expect(page.getByTestId('annotation-left_encoder')).toHaveText('Counts wheel ticks')
  await command(page, '/reset')
})

test('new plugins need a passing test and one Keep each', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('approval').first()).toBeVisible({ timeout: 90_000 })
  await approveUntilActive(page, FIRST_PARTY)
  const approved = JSON.parse(readFileSync(join(PLUGINS, 'approved.json'), 'utf8')) as { plugins: Record<string, string> }
  expect(Object.keys(approved.plugins).sort()).toEqual(FIRST_PARTY)
})

test('mermaid: one tool call draws a themed diagram on the canvas', async ({ page }) => {
  await page.goto('/')
  await command(page, '/plugin_mermaid_create_mermaid {"code":"flowchart LR\\n  Boot --> Init --> Ready"}')
  await expect(page.locator('.wb-mermaid svg')).toBeVisible()
  await expect(page.locator('.wb-mermaid svg')).toContainText('Ready')
})

test('editing a plugin hot-reloads it and asks to keep the new version', async ({ page }) => {
  await page.goto('/')
  const file = join(PLUGINS, 'stream-plot', 'index.tsx')
  writeFileSync(file, readFileSync(file, 'utf8').replace("title: 'Live'", "title: 'Live data'"))
  await expect(page.getByTestId('approval').filter({ hasText: 'stream-plot' })).toBeVisible({ timeout: 90_000 })
  await approveUntilActive(page, ['stream-plot'])
})

test('a broken plugin shows an error card and the app keeps working', async ({ page }) => {
  const dir = join(PLUGINS, 'broken')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ name: 'broken', version: '1.0.0', description: 'throws while rendering', adds: { panels: ['bad'], tools: ['open_bad'] } }))
  writeFileSync(
    join(dir, 'index.tsx'),
    `import { z } from 'zod'
import { definePlugin } from '@wb/sdk'
function Bad(): never { throw new Error('this panel is broken on purpose') }
export default definePlugin({ setup(api) {
  api.registerPanel({ id: 'bad', title: 'Bad', component: Bad })
  api.registerTool({ name: 'open_bad', description: 'open', input: z.object({}), run: async () => api.panels.open('bad') })
} })
`,
  )
  writeFileSync(join(dir, 'plugin.test.ts'), `import { it, expect } from 'vitest'\nit('loads', () => expect(1).toBe(1))\n`)
  await page.goto('/')
  await approveUntilActive(page, ['broken'])
  await command(page, '/plugin_broken_open_bad')
  await expect(page.getByTestId('panel-bad').getByTestId('error-card')).toContainText('broken on purpose')
  await command(page, '/explode 0.2')
  await expect(page.getByTestId('toast').filter({ hasText: 'Exploded to 20%' })).toBeVisible()
})

test('sensors: playback feeds a live encoder plot next to the part', async ({ page }) => {
  await page.goto('/')
  await command(page, '/plugin_mcap_playback_play')
  await expect(page.getByTestId('toast').filter({ hasText: 'Playing run_01.mcap' })).toBeVisible()
  await command(page, '/plugin_stream_plot_show_stream_plot {"topic":"left encoder"}')
  const plot = page.getByTestId('panel-plot')
  await expect(plot).toContainText('titan/left_encoder')
  const value = plot.locator('.wb-text-xl')
  const first = await value.textContent()
  await expect.poll(async () => value.textContent(), { timeout: 10_000 }).not.toBe(first)
  await command(page, '/plugin_mcap_playback_pause')
})

test('output window uses the projector theme and the keystone layer', async ({ page }) => {
  await page.goto('/?role=output')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'projector')
  await expect(page.getByTestId('warp-root')).toBeAttached()
  await page.keyboard.press('k')
  await expect(page.getByTestId('warp-handle-0')).toBeVisible()
  await page.keyboard.press('k')
})
