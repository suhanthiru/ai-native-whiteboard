import { useMemo } from 'react'
import { motion } from 'motion/react'
import katex from 'katex'
import type { PluginApi } from '@wb/sdk'
import { viewAt, type ExplainerSpec } from './spec'

export const VIEW_W = 1000
export const VIEW_H = 620
const MARGIN = 60
const NODE_R = 34
const FILL_OPACITY = 0.16

const gx = (x: number) => MARGIN + (x / 10) * (VIEW_W - MARGIN * 2)
const gy = (y: number) => MARGIN + (y / 6) * (VIEW_H - MARGIN * 2)

interface ViewProps {
  api: PluginApi
  spec: ExplainerSpec
  step: number
}

function NodeShape({ shape, color, highlight, accent, width }: { shape: string; color: string; highlight: boolean; accent: string; width: number }) {
  const stroke = highlight ? accent : color
  const sw = highlight ? width * 2.5 : width * 1.5
  if (shape === 'circle') return <circle r={NODE_R} fill={color} fillOpacity={FILL_OPACITY} stroke={stroke} strokeWidth={sw} />
  if (shape === 'diamond') return <polygon points={`0,${-NODE_R * 1.15} ${NODE_R * 1.15},0 0,${NODE_R * 1.15} ${-NODE_R * 1.15},0`} fill={color} fillOpacity={FILL_OPACITY} stroke={stroke} strokeWidth={sw} />
  if (shape === 'pill') return <rect x={-NODE_R * 1.6} y={-NODE_R * 0.7} width={NODE_R * 3.2} height={NODE_R * 1.4} rx={NODE_R * 0.7} fill={color} fillOpacity={FILL_OPACITY} stroke={stroke} strokeWidth={sw} />
  return <rect x={-NODE_R * 1.6} y={-NODE_R * 0.85} width={NODE_R * 3.2} height={NODE_R * 1.7} rx={14} fill={color} fillOpacity={FILL_OPACITY} stroke={stroke} strokeWidth={sw} />
}

/** Trim a centre-to-centre line so it starts and ends at the node outlines. */
function trimmed(x1: number, y1: number, x2: number, y2: number, pad: number): [number, number, number, number] {
  const d = Math.hypot(x2 - x1, y2 - y1) || 1
  const ux = (x2 - x1) / d
  const uy = (y2 - y1) / d
  return [x1 + ux * pad, y1 + uy * pad, x2 - ux * (pad + 6), y2 - uy * (pad + 6)]
}

export function ExplainerView({ api, spec, step }: ViewProps) {
  const theme = api.design.theme()
  const enter = api.motion.presets.enter
  const spring = api.motion.toFramer('standard')
  const view = useMemo(() => viewAt(spec, step), [spec, step])
  const nodes = new Map(spec.nodes.map((n) => [n.id, n]))
  const textSize = api.design.typeSize(theme, 'md')
  const small = api.design.typeSize(theme, 'sm')
  const appear = (id: string, index: number) =>
    view.fresh.has(id)
      ? { initial: { opacity: 0, scale: enter.fromScale * 0.9 }, animate: { opacity: 1, scale: 1 }, transition: api.motion.toFramer('standard', api.motion.staggerDelay(index)) }
      : { initial: false as const, animate: { opacity: 1, scale: 1 }, transition: spring }

  return (
    <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} width="100%" height="100%" style={{ fontFamily: api.design.font.sans }}>
      <defs>
        {spec.edges.map((e) => (
          <marker key={e.id} id={`arrow-${e.id}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill={api.design.dataColor(e.color)} />
          </marker>
        ))}
      </defs>

      {spec.groups.filter((g) => view.visible.has(g.id)).map((g, i) => {
        const members = g.members.map((m) => nodes.get(m)).filter((n): n is NonNullable<typeof n> => !!n)
        const xs = members.map((n) => gx(n.x))
        const ys = members.map((n) => gy(n.y))
        const pad = NODE_R * 2
        const x = Math.min(...xs) - pad
        const y = Math.min(...ys) - pad
        return (
          <motion.g key={g.id} {...appear(g.id, i)}>
            <rect x={x} y={y} width={Math.max(...xs) - x + pad} height={Math.max(...ys) - y + pad} rx={20} fill="none" stroke={view.highlight.has(g.id) ? theme.colors.accent : theme.colors.hairlineStrong} strokeDasharray="6 6" strokeWidth={theme.hairlineWidth * 1.5} />
            <text x={x + 14} y={y - 10} fill={theme.colors.textSecondary} fontSize={small}>{g.label}</text>
          </motion.g>
        )
      })}

      {spec.edges.filter((e) => view.visible.has(e.id)).map((e, i) => {
        const a = nodes.get(e.from)
        const b = nodes.get(e.to)
        if (!a || !b) return null
        const [x1, y1, x2, y2] = trimmed(gx(a.x), gy(a.y), gx(b.x), gy(b.y), NODE_R + 8)
        const color = api.design.dataColor(e.color)
        const fresh = view.fresh.has(e.id)
        return (
          <g key={e.id}>
            <motion.line
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke={view.highlight.has(e.id) ? theme.colors.accent : color}
              strokeWidth={theme.hairlineWidth * (view.highlight.has(e.id) ? 3 : 2)}
              strokeDasharray={e.dashed ? '8 7' : undefined}
              markerEnd={`url(#arrow-${e.id})`}
              initial={fresh ? { pathLength: 0, opacity: 0 } : false}
              animate={{ pathLength: 1, opacity: 1 }}
              transition={{ duration: api.motion.presets.reveal.lineMs / 1000, ease: api.motion.easingCurves.standard, delay: api.motion.staggerDelay(i) / 1000 }}
            />
            {e.label && (
              <motion.text {...appear(e.id, i)} x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 10} textAnchor="middle" fill={theme.colors.textPrimary} fontSize={small} style={{ paintOrder: 'stroke', stroke: theme.colors.stage, strokeWidth: 6 }}>
                {e.label}
              </motion.text>
            )}
          </g>
        )
      })}

      {spec.nodes.filter((n) => view.visible.has(n.id)).map((n, i) => {
        const kind = spec.kinds[n.kind]
        if (!kind) return null
        const color = api.design.dataColor(kind.color)
        const inside = kind.shape === 'rounded' || kind.shape === 'pill'
        return (
          <g key={n.id} transform={`translate(${gx(n.x)}, ${gy(n.y)})`}>
            <motion.g {...appear(n.id, i)}>
              <NodeShape shape={kind.shape} color={color} highlight={view.highlight.has(n.id)} accent={theme.colors.accent} width={theme.hairlineWidth} />
              <text y={inside ? textSize * 0.35 : textSize * 0.35} textAnchor="middle" fill={theme.colors.textPrimary} fontSize={textSize} fontWeight={api.design.font.weight.semibold}>
                {n.label}
              </text>
              {!inside && kind.name && (
                <text y={NODE_R + small + 8} textAnchor="middle" fill={color} fontSize={small}>
                  {kind.name}
                </text>
              )}
            </motion.g>
          </g>
        )
      })}

      {spec.equations.filter((q) => view.visible.has(q.id)).map((q, i) => (
        <motion.g key={q.id} {...appear(q.id, i)}>
          <foreignObject x={gx(q.x) - 260} y={gy(q.y) - 30} width={520} height={60}>
            <div
              style={{ color: view.highlight.has(q.id) ? theme.colors.accent : theme.colors.textPrimary, fontSize: textSize * 1.3, textAlign: 'center' }}
              dangerouslySetInnerHTML={{ __html: katex.renderToString(q.tex, { output: 'mathml', throwOnError: false }) }}
            />
          </foreignObject>
        </motion.g>
      ))}
    </svg>
  )
}
