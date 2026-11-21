/**
 * Explainer spec: a fixed vocabulary so generated explainers stay on-brand.
 * Every element is introduced by a step; each kind keeps one shape and one
 * color for the whole explainer.
 */
import { z } from 'zod'

export const CONCEPT_COLORS = ['state', 'observation', 'belief', 'action', 'reward', 'transition', 'neutral'] as const
export const SHAPES = ['circle', 'rounded', 'diamond', 'pill'] as const

const id = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/, 'ids are short words: letters, digits, _ or -')
const gridX = z.number().min(0).max(10)
const gridY = z.number().min(0).max(6)

export const explainerSpecSchema = z
  .object({
    title: z.string().min(1).max(80),
    kinds: z
      .record(
        id,
        z.object({
          shape: z.enum(SHAPES),
          color: z.enum(CONCEPT_COLORS),
          /** Shown in the legend-free key line under the title, e.g. "state". */
          name: z.string().max(24).optional(),
        }),
      )
      .refine((k) => Object.keys(k).length >= 1 && Object.keys(k).length <= 6, 'between 1 and 6 kinds'),
    nodes: z.array(z.object({ id, kind: id, label: z.string().min(1).max(24), x: gridX, y: gridY })).min(1).max(24),
    edges: z.array(z.object({ id, from: id, to: id, label: z.string().max(28).optional(), color: z.enum(CONCEPT_COLORS).default('transition'), dashed: z.boolean().default(false) })).max(40).default([]),
    groups: z.array(z.object({ id, label: z.string().max(28), members: z.array(id).min(1) })).max(6).default([]),
    equations: z.array(z.object({ id, tex: z.string().min(1).max(240), x: gridX, y: gridY })).max(4).default([]),
    steps: z
      .array(
        z.object({
          caption: z.string().min(1).max(160),
          add: z.array(id).default([]),
          highlight: z.array(id).default([]),
          remove: z.array(id).default([]),
        }),
      )
      .min(1)
      .max(16),
  })
  .superRefine((spec, ctx) => {
    const nodeIds = new Set(spec.nodes.map((n) => n.id))
    const all = new Set([...nodeIds, ...spec.edges.map((e) => e.id), ...spec.groups.map((g) => g.id), ...spec.equations.map((q) => q.id)])
    if (all.size !== spec.nodes.length + spec.edges.length + spec.groups.length + spec.equations.length) ctx.addIssue({ code: 'custom', message: 'element ids must be unique' })
    for (const n of spec.nodes) if (!spec.kinds[n.kind]) ctx.addIssue({ code: 'custom', message: `node ${n.id} uses undefined kind ${n.kind}` })
    for (const e of spec.edges) {
      if (!nodeIds.has(e.from) || !nodeIds.has(e.to)) ctx.addIssue({ code: 'custom', message: `edge ${e.id} must connect two nodes` })
    }
    for (const g of spec.groups) for (const m of g.members) if (!nodeIds.has(m)) ctx.addIssue({ code: 'custom', message: `group ${g.id} lists unknown node ${m}` })
    const introduced = new Set<string>()
    spec.steps.forEach((s, i) => {
      for (const ref of [...s.add, ...s.highlight, ...s.remove]) if (!all.has(ref)) ctx.addIssue({ code: 'custom', message: `step ${i + 1} refers to unknown element ${ref}` })
      for (const a of s.add) introduced.add(a)
    })
    for (const el of all) if (!introduced.has(el)) ctx.addIssue({ code: 'custom', message: `${el} is never added by a step` })
    for (const e of spec.edges) {
      const step = (x: string) => spec.steps.findIndex((s) => s.add.includes(x))
      if (step(e.id) < Math.max(step(e.from), step(e.to))) ctx.addIssue({ code: 'custom', message: `edge ${e.id} appears before the nodes it connects` })
    }
  })

export type ExplainerSpec = z.infer<typeof explainerSpecSchema>

export interface StepView {
  visible: Set<string>
  /** Elements that appear in this step (they animate in). */
  fresh: Set<string>
  highlight: Set<string>
  caption: string
}

/** What is on screen at a step: everything added so far, minus what was removed. */
export function viewAt(spec: ExplainerSpec, step: number): StepView {
  const index = Math.max(0, Math.min(step, spec.steps.length - 1))
  const visible = new Set<string>()
  for (let i = 0; i <= index; i += 1) {
    const s = spec.steps[i]
    if (!s) continue
    for (const a of s.add) visible.add(a)
    for (const r of s.remove) visible.delete(r)
  }
  const current = spec.steps[index]
  return { visible, fresh: new Set(current?.add ?? []), highlight: new Set(current?.highlight ?? []), caption: current?.caption ?? '' }
}

export function parseSpec(raw: unknown): { ok: true; spec: ExplainerSpec } | { ok: false; error: string } {
  const r = explainerSpecSchema.safeParse(raw)
  if (r.success) return { ok: true, spec: r.data }
  return { ok: false, error: r.error.issues.map((i) => `${i.path.join('.') || 'spec'}: ${i.message}`).join('; ') }
}
