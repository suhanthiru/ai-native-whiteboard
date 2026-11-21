import { useMemo } from 'react'
import { BaseBoxShapeUtil, HTMLContainer, T } from 'tldraw'
import { z } from 'zod'
import { definePlugin, type PluginApi } from '@wb/sdk'
import pomdp from './examples/pomdp.json'
import { parseSpec, viewAt, type ExplainerSpec } from './spec'
import { ExplainerView, VIEW_H, VIEW_W } from './view'

const TYPE = 'explainer'
const CAPTION_H = 96
const EXAMPLES: Record<string, unknown> = { pomdp }

interface ExplainerProps {
  w: number
  h: number
  spec: string
  step: number
}

interface ExplainerShape {
  id: string
  type: typeof TYPE
  props: ExplainerProps
}

interface EditorLike {
  getShape(id: string): ExplainerShape | undefined
}

function makeShapeUtil(api: PluginApi) {
  function Body({ shape }: { shape: ExplainerShape }) {
    const parsed = useMemo(() => parseSpec(JSON.parse(shape.props.spec) as unknown), [shape.props.spec])
    if (!parsed.ok) return <HTMLContainer className="wb-error-card">{parsed.error}</HTMLContainer>
    const { spec } = parsed
    const view = viewAt(spec, shape.props.step)
    const step = Math.min(shape.props.step, spec.steps.length - 1)
    return (
      <HTMLContainer className="wb-glass wb-glass--strong" style={{ width: shape.props.w, height: shape.props.h, display: 'flex', flexDirection: 'column', overflow: 'hidden', pointerEvents: 'all' }}>
        <div className="wb-panel-header">
          <span className="wb-text-lg">{spec.title}</span>
          <span className="wb-text-sm wb-muted wb-mono">
            {step + 1} / {spec.steps.length}
          </span>
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          <ExplainerView api={api} spec={spec} step={step} />
        </div>
        <div className="wb-panel-body" style={{ height: CAPTION_H, borderTop: 'var(--wb-hairline-w) solid var(--wb-hairline)' }}>
          {(() => {
            const Enter = api.ui.Enter as (p: { children?: React.ReactNode }) => React.ReactNode
            return (
              <Enter key={step}>
                <span className="wb-text-lg">{view.caption}</span>
              </Enter>
            )
          })()}
        </div>
      </HTMLContainer>
    )
  }

  return class ExplainerShapeUtil extends BaseBoxShapeUtil<never> {
    static override type = TYPE
    static override props = { w: T.number, h: T.number, spec: T.string, step: T.number }

    getDefaultProps(): ExplainerProps {
      return { w: VIEW_W, h: VIEW_H + CAPTION_H + 48, spec: JSON.stringify(pomdp), step: 0 }
    }

    component(shape: ExplainerShape) {
      return <Body shape={shape} />
    }

    getIndicatorPath(shape: ExplainerShape) {
      const path = new Path2D()
      path.roundRect(0, 0, shape.props.w, shape.props.h, api.design.radius.lg)
      return path
    }
  }
}

interface Tracked {
  spec: ExplainerSpec
  step: number
}

const createInput = z.object({
  example: z.enum(['pomdp']).optional().describe('Use a built-in explainer instead of writing a spec.'),
  spec: z
    .unknown()
    .optional()
    .describe(
      'Explainer spec: { title, kinds: {k: {shape: circle|rounded|diamond|pill, color: state|observation|belief|action|reward|transition|neutral, name}}, nodes: [{id, kind, label, x 0-10, y 0-6}], edges: [{id, from, to, label?, color?, dashed?}], groups?: [{id, label, members}], equations?: [{id, tex, x, y}], steps: [{caption, add: [ids], highlight?: [ids], remove?: [ids]}] }. One idea per step; every element is added by a step.',
    ),
})

const stepInput = z.object({
  action: z.enum(['next', 'prev', 'first', 'last', 'goto']).default('next'),
  index: z.number().int().min(1).optional().describe('1-based step for goto'),
  id: z.string().optional().describe('Explainer shape id; defaults to the most recent one.'),
})

export function nextStep(current: number, total: number, action: z.infer<typeof stepInput>['action'], index?: number): number {
  const last = total - 1
  if (action === 'first') return 0
  if (action === 'last') return last
  if (action === 'prev') return Math.max(0, current - 1)
  if (action === 'goto') return Math.max(0, Math.min(last, (index ?? 1) - 1))
  return Math.min(last, current + 1)
}

export default definePlugin({
  setup(api) {
    api.registerShape(makeShapeUtil(api))
    const tracked = new Map<string, Tracked>()
    let latest: string | null = null

    const lookup = (id: string): Tracked | null => {
      const known = tracked.get(id)
      if (known) return known
      const shape = (api.canvas.editor as EditorLike | null)?.getShape(id)
      if (!shape) return null
      const parsed = parseSpec(JSON.parse(shape.props.spec) as unknown)
      return parsed.ok ? { spec: parsed.spec, step: shape.props.step } : null
    }

    api.registerTool({
      name: 'create_explainer',
      description: 'Create a step-by-step visual explainer on the canvas (it also shows on the projector). Pass a spec, or example: "pomdp". Then advance with explainer_step and narrate each caption.',
      input: createInput,
      run: ({ example, spec }) => {
        const raw = example ? EXAMPLES[example] : spec
        if (!raw) throw new Error('pass a spec or an example')
        const parsed = parseSpec(raw)
        if (!parsed.ok) throw new Error(`invalid explainer spec: ${parsed.error}`)
        const id = api.canvas.createShape({ type: TYPE, props: { spec: JSON.stringify(parsed.spec), step: 0, w: VIEW_W, h: VIEW_H + CAPTION_H + 48 } })
        tracked.set(id, { spec: parsed.spec, step: 0 })
        latest = id
        api.canvas.zoomTo(id)
        return { id, steps: parsed.spec.steps.length, text: `Created "${parsed.spec.title}" (${parsed.spec.steps.length} steps). Step 1: ${parsed.spec.steps[0]?.caption ?? ''}` }
      },
    })

    api.registerTool({
      name: 'explainer_step',
      description: 'Move an explainer to the next, previous, first, last or a given step. Returns the caption to narrate.',
      input: stepInput,
      run: ({ action, index, id }) => {
        const target = id ?? latest
        if (!target) throw new Error('no explainer yet; call create_explainer first')
        const t = lookup(target)
        if (!t) throw new Error(`no explainer ${target} on the canvas`)
        const step = nextStep(t.step, t.spec.steps.length, action, index)
        tracked.set(target, { ...t, step })
        latest = target
        api.canvas.updateShape(target, { step })
        return { step: step + 1, of: t.spec.steps.length, text: `Step ${step + 1} of ${t.spec.steps.length}: ${t.spec.steps[step]?.caption ?? ''}` }
      },
    })
  },
})
