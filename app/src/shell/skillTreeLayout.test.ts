import { describe, expect, it } from 'vitest'
import type { PluginInfo, SkillMeta } from '@wb/sdk'
import { buildSkillForest, COLUMN_WIDTH, depthsOf, layoutTree, matchesSkill, NEW_WINDOW_MS, ROW_HEIGHT, treeTitle } from './skillTreeLayout'
import { edgePath, previewKind, tooltipPosition } from './SkillTrees'
import { pickVideoMime } from './previewRecorder'

const NOW = Date.parse('2026-11-20T12:00:00Z')

function skill(name: string, meta: Partial<SkillMeta> = {}, extra: Partial<PluginInfo> = {}): PluginInfo {
  return {
    name,
    version: '1.0.0',
    description: `${name} skill`,
    source: 'shared',
    state: 'active',
    tools: [],
    hash: 'h',
    skill: { tree: 'chemistry', parents: [], explainer: '', examples: [], preview: 'scene', ...meta },
    updatedAt: '2026-01-01T00:00:00Z',
    ...extra,
  }
}

describe('skill tree layout', () => {
  it('puts roots at depth 0 and children one column further than their deepest parent', () => {
    const skills = [skill('atom'), skill('molecule', { parents: ['atom'] }), skill('reaction', { parents: ['molecule', 'atom'] }), skill('periodic-table')]
    const depths = depthsOf(skills)
    expect(Object.fromEntries(depths)).toEqual({ atom: 0, molecule: 1, reaction: 2, 'periodic-table': 0 })
    const tree = layoutTree('chemistry', skills, NOW)
    const reaction = tree.nodes.find((n) => n.info.name === 'reaction')
    expect(reaction?.x).toBe(2 * COLUMN_WIDTH)
    expect(tree.edges).toEqual(expect.arrayContaining([{ from: 'atom', to: 'molecule' }, { from: 'molecule', to: 'reaction' }, { from: 'atom', to: 'reaction' }]))
  })

  it('survives cycles, self-parents and missing parents', () => {
    const skills = [skill('a', { parents: ['b'] }), skill('b', { parents: ['a'] }), skill('c', { parents: ['c', 'ghost'] })]
    const depths = depthsOf(skills)
    for (const d of depths.values()) expect(Number.isFinite(d)).toBe(true)
    expect(depths.get('c')).toBe(0)
    const tree = layoutTree('t', skills, NOW)
    expect(tree.edges.some((e) => e.from === 'c' && e.to === 'c')).toBe(false)
  })

  it('orders children next to their parents and sizes the tree', () => {
    const skills = [skill('b-root'), skill('a-root'), skill('child-of-b', { parents: ['b-root'] })]
    const tree = layoutTree('t', skills, NOW)
    const row = (n: string) => tree.nodes.find((x) => x.info.name === n)?.row
    expect(row('a-root')).toBe(0)
    expect(row('b-root')).toBe(1)
    expect(row('child-of-b')).toBe(0)
    expect(tree.height).toBe(ROW_HEIGHT + 64)
  })

  it('draws one edge for a parent listed twice', () => {
    const tree = layoutTree('t', [skill('a'), skill('b', { parents: ['a', 'a'] })], NOW)
    expect(tree.edges).toEqual([{ from: 'a', to: 'b' }])
  })

  it('shows parents from other trees as links, not edges', () => {
    const forest = buildSkillForest([skill('atom'), skill('rust-sim', { tree: 'physics', parents: ['atom'] })], NOW)
    const physics = forest.find((t) => t.name === 'physics')
    expect(physics?.nodes[0]?.crossParents).toEqual(['atom'])
    expect(physics?.edges).toEqual([])
  })

  it('groups by tree, newest first, with defaults for plugins without skill data', () => {
    const recent = new Date(NOW - 1000).toISOString()
    const forest = buildSkillForest([skill('old', { tree: 'robotics' }), skill('fresh', { tree: 'chemistry' }, { updatedAt: recent }), skill('plain', {}, { skill: undefined })], NOW)
    // Newest tree first; equally old trees fall back to alphabetical order.
    expect(forest.map((t) => t.name)).toEqual(['chemistry', 'general', 'robotics'])
    expect(forest[0]?.newCount).toBe(1)
    expect(forest.find((t) => t.name === 'general')?.nodes[0]?.skill.tree).toBe('general')
    const stale = buildSkillForest([skill('x', {}, { updatedAt: new Date(NOW - NEW_WINDOW_MS - 1).toISOString() })], NOW)
    expect(stale[0]?.newCount).toBe(0)
  })

  it('searches names, explainers, examples and trees', () => {
    const [tree] = buildSkillForest([skill('atom', { explainer: 'Bohr model', examples: ['show me carbon'] })], NOW)
    const node = tree?.nodes[0]
    if (!node) throw new Error('no node')
    expect(matchesSkill(node, '')).toBe(true)
    expect(matchesSkill(node, 'BOHR')).toBe(true)
    expect(matchesSkill(node, 'carbon')).toBe(true)
    expect(matchesSkill(node, 'chem')).toBe(true)
    expect(matchesSkill(node, 'latex')).toBe(false)
  })

  it('titles trees', () => {
    expect(treeTitle('computer-vision')).toBe('Computer vision')
  })
})

describe('skill viewer helpers', () => {
  it('reads the preview kind from the URL', () => {
    expect(previewKind(undefined)).toBeNull()
    expect(previewKind('http://127.0.0.1:4319/skill-preview/atom?v=1&k=png')).toBe('image')
    expect(previewKind('http://127.0.0.1:4319/skill-preview/atom?v=1&k=webm')).toBe('video')
  })

  it('places the tooltip right of the node, or left when there is no room, inside the window', () => {
    const viewport = { width: 1200, height: 800 }
    expect(tooltipPosition({ left: 100, right: 300, top: 200 }, viewport)).toEqual({ left: 312, top: 160 })
    expect(tooltipPosition({ left: 900, right: 1100, top: 790 }, viewport).left).toBe(900 - 12 - 340)
    expect(tooltipPosition({ left: 900, right: 1100, top: 790 }, viewport).top).toBe(800 - 420)
    expect(tooltipPosition({ left: 0, right: 10, top: -100 }, viewport).top).toBe(12)
  })

  it('draws edges from the right of the parent to the left of the child', () => {
    expect(edgePath({ x: 0, y: 0 }, { x: COLUMN_WIDTH, y: 0 })).toMatch(/^M 196 32 C/)
  })

  it('prefers webm and falls back to mp4', () => {
    expect(pickVideoMime((m) => m.startsWith('video/webm'))).toBe('video/webm;codecs=vp9')
    expect(pickVideoMime((m) => m === 'video/mp4')).toBe('video/mp4')
    expect(pickVideoMime(() => false)).toBeNull()
  })
})
