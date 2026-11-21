import { describe, expect, it } from 'vitest'
import { setupForTest } from '@wb/sdk/testing'
import plugin, { nextStep } from './index'
import pomdp from './examples/pomdp.json'
import { parseSpec, viewAt } from './spec'

const tiny = {
  title: 'Tiny',
  kinds: { s: { shape: 'circle', color: 'state' } },
  nodes: [
    { id: 'a', kind: 's', label: 'A', x: 1, y: 1 },
    { id: 'b', kind: 's', label: 'B', x: 5, y: 1 },
  ],
  edges: [{ id: 'ab', from: 'a', to: 'b' }],
  steps: [
    { caption: 'A', add: ['a'] },
    { caption: 'B and the link', add: ['b', 'ab'], highlight: ['ab'] },
  ],
}

describe('explainer spec', () => {
  it('accepts the POMDP example', () => {
    const r = parseSpec(pomdp)
    expect(r.ok, r.ok ? '' : r.error).toBe(true)
  })

  it('rejects colors outside the vocabulary', () => {
    const bad = { ...tiny, kinds: { s: { shape: 'circle', color: 'hotpink' } } }
    expect(parseSpec(bad).ok).toBe(false)
  })

  it('rejects elements that no step introduces', () => {
    const bad = { ...tiny, steps: [{ caption: 'A', add: ['a'] }] }
    const r = parseSpec(bad)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/never added/)
  })

  it('rejects edges that appear before their nodes', () => {
    const bad = { ...tiny, steps: [{ caption: 'all', add: ['a', 'ab'] }, { caption: 'b', add: ['b'] }] }
    expect(parseSpec(bad).ok).toBe(false)
  })

  it('builds up step by step', () => {
    const r = parseSpec(tiny)
    if (!r.ok) throw new Error(r.error)
    expect([...viewAt(r.spec, 0).visible]).toEqual(['a'])
    const v = viewAt(r.spec, 1)
    expect([...v.visible].sort()).toEqual(['a', 'ab', 'b'])
    expect([...v.fresh].sort()).toEqual(['ab', 'b'])
    expect(v.highlight.has('ab')).toBe(true)
  })

  it('clamps step navigation', () => {
    expect(nextStep(0, 3, 'prev')).toBe(0)
    expect(nextStep(2, 3, 'next')).toBe(2)
    expect(nextStep(0, 3, 'goto', 3)).toBe(2)
    expect(nextStep(1, 3, 'first')).toBe(0)
  })
})

describe('explainer plugin', () => {
  it('creates the POMDP explainer and steps through it', async () => {
    const api = await setupForTest(plugin, { name: 'explainer' })
    const created = (await api.runTool('create_explainer', { example: 'pomdp' })) as { id: string; steps: number; text: string }
    expect(created.steps).toBe(pomdp.steps.length)
    expect(api.recorded.canvasShapes[0]?.type).toBe('explainer')
    const stepped = (await api.runTool('explainer_step', { action: 'next' })) as { step: number; text: string }
    expect(stepped.step).toBe(2)
    expect(stepped.text).toContain(pomdp.steps[1]?.caption ?? '')
    expect(api.recorded.canvasShapes[0]?.props?.step).toBe(1)
  })

  it('reports spec problems instead of drawing something off-brand', async () => {
    const api = await setupForTest(plugin, { name: 'explainer' })
    await expect(api.runTool('create_explainer', { spec: { title: 'x' } })).rejects.toThrow(/invalid explainer spec/)
  })
})
