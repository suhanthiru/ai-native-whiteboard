/**
 * Turns the plugin list into skill trees for the viewer: one tree per domain,
 * skills placed in columns by how deep they build on other skills of the same
 * tree. Pure functions, so the layout is tested without a browser.
 */
import { DEFAULT_SKILL_META, type PluginInfo, type SkillMeta } from '@wb/sdk'

export const COLUMN_WIDTH = 236
export const ROW_HEIGHT = 92
export const NODE_WIDTH = 196
export const NODE_HEIGHT = 64
/** Skills learned within this window get a "new" badge. */
export const NEW_WINDOW_MS = 3 * 24 * 60 * 60 * 1000

export interface SkillNode {
  info: PluginInfo
  skill: SkillMeta
  /** 0 for roots; 1 + the deepest in-tree parent otherwise. */
  depth: number
  row: number
  x: number
  y: number
  /** Parents that live in another tree (shown as links, not edges). */
  crossParents: string[]
  isNew: boolean
}

export interface SkillEdge {
  from: string
  to: string
}

export interface SkillTree {
  name: string
  nodes: SkillNode[]
  edges: SkillEdge[]
  width: number
  height: number
  newCount: number
  /** Newest change in this tree (ISO), for ordering. */
  updatedAt: string
}

/** The plugin's skill data, with duplicate and self parents removed. */
export function skillOf(info: PluginInfo): SkillMeta {
  const skill = info.skill ?? DEFAULT_SKILL_META
  return { ...skill, parents: [...new Set(skill.parents)].filter((p) => p !== info.name) }
}

/** Depth of every skill within its tree; cycles and missing parents count as roots. */
export function depthsOf(skills: readonly PluginInfo[]): Map<string, number> {
  const byName = new Map(skills.map((s) => [s.name, s]))
  const depths = new Map<string, number>()
  const visit = (name: string, trail: Set<string>): number => {
    const known = depths.get(name)
    if (known !== undefined) return known
    const info = byName.get(name)
    if (!info || trail.has(name)) return -1
    const next = new Set(trail).add(name)
    const parentDepths = skillOf(info)
      .parents.filter((p) => byName.has(p))
      .map((p) => visit(p, next))
      .filter((d) => d >= 0)
    const depth = parentDepths.length ? Math.max(...parentDepths) + 1 : 0
    depths.set(name, depth)
    return depth
  }
  for (const s of skills) visit(s.name, new Set())
  return depths
}

function isRecent(updatedAt: string | undefined, now: number): boolean {
  if (!updatedAt) return false
  const t = Date.parse(updatedAt)
  return Number.isFinite(t) && now - t < NEW_WINDOW_MS
}

/** Lay out one tree: columns by depth, rows ordered by the average row of their parents, then name. */
export function layoutTree(name: string, skills: readonly PluginInfo[], now: number): SkillTree {
  const depths = depthsOf(skills)
  const inTree = new Set(skills.map((s) => s.name))
  const rows = new Map<string, number>()
  const columns = new Map<number, PluginInfo[]>()
  for (const s of skills) {
    const d = depths.get(s.name) ?? 0
    columns.set(d, [...(columns.get(d) ?? []), s])
  }
  const maxDepth = Math.max(0, ...columns.keys())
  for (let d = 0; d <= maxDepth; d += 1) {
    const column = columns.get(d) ?? []
    const anchor = (s: PluginInfo) => {
      const parentRows = skillOf(s).parents.map((p) => rows.get(p)).filter((r): r is number => r !== undefined)
      return parentRows.length ? parentRows.reduce((a, b) => a + b, 0) / parentRows.length : Number.POSITIVE_INFINITY
    }
    const ordered = [...column].sort((a, b) => anchor(a) - anchor(b) || a.name.localeCompare(b.name))
    ordered.forEach((s, i) => rows.set(s.name, i))
  }
  const nodes: SkillNode[] = skills.map((info) => {
    const skill = skillOf(info)
    const depth = depths.get(info.name) ?? 0
    const row = rows.get(info.name) ?? 0
    return { info, skill, depth, row, x: depth * COLUMN_WIDTH, y: row * ROW_HEIGHT, crossParents: skill.parents.filter((p) => !inTree.has(p)), isNew: isRecent(info.updatedAt, now) }
  })
  const edges = nodes.flatMap((n) => n.skill.parents.filter((p) => inTree.has(p) && p !== n.info.name).map((p) => ({ from: p, to: n.info.name })))
  const tallest = Math.max(1, ...[...columns.values()].map((c) => c.length))
  const updatedAt = skills.map((s) => s.updatedAt ?? '').sort().at(-1) ?? ''
  return {
    name,
    nodes,
    edges,
    width: maxDepth * COLUMN_WIDTH + NODE_WIDTH,
    height: (tallest - 1) * ROW_HEIGHT + NODE_HEIGHT,
    newCount: nodes.filter((n) => n.isNew).length,
    updatedAt,
  }
}

/** Every tree, most recently grown first. */
export function buildSkillForest(plugins: readonly PluginInfo[], now: number = Date.now()): SkillTree[] {
  const groups = new Map<string, PluginInfo[]>()
  for (const p of plugins) {
    const tree = skillOf(p).tree
    groups.set(tree, [...(groups.get(tree) ?? []), p])
  }
  return [...groups.entries()].map(([name, skills]) => layoutTree(name, skills, now)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.name.localeCompare(b.name))
}

/** Case-insensitive match on name, description, explainer, examples and tree. */
export function matchesSkill(node: SkillNode, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [node.info.name, node.info.description, node.skill.explainer, node.skill.tree, ...node.skill.examples].some((t) => t.toLowerCase().includes(q))
}

/** "chemistry" -> "Chemistry", "computer-vision" -> "Computer vision". */
export function treeTitle(name: string): string {
  const spaced = name.replace(/-/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}
