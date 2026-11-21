import { useEffect, useState } from 'react'
import { BaseBoxShapeUtil, HTMLContainer, T } from 'tldraw'
import { z } from 'zod'
import { definePlugin, type PluginApi } from '@wb/sdk'
import { mermaidTheme } from './theme'

const TYPE = 'mermaid'
const DEFAULT_W = 560
const DEFAULT_H = 380

interface MermaidProps {
  w: number
  h: number
  code: string
}

interface MermaidShape {
  id: string
  type: typeof TYPE
  props: MermaidProps
}

let renderCount = 0

/** Render Mermaid source to an SVG string, themed from tokens. */
export async function renderMermaid(api: Pick<PluginApi, 'design'>, code: string): Promise<string> {
  const mermaid = (await import('mermaid')).default
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'base', themeVariables: mermaidTheme(api) })
  renderCount += 1
  const { svg } = await mermaid.render(`wb-mermaid-${renderCount}`, code)
  return svg
}

function makeShapeUtil(api: PluginApi) {
  const { Enter } = api.ui as { Enter: (p: { children?: React.ReactNode }) => React.ReactNode }

  function MermaidBody({ shape }: { shape: MermaidShape }) {
    const [svg, setSvg] = useState('')
    const [error, setError] = useState('')
    useEffect(() => {
      let alive = true
      renderMermaid(api, shape.props.code)
        .then((out) => alive && (setSvg(out), setError('')))
        .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)))
      return () => {
        alive = false
      }
    }, [shape.props.code])
    return (
      <HTMLContainer className="wb-glass wb-glass--strong" style={{ width: shape.props.w, height: shape.props.h, overflow: 'hidden', pointerEvents: 'all' }}>
        {error ? (
          <div className="wb-error-card">
            <strong>Mermaid could not parse this diagram</strong>
            <pre>{error}</pre>
          </div>
        ) : (
          svg && (
            <Enter>
              {/* Mermaid's strict security level sanitises its own output. */}
              <div className="wb-mermaid" style={{ width: shape.props.w, height: shape.props.h, display: 'grid', placeItems: 'center' }} dangerouslySetInnerHTML={{ __html: svg }} />
            </Enter>
          )
        )}
      </HTMLContainer>
    )
  }

  return class MermaidShapeUtil extends BaseBoxShapeUtil<never> {
    static override type = TYPE
    static override props = { w: T.number, h: T.number, code: T.string }

    getDefaultProps(): MermaidProps {
      return { w: DEFAULT_W, h: DEFAULT_H, code: 'flowchart LR\n  A --> B' }
    }

    component(shape: MermaidShape) {
      return <MermaidBody shape={shape} />
    }

    getIndicatorPath(shape: MermaidShape) {
      const path = new Path2D()
      path.roundRect(0, 0, shape.props.w, shape.props.h, api.design.radius.lg)
      return path
    }
  }
}

const createInput = z.object({
  code: z.string().min(3).max(20_000).describe('Mermaid source, e.g. "flowchart LR\\n  Boot --> Init --> Ready"'),
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().min(160).max(2400).optional(),
  height: z.number().min(120).max(1800).optional(),
})

const updateInput = z.object({ id: z.string().min(1), code: z.string().min(3).max(20_000) })

export default definePlugin({
  setup(api) {
    api.registerShape(makeShapeUtil(api))

    api.registerTool({
      name: 'create_mermaid',
      description: 'Draw a Mermaid diagram (flowchart, sequenceDiagram, stateDiagram-v2, classDiagram, ...) on the canvas. Returns the shape id.',
      input: createInput,
      run: ({ code, x, y, width, height }) => {
        const id = api.canvas.createShape({ type: TYPE, x, y, props: { code, w: width ?? DEFAULT_W, h: height ?? DEFAULT_H } })
        return { id, text: `Mermaid diagram created (${id}).` }
      },
    })

    api.registerTool({
      name: 'update_mermaid',
      description: 'Replace the source of an existing Mermaid diagram.',
      input: updateInput,
      run: ({ id, code }) => {
        api.canvas.updateShape(id, { code })
        return `Updated ${id}.`
      },
    })
  },
})
