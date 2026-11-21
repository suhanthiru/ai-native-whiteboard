import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PluginInfo } from '@wb/sdk'
import { BASE_INSTRUCTIONS, buildInstructions } from '../src/mcp/server'
import { checkPluginFiles, checkPluginPath, dependenciesIn, MAX_FILE_BYTES, readPluginFiles, writePluginFiles } from '../src/skills/pluginFiles'
import { MAX_NOTES, noteTools, NotesStore } from '../src/skills/notes'
import { skillTools, type SkillToolDeps } from '../src/skills/skillTools'
import type { RegisteredTool, ToolResult } from '../src/tools/registry'
import { VOICE_PERSONA } from '../src/voice/brain'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-skills-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function tool(list: RegisteredTool[], name: string): RegisteredTool {
  const t = list.find((x) => x.name === name)
  if (!t) throw new Error(`no tool ${name}`)
  return t
}

const LATEX_MANIFEST = {
  version: '1.0.0',
  description: 'LaTeX equations on the canvas.',
  adds: { shapes: ['latex'], panels: [], tools: ['show_equation'], dataSources: [] },
}
const LATEX_FILES = { 'index.tsx': 'export default {}', 'plugin.test.ts': 'test', 'package.json': JSON.stringify({ dependencies: { katex: '^0.16.0' } }) }

interface Harness {
  deps: SkillToolDeps
  tools: RegisteredTool[]
  approvals: { title: string; detail: string }[]
  installs: string[]
  refreshed: string[]
  calls: { name: string; args: unknown }[]
  /** Ordered log of hold, release, install and refresh events. */
  events: string[]
  setApprove(value: boolean): void
  setState(state: PluginInfo['state'], message?: string): void
  setBoard(dir: string | null): void
  onApprove(fn: () => Promise<void> | void): void
  failInstall(): void
}

function harness(opts: { board?: boolean } = {}): Harness {
  const shared = join(root, 'plugins')
  let board: string | null = opts.board === false ? null : join(root, 'board', 'plugins')
  let duringApproval: () => Promise<void> | void = () => undefined
  let installFails = false
  const events: string[] = []
  let approve = true
  let state: PluginInfo['state'] = 'preview'
  let message: string | undefined
  const approvals: Harness['approvals'] = []
  const installs: string[] = []
  const refreshed: string[] = []
  const calls: Harness['calls'] = []
  const info = (name: string): PluginInfo => ({
    name,
    version: '1.0.0',
    description: '',
    source: 'shared',
    state,
    message,
    tools: state === 'preview' || state === 'active' ? [`plugin_${name.replace(/-/g, '_')}_show_equation`] : [],
    hash: 'h',
  })
  const deps: SkillToolDeps = {
    host: {
      pluginDirs: () => ({ shared, board }),
      hold: (name) => {
        events.push(`hold ${name}`)
        return () => void events.push(`release ${name}`)
      },
      refresh: async (name) => {
        events.push(`refresh ${name}`)
        refreshed.push(name)
        return info(name)
      },
      infos: () => refreshed.map(info),
    },
    approvals: {
      request: async (input) => {
        approvals.push({ title: input.title, detail: input.detail })
        await duringApproval()
        return approve
      },
    },
    tools: {
      call: async (name, args): Promise<ToolResult> => {
        calls.push({ name, args })
        return { text: `called ${name}` }
      },
      onChange: () => () => undefined,
    },
    guidePath: join(root, 'GUIDE.md'),
    install: async (dir) => {
      events.push('install')
      installs.push(dir)
      if (installFails) throw new Error('E404 katex not found')
    },
    toolWaitMs: 50,
  }
  return {
    deps,
    tools: skillTools(deps),
    approvals,
    installs,
    refreshed,
    calls,
    events,
    setApprove: (v) => (approve = v),
    setState: (s, m) => {
      state = s
      message = m
    },
    setBoard: (dir) => (board = dir),
    onApprove: (fn) => (duringApproval = fn),
    failInstall: () => (installFails = true),
  }
}

describe('plugin file checks', () => {
  it('accepts plain relative source paths and normalises backslashes', () => {
    expect(checkPluginPath('index.tsx')).toEqual({ ok: true, path: 'index.tsx' })
    expect(checkPluginPath('lib\\geometry.ts')).toEqual({ ok: true, path: 'lib/geometry.ts' })
  })

  it.each([
    '../evil.ts',
    '/abs.ts',
    'C:/x.ts',
    'a/../../b.ts',
    '.hidden.ts',
    'node_modules/x.js',
    'Node_Modules/pkg/index.js',
    '.Build/a.js',
    'manifest.json',
    'Manifest.JSON',
    'approved.json',
    'package-lock.json',
    'run.exe',
    'a//b.ts',
    'index.tsx:evil.txt',
    'node_modules:x.js',
    'con.txt',
    'lib/NUL.json',
    'aux.ts',
    'dir /a.ts',
    'dir./a.ts',
    'a<b.ts',
  ])('rejects %s', (p) => {
    expect(checkPluginPath(p).ok).toBe(false)
  })

  it.each(['file:../x', 'git+https://evil/x.git', 'https://evil/x.tgz', 'user/repo', 'npm:other@1', 'link:../x'])('rejects the non-registry dependency %s', (spec) => {
    expect(() => dependenciesIn(JSON.stringify({ dependencies: { x: spec } }))).toThrow(/registry versions/)
  })

  it('accepts registry ranges and tags', () => {
    expect(dependenciesIn(JSON.stringify({ dependencies: { a: '^1.2.0', b: '~0.16.9', c: 'latest', d: '>=2 <3', e: '1.0.0-beta.1' } }))).toHaveLength(5)
  })

  it('reports oversized and duplicate files', () => {
    const result = checkPluginFiles({ 'a.ts': 'x'.repeat(MAX_FILE_BYTES + 1), 'B.ts': '', 'b.ts': '' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.join('\n')).toMatch(/a\.ts: \d+ bytes/)
      expect(result.errors.join('\n')).toMatch(/listed twice/)
    }
  })

  it('reads dependencies from package.json', () => {
    expect(dependenciesIn(JSON.stringify({ dependencies: { katex: '^0.16.0' } }))).toEqual(['katex@^0.16.0'])
    expect(dependenciesIn(undefined)).toEqual([])
  })

  it('writes the manifest and files, and reads them back without node_modules', async () => {
    const dir = join(root, 'p')
    await writePluginFiles(dir, { name: 'p' }, [
      ['index.tsx', 'export {}'],
      ['lib/a.ts', 'a'],
    ])
    await mkdir(join(dir, 'node_modules', 'x'), { recursive: true })
    await writeFile(join(dir, 'node_modules', 'x', 'i.js'), '')
    const files = await readPluginFiles(dir)
    expect(files.map((f) => f.path)).toEqual(['index.tsx', 'lib/a.ts', 'manifest.json'])
    expect(JSON.parse(files[2]?.content ?? '{}')).toEqual({ name: 'p' })
  })
})

describe('create_plugin', () => {
  it('asks first and writes nothing when the user declines', async () => {
    const h = harness()
    h.setApprove(false)
    const result = await tool(h.tools, 'create_plugin').handler({ name: 'latex', manifest: LATEX_MANIFEST, files: LATEX_FILES })
    expect(result.isError).toBe(true)
    expect(h.approvals[0]?.title).toBe('Build skill "latex"?')
    expect(h.approvals[0]?.detail).toContain('katex@^0.16.0')
    expect(existsSync(join(root, 'plugins', 'latex'))).toBe(false)
    expect(h.refreshed).toEqual([])
  })

  it('writes, installs dependencies, refreshes and reports the preview tools', async () => {
    const h = harness()
    const result = await tool(h.tools, 'create_plugin').handler({ name: 'latex', manifest: LATEX_MANIFEST, files: LATEX_FILES })
    const dir = join(root, 'plugins', 'latex')
    expect(result.isError).toBeFalsy()
    expect(result.text).toContain('preview')
    expect(result.text).toContain('plugin_latex_show_equation')
    expect(JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))).toMatchObject({ name: 'latex', test: 'plugin.test.ts', frontend: 'index.tsx' })
    expect(await readFile(join(dir, 'index.tsx'), 'utf8')).toBe('export default {}')
    expect(h.installs).toEqual([dir])
    expect(h.refreshed).toEqual(['latex'])
  })

  it('holds the plugin from the watcher until the install is done, then refreshes once', async () => {
    const h = harness()
    await tool(h.tools, 'create_plugin').handler({ name: 'latex', manifest: LATEX_MANIFEST, files: LATEX_FILES })
    expect(h.events).toEqual(['hold latex', 'install', 'refresh latex'])
  })

  it('releases the hold and reports a failed install', async () => {
    const h = harness()
    h.failInstall()
    const result = await tool(h.tools, 'create_plugin').handler({ name: 'latex', manifest: LATEX_MANIFEST, files: LATEX_FILES })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('E404 katex not found')
    expect(h.events).toEqual(['hold latex', 'install', 'release latex'])
  })

  it('re-checks the target after a slow approval', async () => {
    const h = harness()
    h.onApprove(() => h.setBoard(join(root, 'other-board', 'plugins')))
    const result = await tool(h.tools, 'create_plugin').handler({ name: 'atom', manifest: LATEX_MANIFEST, files: { 'index.tsx': '', 'plugin.test.ts': '' }, scope: 'board' })
    expect(result.text).toMatch(/board changed/)
    expect(existsSync(join(root, 'board', 'plugins', 'atom'))).toBe(false)

    const h2 = harness()
    h2.onApprove(() => writePluginFiles(join(root, 'plugins', 'dup'), { name: 'dup' }, []))
    const dup = await tool(h2.tools, 'create_plugin').handler({ name: 'dup', manifest: LATEX_MANIFEST, files: { 'index.tsx': '', 'plugin.test.ts': '' } })
    expect(dup.text).toMatch(/already exists/)
  })

  it('shows the entry files in the approval', async () => {
    const h = harness()
    await tool(h.tools, 'create_plugin').handler({ name: 'latex', manifest: LATEX_MANIFEST, files: LATEX_FILES })
    expect(h.approvals[0]?.detail).toContain('Runs: test plugin.test.ts, frontend index.tsx')
  })

  it('writes into the open board with scope board', async () => {
    const h = harness()
    await tool(h.tools, 'create_plugin').handler({ name: 'atom', manifest: { ...LATEX_MANIFEST, adds: { tools: ['show_atom'] } }, files: { 'index.tsx': '', 'plugin.test.ts': '' }, scope: 'board' })
    expect(existsSync(join(root, 'board', 'plugins', 'atom', 'manifest.json'))).toBe(true)
    expect(h.installs).toEqual([])
  })

  it('refuses board scope with no open board', async () => {
    const h = harness({ board: false })
    const result = await tool(h.tools, 'create_plugin').handler({ name: 'atom', manifest: LATEX_MANIFEST, files: { 'index.tsx': '', 'plugin.test.ts': '' }, scope: 'board' })
    expect(result.text).toMatch(/No board is open/)
    expect(h.approvals).toEqual([])
  })

  it('returns the lint or test failure so the caller can fix it', async () => {
    const h = harness()
    h.setState('error', 'test failed:\nexpected 1 to be 2')
    const result = await tool(h.tools, 'create_plugin').handler({ name: 'latex', manifest: LATEX_MANIFEST, files: LATEX_FILES })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('update_plugin')
    expect(result.text).toContain('expected 1 to be 2')
  })

  it.each([
    [{ name: 'latex', manifest: LATEX_MANIFEST, files: { 'index.tsx': '' } }, /Missing the test file/],
    [{ name: 'latex', manifest: LATEX_MANIFEST, files: { 'plugin.test.ts': '' } }, /Missing the entry file/],
    [{ name: 'latex', manifest: { ...LATEX_MANIFEST, version: 'one' }, files: LATEX_FILES }, /Invalid manifest/],
    [{ name: 'latex', manifest: LATEX_MANIFEST, files: { ...LATEX_FILES, '../x.ts': '' } }, /Invalid files/],
    [{ name: 'latex', manifest: LATEX_MANIFEST, files: { ...LATEX_FILES, 'package.json': '{nope' } }, /not valid JSON/],
  ])('rejects bad input before asking (%#)', async (args, message) => {
    const h = harness()
    const result = await tool(h.tools, 'create_plugin').handler(args)
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(message)
    expect(h.approvals).toEqual([])
  })

  it('rejects a name that already exists', async () => {
    const h = harness()
    await writePluginFiles(join(root, 'plugins', 'latex'), { name: 'latex' }, [])
    const result = await tool(h.tools, 'create_plugin').handler({ name: 'latex', manifest: LATEX_MANIFEST, files: LATEX_FILES })
    expect(result.text).toMatch(/already exists/)
  })

  it('rejects invalid plugin names via the schema', async () => {
    const h = harness()
    expect(() => tool(h.tools, 'create_plugin').handler({ name: 'Bad Name', manifest: LATEX_MANIFEST, files: LATEX_FILES })).toThrow()
  })
})

describe('update_plugin and read_plugin', () => {
  it('merges manifest changes, writes changed files, and re-runs the pipeline', async () => {
    const h = harness()
    await tool(h.tools, 'create_plugin').handler({ name: 'latex', manifest: LATEX_MANIFEST, files: LATEX_FILES })
    const result = await tool(h.tools, 'update_plugin').handler({ name: 'latex', files: { 'index.tsx': 'v2' }, manifest: { version: '1.1.0' } })
    const dir = join(root, 'plugins', 'latex')
    expect(result.isError).toBeFalsy()
    expect(h.approvals.map((a) => a.title)).toEqual(['Build skill "latex"?', 'Update skill "latex"?'])
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as Record<string, unknown>
    expect(manifest.version).toBe('1.1.0')
    expect(manifest.description).toBe(LATEX_MANIFEST.description)
    expect(await readFile(join(dir, 'index.tsx'), 'utf8')).toBe('v2')
    expect(await readFile(join(dir, 'plugin.test.ts'), 'utf8')).toBe('test')
    expect(h.refreshed).toEqual(['latex', 'latex'])
  })

  it.each([{ test: '../other/plugin.test.ts' }, { frontend: '../../x.ts' }, { backend: 'C:/evil.ts' }])('refuses manifest entries outside the plugin: %o', async (changes) => {
    const h = harness()
    await tool(h.tools, 'create_plugin').handler({ name: 'latex', manifest: LATEX_MANIFEST, files: LATEX_FILES })
    const result = await tool(h.tools, 'update_plugin').handler({ name: 'latex', manifest: changes })
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/Invalid manifest entry/)
    expect(h.approvals).toHaveLength(1)
  })

  it('requires an existing plugin and a change', async () => {
    const h = harness()
    expect((await tool(h.tools, 'update_plugin').handler({ name: 'nope', files: { 'a.ts': '' } })).text).toMatch(/No plugin named nope/)
    await writePluginFiles(join(root, 'plugins', 'latex'), { name: 'latex', version: '1.0.0', description: 'd' }, [])
    expect((await tool(h.tools, 'update_plugin').handler({ name: 'latex' })).text).toMatch(/Nothing to change/)
  })

  it('prefers the board copy over the shared one', async () => {
    const h = harness()
    await writePluginFiles(join(root, 'plugins', 'latex'), { name: 'latex' }, [['index.tsx', 'shared']])
    await writePluginFiles(join(root, 'board', 'plugins', 'latex'), { name: 'latex' }, [['index.tsx', 'board']])
    const result = await tool(h.tools, 'read_plugin').handler({ name: 'latex' })
    expect(result.text).toContain('latex (board)')
    expect(result.text).toContain('board')
    expect(result.text).not.toContain('\nshared')
  })
})

describe('call_plugin_tool and get_plugin_guide', () => {
  it('dispatches plugin tools only', async () => {
    const h = harness()
    const call = tool(h.tools, 'call_plugin_tool')
    expect((await call.handler({ tool: 'plugin_latex_show_equation', args: { latex: 'x^2' } })).text).toBe('called plugin_latex_show_equation')
    expect(h.calls).toEqual([{ name: 'plugin_latex_show_equation', args: { latex: 'x^2' } }])
    expect(() => call.handler({ tool: 'run_code', args: {} })).toThrow()
  })

  it('returns the guide text, or says it is missing', async () => {
    const h = harness()
    expect((await tool(h.tools, 'get_plugin_guide').handler({})).isError).toBe(true)
    await writeFile(join(root, 'GUIDE.md'), '# Guide')
    expect((await tool(h.tools, 'get_plugin_guide').handler({})).text).toBe('# Guide')
  })
})

describe('skill trees and previews', () => {
  const WEBM_B64 = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 9, 9]).toString('base64')

  function previewHarness(previewUrl?: string, opts: { fail?: boolean } = {}) {
    const h = harness()
    const pluginDir = join(root, 'plugins', 'atom')
    const rpcCalls: unknown[] = []
    const saved: string[] = []
    const infos: PluginInfo[] = [
      { name: 'atom', version: '1.0.0', description: 'Atoms', source: 'shared', state: 'preview', tools: ['plugin_atom_show_atom'], hash: 'h', previewUrl, skill: { tree: 'chemistry', parents: [], explainer: '', examples: [], preview: 'scene' } },
      { name: 'molecule', version: '1.0.0', description: 'Molecules', source: 'shared', state: 'active', tools: [], hash: 'h', skill: { tree: 'chemistry', parents: ['atom'], explainer: '', examples: [], preview: 'scene' } },
      { name: 'mermaid', version: '1.0.0', description: 'Diagrams', source: 'shared', state: 'active', tools: [], hash: 'h' },
    ]
    const deps: SkillToolDeps = {
      ...h.deps,
      host: { ...h.deps.host, infos: () => infos },
      previews: {
        client: {
          hasRole: () => true,
          rpc: async (method, params) => {
            rpcCalls.push({ method, params })
            if (opts.fail) throw new Error('the window is hidden')
            return { mime: 'video/webm', data: WEBM_B64 }
          },
        },
        dirOf: () => pluginDir,
        onSaved: (name) => void saved.push(name),
      },
    }
    return { tools: skillTools(deps), calls: h.calls, rpcCalls, saved, pluginDir }
  }

  it('records the first call of a skill without a preview', async () => {
    const p = previewHarness()
    await mkdir(p.pluginDir, { recursive: true })
    const result = await tool(p.tools, 'call_plugin_tool').handler({ tool: 'plugin_atom_show_atom', args: { element: 'C' } })
    expect(p.calls).toEqual([{ name: 'plugin_atom_show_atom', args: { element: 'C' } }])
    expect(p.rpcCalls).toEqual([{ method: 'preview.record', params: { view: 'scene', seconds: 5 } }])
    expect(existsSync(join(p.pluginDir, 'preview.webm'))).toBe(true)
    expect(p.saved).toEqual(['atom'])
    expect(result.text).toContain('Recorded a 5s preview')
  })

  it('does not record again once a preview exists, unless asked', async () => {
    const p = previewHarness('http://x/skill-preview/atom?v=1&k=webm')
    await mkdir(p.pluginDir, { recursive: true })
    await tool(p.tools, 'call_plugin_tool').handler({ tool: 'plugin_atom_show_atom', args: {} })
    expect(p.rpcCalls).toEqual([])
    await tool(p.tools, 'record_skill_preview').handler({ tool: 'plugin_atom_show_atom', args: { element: 'Au' }, seconds: 3 })
    expect(p.rpcCalls).toEqual([{ method: 'preview.record', params: { view: 'scene', seconds: 3 } }])
    expect((await tool(p.tools, 'record_skill_preview').handler({ tool: 'plugin_nope_x', args: {} })).isError).toBe(true)
  })

  it('does not retry a failed recording automatically, but record_skill_preview can', async () => {
    const p = previewHarness(undefined, { fail: true })
    await mkdir(p.pluginDir, { recursive: true })
    const first = await tool(p.tools, 'call_plugin_tool').handler({ tool: 'plugin_atom_show_atom', args: {} })
    expect(first.text).toContain('No preview recorded: the window is hidden')
    await tool(p.tools, 'call_plugin_tool').handler({ tool: 'plugin_atom_show_atom', args: {} })
    expect(p.rpcCalls).toHaveLength(1)
    expect(p.calls).toHaveLength(2)
    await tool(p.tools, 'record_skill_preview').handler({ tool: 'plugin_atom_show_atom', args: {} })
    expect(p.rpcCalls).toHaveLength(2)
  })

  it('records only once when calls overlap', async () => {
    const p = previewHarness()
    await mkdir(p.pluginDir, { recursive: true })
    const call = tool(p.tools, 'call_plugin_tool')
    await Promise.all([call.handler({ tool: 'plugin_atom_show_atom', args: { element: 'C' } }), call.handler({ tool: 'plugin_atom_show_atom', args: { element: 'O' } })])
    expect(p.rpcCalls).toHaveLength(1)
    expect(p.calls).toHaveLength(2)
  })

  it('lists the trees with what each skill builds on', async () => {
    const p = previewHarness()
    const text = (await tool(p.tools, 'list_skill_trees').handler({})).text
    expect(text).toMatch(/^chemistry \(2\)/m)
    expect(text).toContain('molecule [active] builds on atom')
    expect(text).toMatch(/^general \(1\)/m)
  })

  it('shows the tree in the build approval', async () => {
    const h = harness()
    await tool(h.tools, 'create_plugin').handler({ name: 'latex', manifest: { ...LATEX_MANIFEST, skill: { tree: 'math', parents: ['mermaid'] } }, files: LATEX_FILES })
    expect(h.approvals[0]?.detail).toContain('Skill tree: math, builds on mermaid')
  })

  it('rejects a bad tree name in the manifest', async () => {
    const h = harness()
    const result = await tool(h.tools, 'create_plugin').handler({ name: 'latex', manifest: { ...LATEX_MANIFEST, skill: { tree: 'Not A Tree!' } }, files: LATEX_FILES })
    expect(result.text).toMatch(/Invalid manifest: skill\.tree/)
  })
})

describe('notes', () => {
  it('adds, dedupes, persists and removes notes', async () => {
    const file = join(root, 'memory.json')
    const store = new NotesStore(file)
    const a = await store.add('  Show equations   large ')
    expect(a.text).toBe('Show equations large')
    expect((await store.add('show equations LARGE')).id).toBe(a.id)
    const reloaded = new NotesStore(file)
    expect(reloaded.list().map((n) => n.text)).toEqual(['Show equations large'])
    expect(await reloaded.remove(a.id)).toBe(true)
    expect(await reloaded.remove(a.id)).toBe(false)
    expect(new NotesStore(file).list()).toEqual([])
  })

  it('keeps only the newest notes and ignores a corrupt file', async () => {
    const file = join(root, 'memory.json')
    const store = new NotesStore(file)
    for (let i = 0; i < MAX_NOTES + 3; i++) await store.add(`note ${i}`)
    expect(store.list()).toHaveLength(MAX_NOTES)
    expect(store.list()[0]?.text).toBe('note 3')
    await writeFile(file, '{broken')
    expect(new NotesStore(file).list()).toEqual([])
  })

  it('keeps every note when remember is called in parallel', async () => {
    const file = join(root, 'memory.json')
    const store = new NotesStore(file)
    await Promise.all(Array.from({ length: 10 }, (_, i) => store.add(`parallel ${i}`)))
    expect(store.list()).toHaveLength(10)
    expect(new NotesStore(file).list()).toHaveLength(10)
  })

  it('builds a prompt block only when there are notes', async () => {
    const store = new NotesStore(join(root, 'memory.json'))
    expect(store.promptBlock()).toBe('')
    await store.add('Trees live in data/qsm')
    expect(store.promptBlock()).toContain('- Trees live in data/qsm')
    expect(store.promptBlock()).toContain('never override')
  })

  it('exposes remember, recall and forget', async () => {
    const tools = noteTools(new NotesStore(join(root, 'memory.json')))
    const saved = await tool(tools, 'remember').handler({ text: 'Use metric units' })
    const id = (saved.data as { id: string }).id
    expect((await tool(tools, 'recall').handler({})).text).toBe(`${id}: Use metric units`)
    expect((await tool(tools, 'forget').handler({ id })).text).toBe(`Forgot ${id}.`)
    expect((await tool(tools, 'recall').handler({})).text).toBe('No notes yet.')
  })
})

describe('prompts', () => {
  it('tell the agent to build, test and reuse skills', () => {
    for (const phrase of ['create_plugin', 'get_plugin_guide', 'call_plugin_tool', 'update_plugin', 'Keep']) expect(BASE_INSTRUCTIONS).toContain(phrase)
    expect(buildInstructions('')).toBe(BASE_INSTRUCTIONS)
    expect(buildInstructions('Notes: x')).toBe(`${BASE_INSTRUCTIONS}\n\nNotes: x`)
  })

  it('keeps the voice persona safe for the Windows command line', () => {
    expect(VOICE_PERSONA).toContain('create_plugin')
    expect(VOICE_PERSONA).not.toMatch(/["%!]/)
  })
})
