/**
 * End-to-end through the sidecar: real HTTP/WebSocket server, real MCP client
 * with the bearer token, a fake control window answering RPCs, and throwaway
 * plugins that must pass the design lint and their test, then be approved.
 */
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import type { ServerMessage } from '@wb/sdk'
import { createSidecar, type Sidecar } from '../src/app'
import { AWAITING_KEEP } from '../src/plugins/manager'
import type { Brain } from '../src/voice/brain'

const ROOT = process.cwd()
const TMP = join(ROOT, '.wb', `itest-${randomUUID().slice(0, 8)}`)
const DEMO = join(ROOT, 'boards', 'titan-demo', 'data')

function write(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

function makeFixtures(): void {
  const board = join(TMP, 'boards', 'demo')
  mkdirSync(join(board, 'data'), { recursive: true })
  copyFileSync(join(DEMO, 'titan.glb'), join(board, 'data', 'titan.glb'))
  write(join(board, 'board.json'), JSON.stringify({ name: 'demo', title: 'Demo', aliases: ['the demo'], model: 'data/titan.glb' }))
  write(join(TMP, 'outside.txt'), 'secret')

  const echo = join(TMP, 'plugins', 'echo')
  write(join(echo, 'manifest.json'), JSON.stringify({ name: 'echo', version: '1.0.0', description: 'test plugin', adds: { tools: ['say'] } }))
  write(
    join(echo, 'index.tsx'),
    `import { z } from 'zod'
import { definePlugin } from '@wb/sdk'
export default definePlugin({ setup(api) { api.registerTool({ name: 'say', description: 'echo', input: z.object({ text: z.string() }), run: ({ text }) => 'said: ' + text }) } })
`,
  )
  write(join(echo, 'plugin.test.ts'), `import { it, expect } from 'vitest'\nit('passes', () => expect(1).toBe(1))\n`)

  const peek = join(TMP, 'plugins', 'peek')
  write(join(peek, 'manifest.json'), JSON.stringify({ name: 'peek', version: '1.0.0', description: 'adapter sandbox probe', backend: 'adapter.ts', adds: { tools: ['probe'] } }))
  write(join(peek, 'index.tsx'), `import { definePlugin } from '@wb/sdk'\nexport default definePlugin({ setup() {} })\n`)
  write(
    join(peek, 'adapter.ts'),
    `import { readFileSync } from 'node:fs'
import { defineAdapter } from '@wb/sdk'
export default defineAdapter({
  start(api) {
    api.registerTool({ name: 'probe', description: 'try to escape', inputSchema: { type: 'object', properties: {} }, run: async () => {
      const out: Record<string, string> = {}
      out.list = (await api.board.data.list()).map((f) => f.path).join(',')
      try { await api.board.data.read('../board.json'); out.scoped = 'read' } catch { out.scoped = 'refused' }
      try { readFileSync(${JSON.stringify(join(TMP, 'outside.txt'))}); out.outside = 'read' } catch (e) { out.outside = (e as { code?: string }).code ?? 'error' }
      try { await import('node:net'); out.net = 'loaded' } catch { out.net = 'blocked' }
      return JSON.stringify(out)
    } })
    api.publish('demo/heartbeat', { value: 1 }, 0)
  },
})
`,
  )
  write(join(peek, 'plugin.test.ts'), `import { it, expect } from 'vitest'\nit('passes', () => expect(true).toBe(true))\n`)
}

const quietBrain: Brain = { name: 'test', available: async () => true, ask: async (text) => `heard ${text}`, cancel: () => undefined }
const silent = { available: async () => ({ ok: false, detail: 'off' }), transcribe: async () => '', speak: async () => Buffer.alloc(0), stop: () => undefined }

let sidecar: Sidecar
let control: WebSocket
let mcp: Client
let listChanged = 0
const received: ServerMessage[] = []

async function waitFor<T>(fn: () => T | undefined | null | false, ms = 60_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 50))
  }
}

function text(result: unknown): string {
  return ((result as { content: { text: string }[] }).content ?? []).map((c) => c.text).join('\n')
}

beforeAll(async () => {
  makeFixtures()
  sidecar = await createSidecar({
    config: { rootDir: ROOT, boardsDir: join(TMP, 'boards'), pluginsDir: join(TMP, 'plugins'), runtimeDir: join(TMP, '.wb'), port: 0, defaultBoard: null },
    brain: quietBrain,
    stt: silent,
    tts: silent,
    skipMcpConfig: true,
  })

  control = new WebSocket(`ws://127.0.0.1:${sidecar.port}/ws`)
  await new Promise((resolve, reject) => {
    control.once('open', resolve)
    control.once('error', reject)
  })
  control.on('message', (raw, isBinary) => {
    if (isBinary) return
    const m = JSON.parse(raw.toString()) as ServerMessage
    received.push(m)
    if (m.type === 'rpc') {
      const result = m.method === 'plugin.tool' ? `said: ${(m.params as { args: { text: string } }).args.text}` : null
      control.send(JSON.stringify({ type: 'rpc_result', id: m.id, ok: true, result }))
    }
    if (m.type === 'plugin_bundle' && m.bundle.name === 'echo') {
      control.send(JSON.stringify({ type: 'register_tools', plugin: 'echo', tools: [{ name: 'say', description: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] }))
      control.send(JSON.stringify({ type: 'plugin_loaded', plugin: 'echo', ok: true }))
    }
  })
  control.send(JSON.stringify({ type: 'hello', role: 'control' }))

  mcp = new Client({ name: 'test', version: '1.0.0' })
  mcp.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    listChanged += 1
  })
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${sidecar.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${sidecar.config.token}` } } }))
}, 120_000)

afterAll(async () => {
  await mcp?.close().catch(() => undefined)
  control?.close()
  await sidecar?.close()
  rmSync(TMP, { recursive: true, force: true })
})

describe('sidecar over MCP', () => {
  it('rejects requests without the token and foreign origins', async () => {
    const res = await fetch(`http://127.0.0.1:${sidecar.port}/mcp`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(401)
    const evil = new WebSocket(`ws://127.0.0.1:${sidecar.port}/ws`, { headers: { Origin: 'https://evil.example' } })
    await expect(new Promise((resolve, reject) => (evil.once('open', resolve), evil.once('error', reject)))).rejects.toThrow()
    const data = await fetch(`http://127.0.0.1:${sidecar.port}/board-data/titan.glb`)
    expect(data.status).toBe(404) // no board open yet
  })

  it('lists the core tools', async () => {
    const { tools } = await mcp.listTools()
    const names = tools.map((t) => t.name)
    for (const n of ['open_board', 'explode', 'focus', 'annotate', 'list_parts', 'run_code', 'set_output']) expect(names).toContain(n)
  })

  it('opens a board by alias and serves its model', async () => {
    expect(text(await mcp.callTool({ name: 'open_board', arguments: { name: 'the demo' } }))).toMatch(/Opened Demo/)
    expect(sidecar.store.get().scene.modelFile).toBe('titan.glb')
    const res = await fetch(`http://127.0.0.1:${sidecar.port}/board-data/titan.glb`)
    expect(res.status).toBe(200)
    const escape = await fetch(`http://127.0.0.1:${sidecar.port}/board-data/..%2Fboard.json`)
    expect(escape.status).toBe(404)
  })

  it('drives the scene: explode, focus by spoken name, annotate', async () => {
    control.send(JSON.stringify({ type: 'model_info', file: 'titan.glb', parts: ['left_wheel', 'left_encoder', 'lidar'] }))
    expect(text(await mcp.callTool({ name: 'explode', arguments: { amount: 0.6 } }))).toMatch(/60%/)
    expect(text(await mcp.callTool({ name: 'focus', arguments: { part: 'the left wheel encoder' } }))).toMatch(/left_encoder/)
    await mcp.callTool({ name: 'annotate', arguments: { part: 'left encoder', text: 'Counts wheel ticks' } })
    const scene = sidecar.store.get().scene
    expect(scene).toMatchObject({ explode: 0.6, focus: 'left_encoder' })
    expect(scene.annotations[0]).toMatchObject({ part: 'left_encoder', text: 'Counts wheel ticks' })
    const bad = await mcp.callTool({ name: 'focus', arguments: { part: 'flux capacitor' } })
    expect(bad.isError).toBe(true)
    expect(text(bad)).toMatch(/No part matches/)
  })

  it('covers the rest of the core tools', async () => {
    const call = async (name: string, args: Record<string, unknown> = {}) => mcp.callTool({ name, arguments: args })
    expect(text(await call('list_boards'))).toMatch(/demo \(the demo\)/)
    expect(text(await call('list_parts'))).toMatch(/left_encoder/)
    expect(text(await call('board_status'))).toMatch(/titan\.glb \[unlocked\]/)
    expect(text(await call('lock_board_data'))).toMatch(/Locked 1 data file/)
    expect(text(await call('board_status'))).toMatch(/titan\.glb \[ok\]/)
    expect(text(await call('clear_annotations', { part: 'left encoder' }))).toMatch(/cleared/)
    expect(sidecar.store.get().scene.annotations).toEqual([])
    expect(text(await call('set_output', { view: 'split' }))).toMatch(/split/)
    expect(sidecar.store.get().output.view).toBe('split')
    expect(text(await call('reset_view'))).toMatch(/reset/)
    expect(sidecar.store.get().scene).toMatchObject({ explode: 0, focus: null })
    expect((await call('load_model', { file: 'nope.glb' })).isError).toBe(true)
    expect(text(await call('load_model', { file: 'data/titan.glb' }))).toMatch(/Loading titan\.glb/)
    expect(text(await call('list_topics'))).toMatch(/No topics|demo\//)
    expect(text(await call('list_plugins'))).toMatch(/echo|peek/)
    expect(text(await call('add_note', { text: 'remember the encoder' }))).toMatch(/Note added/)
    const noBoard = await call('open_board', { name: 'spaceship' })
    expect(noBoard.isError).toBe(true)
    expect(text(noBoard)).toMatch(/No board matches/)
    // load_model cleared the parts; the control window reports them again after loading.
    control.send(JSON.stringify({ type: 'model_info', file: 'titan.glb', parts: ['left_wheel', 'left_encoder', 'lidar'] }))
  })

  it('runs /commands from the command bar directly', async () => {
    control.send(JSON.stringify({ type: 'command', text: '/explode 0.3' }))
    await waitFor(() => sidecar.store.get().scene.explode === 0.3)
    await waitFor(() => received.some((m) => m.type === 'toast' && /30%/.test(m.text)))
  })

  it('saves the keystone calibration and ignores malformed corners', async () => {
    const corners = [{ x: 0.02, y: 0 }, { x: 1, y: 0.01 }, { x: 0.98, y: 1 }, { x: 0, y: 0.99 }]
    control.send(JSON.stringify({ type: 'warp', corners }))
    await waitFor(() => sidecar.store.get().output.warp?.[0]?.x === 0.02)
    control.send(JSON.stringify({ type: 'warp', corners: [{ x: 'a' }] }))
    control.send(JSON.stringify({ type: 'calibrate', on: true }))
    await waitFor(() => sidecar.store.get().output.calibrating)
    expect(sidecar.store.get().output.warp?.[0]?.x).toBe(0.02)
  })

  it('sends plain language from the command bar to the brain', async () => {
    control.send(JSON.stringify({ type: 'command', text: 'explain the lidar' }))
    await waitFor(() => sidecar.store.get().voice.reply === 'heard explain the lidar')
  })
})

describe('plugins', () => {
  it('runs none of a new plugin’s code until it is kept, then tests and loads it', async () => {
    const approval = await waitFor(() => sidecar.store.get().approvals.find((a) => a.plugin === 'echo' && a.kind === 'plugin'))
    expect(approval.detail).toMatch(/None of its code has run yet/)
    expect(sidecar.plugins.infos().find((p) => p.name === 'echo')).toMatchObject({ state: 'pending', message: AWAITING_KEEP })
    expect(received.some((m) => m.type === 'plugin_bundle' && m.bundle.name === 'echo')).toBe(false)
    expect(sidecar.tools.get('plugin_echo_say')).toBeUndefined()
    control.send(JSON.stringify({ type: 'approval', id: approval.id, approve: true }))
    await waitFor(() => sidecar.plugins.infos().find((p) => p.name === 'echo')?.state === 'active')
    const { tools } = await mcp.listTools()
    expect(tools.map((t) => t.name)).toContain('plugin_echo_say')
    expect(text(await mcp.callTool({ name: 'plugin_echo_say', arguments: { text: 'hi' } }))).toBe('said: hi')
    expect(listChanged).toBeGreaterThan(0)
  }, 120_000)

  it('runs backend adapters with read access to their board’s data only', async () => {
    const approval = await waitFor(() => sidecar.store.get().approvals.find((a) => a.plugin === 'peek'))
    control.send(JSON.stringify({ type: 'approval', id: approval.id, approve: true }))
    await waitFor(() => sidecar.tools.get('plugin_peek_probe'))
    const result = JSON.parse(text(await mcp.callTool({ name: 'plugin_peek_probe', arguments: {} }))) as Record<string, string>
    expect(result).toEqual({ list: 'titan.glb', scoped: 'refused', outside: 'ERR_ACCESS_DENIED', net: 'blocked' })
    await waitFor(() => received.some((m) => m.type === 'bus' && m.topic === 'demo/heartbeat'))
  }, 120_000)

  it('does not keep a plugin whose test fails after Keep', async () => {
    const dir = join(TMP, 'plugins', 'flaky')
    write(join(dir, 'manifest.json'), JSON.stringify({ name: 'flaky', version: '1.0.0', description: 'failing test' }))
    write(join(dir, 'index.tsx'), `import { definePlugin } from '@wb/sdk'\nexport default definePlugin({ setup() {} })\n`)
    write(join(dir, 'plugin.test.ts'), `import { it, expect } from 'vitest'\nit('fails', () => expect(1).toBe(2))\n`)
    const approval = await waitFor(() => sidecar.store.get().approvals.find((a) => a.plugin === 'flaky'))
    control.send(JSON.stringify({ type: 'approval', id: approval.id, approve: true }))
    const info = await waitFor(() => sidecar.plugins.infos().find((p) => p.name === 'flaky' && p.state === 'error'))
    expect(info.message).toMatch(/test failed \(not kept\)/)
    expect(received.some((m) => m.type === 'plugin_bundle' && m.bundle.name === 'flaky')).toBe(false)
    expect(existsSync(join(TMP, 'plugins', 'approved.json')) && readFileSync(join(TMP, 'plugins', 'approved.json'), 'utf8')).not.toMatch(/flaky/)
  }, 120_000)

  it('fails a plugin that hardcodes colors, with the lint message', async () => {
    const dir = join(TMP, 'plugins', 'garish')
    write(join(dir, 'manifest.json'), JSON.stringify({ name: 'garish', version: '1.0.0', description: 'bad colors' }))
    write(join(dir, 'index.tsx'), `import { definePlugin } from '@wb/sdk'\nconst c = '#ff00ff'\nexport default definePlugin({ setup() { void c } })\n`)
    write(join(dir, 'plugin.test.ts'), `import { it } from 'vitest'\nit('ok', () => {})\n`)
    const info = await waitFor(() => sidecar.plugins.infos().find((p) => p.name === 'garish' && p.state === 'error'))
    expect(info.message).toMatch(/design lint failed/)
  }, 60_000)
})

describe('run_code sandbox', () => {
  it('runs code and returns stdout', async () => {
    expect(text(await mcp.callTool({ name: 'run_code', arguments: { code: 'console.log(6 * 7)', show: false } }))).toMatch(/42/)
  })

  it('cannot read outside the board or use the network', async () => {
    const code = `import { readFileSync } from 'node:fs'
try { readFileSync(${JSON.stringify(join(TMP, 'outside.txt'))}); console.log('read') } catch (e) { console.log('fs', e.code) }
try { await fetch('http://example.com'); console.log('net ok') } catch (e) { console.log('net', e.message) }
try { process.getBuiltinModule('node:net'); console.log('builtin ok') } catch { console.log('builtin blocked') }`
    const out = text(await mcp.callTool({ name: 'run_code', arguments: { code, show: false } }))
    expect(out).toMatch(/fs ERR_ACCESS_DENIED/)
    expect(out).toMatch(/net network access is not allowed/)
    expect(out).toMatch(/builtin blocked/)
  })
})
