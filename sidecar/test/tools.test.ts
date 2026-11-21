import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Approvals } from '../src/approvals'
import { StateStore } from '../src/state/store'
import { parseCommand } from '../src/tools/commands'
import { bestMatch, scoreName, tokens } from '../src/tools/match'
import { checkRequired, defineCoreTool, ToolRegistry } from '../src/tools/registry'
import { toolResultFrom } from '../src/plugins/manager'
import { formatProblems, lintSource } from '../src/plugins/designLint'

const PARTS = ['left_wheel', 'left_encoder', 'left_motor', 'right_wheel', 'right_encoder', 'lidar', 'imu', 'chassis']

describe('spoken part names', () => {
  it('finds the part a person means', () => {
    expect(bestMatch('left wheel encoder', PARTS)?.name).toBe('left_encoder')
    expect(bestMatch('the left wheel', PARTS)?.name).toBe('left_wheel')
    expect(bestMatch('LiDAR', PARTS)?.name).toBe('lidar')
    expect(bestMatch('right encoder', PARTS)?.name).toBe('right_encoder')
    expect(bestMatch('spoiler', PARTS)).toBeNull()
  })

  it('tokenises camelCase and drops filler', () => {
    expect(tokens('the leftEncoder part')).toEqual(['left', 'encoder'])
    expect(scoreName('', 'x')).toBe(0)
  })
})

describe('command bar', () => {
  it('parses direct tool commands', () => {
    expect(parseCommand('/explode 0.6')).toEqual({ tool: 'explode', args: { amount: 0.6 } })
    expect(parseCommand('/focus left wheel encoder')).toEqual({ tool: 'focus', args: { part: 'left wheel encoder' } })
    expect(parseCommand('/open titan')).toEqual({ tool: 'open_board', args: { name: 'titan' } })
    expect(parseCommand('/annotate left_encoder | Counts wheel ticks')).toEqual({ tool: 'annotate', args: { part: 'left_encoder', text: 'Counts wheel ticks' } })
    expect(parseCommand('/plugin_mcap_playback_seek t=4.5')).toEqual({ tool: 'plugin_mcap_playback_seek', args: { t: 4.5 } })
    expect(parseCommand('/set_output {"view":"split"}')).toEqual({ tool: 'set_output', args: { view: 'split' } })
    expect(parseCommand('/reset')).toEqual({ tool: 'reset_view', args: {} })
  })

  it('leaves plain language for the brain', () => {
    expect(parseCommand('explode it please')).toBeNull()
    expect(parseCommand('/')).toBeNull()
  })
})

function registry() {
  const store = new StateStore()
  const approvals = new Approvals(store)
  return { store, approvals, tools: new ToolRegistry(approvals) }
}

describe('tool registry', () => {
  it('validates core tool input with zod and reports problems clearly', async () => {
    const { tools } = registry()
    tools.register(defineCoreTool({ name: 'explode', description: 'x', input: z.object({ amount: z.number().max(1) }), run: ({ amount }) => ({ text: `ok ${amount}` }) }))
    expect((await tools.call('explode', { amount: 0.5 })).text).toBe('ok 0.5')
    const bad = await tools.call('explode', { amount: 5 })
    expect(bad.isError).toBe(true)
    expect(bad.text).toMatch(/invalid arguments: amount/)
    expect((await tools.call('nope', {})).text).toMatch(/Unknown tool/)
    expect(tools.get('explode')?.inputSchema).toMatchObject({ type: 'object' })
  })

  it('waits for the user on tools that move hardware', async () => {
    const { tools, store, approvals } = registry()
    let ran = 0
    tools.register({ name: 'drive', description: 'move', inputSchema: { type: 'object' }, requiresApproval: true, owner: 'robot', handler: () => ((ran += 1), { text: 'driving' }) })
    const declined = tools.call('drive', {})
    const request = store.get().approvals[0]
    expect(request?.kind).toBe('tool')
    approvals.settle(request?.id ?? '', false)
    expect((await declined).text).toMatch(/declined/)
    expect(ran).toBe(0)

    const allowed = tools.call('drive', {})
    approvals.settle(store.get().approvals[0]?.id ?? '', true)
    expect((await allowed).text).toBe('driving')
    expect(ran).toBe(1)
    expect(store.get().approvals).toEqual([])
  })

  it('replaces a plugin owner’s tools and refuses name clashes', async () => {
    const { tools } = registry()
    let changes = 0
    tools.onChange(() => (changes += 1))
    const t = (name: string, owner: string) => ({ name, description: '', inputSchema: { type: 'object', required: ['x'] }, owner, handler: () => ({ text: owner }) })
    tools.replaceOwner('a', [t('one', 'a'), t('two', 'a')])
    tools.replaceOwner('b', [t('one', 'b')])
    expect(tools.ownedBy('a')).toEqual(['one', 'two'])
    expect(tools.ownedBy('b')).toEqual([])
    expect(() => tools.register(t('two', 'c'))).toThrow(/already registered/)
    expect((await tools.call('one', {})).text).toMatch(/missing required argument/)
    tools.removeOwner('a')
    expect(tools.list()).toEqual([])
    expect(changes).toBeGreaterThan(2)
    expect(() => tools.register(t('bad name', 'x'))).toThrow()
  })

  it('checks required arguments for JSON-schema tools', () => {
    expect(checkRequired({ required: ['a'] }, {})).toMatch(/a/)
    expect(checkRequired({}, {})).toBeNull()
  })

  it('normalises plugin tool results', () => {
    expect(toolResultFrom('t', 'hi')).toEqual({ text: 'hi' })
    expect(toolResultFrom('t', { text: 'made', id: 'x' })).toEqual({ text: 'made', data: { id: 'x' } })
    expect(toolResultFrom('t', { id: 'x' })).toEqual({ text: 't done.', data: { id: 'x' } })
  })
})

describe('design lint', () => {
  const lint = (code: string) => lintSource(code, 'x.tsx').map((p) => p.message)

  it.each([
    ["const c = '#ff0000'", /Color literal/],
    ['const c = `rgb(${r}, 0, 0)`', /Color in a template/],
    ["const s = { color: 'red' }", /hardcodes a color/],
    ['const t = { duration: 0.3 }', /hardcodes motion/],
    ["const s = { transition: 'opacity 300ms ease' }", /Timing literal|transition/],
    ["const d = '250ms'", /Timing literal/],
    ['setTimeout(() => setOpen(true), 300)', /setTimeout in UI code/],
  ])('flags %s', (code, message) => {
    expect(lint(code).join(' ')).toMatch(message)
  })

  it.each([
    'const c = api.design.dataColor("lidar")',
    "const s = { color: 'var(--wb-accent)', background: 'transparent' }",
    'const t = { duration: api.motion.durations.fast / 1000 }',
    'const x = <div className="wb-glass">hello</div>',
    'setTimeout(flush, 500) // wb-allow-timer: debounce saves',
    'const velocity = { velocity: 0 }',
  ])('allows %s', (code) => {
    expect(lint(code)).toEqual([])
  })

  it('ignores eslint-disable comments', () => {
    expect(lint("// eslint-disable-next-line\nconst c = '#fff'")).not.toEqual([])
  })

  it('formats problems for the plugin tray', () => {
    const problems = Array.from({ length: 10 }, (_, i) => ({ file: 'a.tsx', line: i + 1, column: 1, message: 'm' }))
    expect(formatProblems(problems, 2)).toMatch(/and 8 more/)
  })
})
