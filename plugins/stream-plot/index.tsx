import { z } from 'zod'
import { definePlugin, type PanelProps, type PluginApi } from '@wb/sdk'
import { pickField, polyline, resolveTopic, toSeries } from './series'

const WIDTH = 360
const HEIGHT = 220
const PLOT_H = 110
const WINDOW_S = 10
const HISTORY = 1500

interface PlotProps {
  topic: string
  field?: string
}

function PlotPanel({ api, props }: PanelProps<PlotProps>) {
  const useBusLatest = api.ui.useBusLatest as (topic: string) => { t: number; data: unknown } | undefined
  const latest = useBusLatest(props.topic) // re-renders once per frame while data flows
  const theme = api.design.theme()
  const color = api.design.dataColor(api.design.kindForTopic(props.topic))
  if (!latest) return <div className="wb-panel-body wb-text-sm wb-muted">Waiting for {props.topic}…</div>
  const field = pickField(latest.data, props.field)
  if (field === null) return <div className="wb-panel-body wb-text-sm wb-muted">{props.topic} has no numeric field to plot.</div>
  const series = toSeries(api.bus.history(props.topic, HISTORY), field, WINDOW_S)
  const plotW = WIDTH - api.design.space[4] * 2
  const { points, min, max } = polyline(series, plotW, PLOT_H)
  const current = series[series.length - 1]?.v
  return (
    <div className="wb-panel-body" style={{ display: 'flex', flexDirection: 'column', gap: api.design.space[2] }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: api.design.space[2] }}>
        <span className="wb-text-xl wb-mono" style={{ color }}>{current !== undefined ? current.toFixed(2) : '—'}</span>
        <span className="wb-text-sm wb-muted">{field || 'value'}</span>
        <span className="wb-text-xs wb-faint" style={{ marginLeft: 'auto' }}>{props.topic}</span>
      </div>
      <svg width={plotW} height={PLOT_H} role="img" aria-label={`${props.topic} over the last ${WINDOW_S} seconds`}>
        <line x1={0} y1={PLOT_H - 0.5} x2={plotW} y2={PLOT_H - 0.5} stroke={theme.colors.hairline} />
        <line x1={0} y1={0.5} x2={plotW} y2={0.5} stroke={theme.colors.hairline} />
        {points && <polyline points={points} fill="none" stroke={color} strokeWidth={theme.hairlineWidth * 2} strokeLinejoin="round" strokeLinecap="round" />}
      </svg>
      <div className="wb-text-xs wb-faint wb-mono" style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span>min {Number.isFinite(min) ? min.toFixed(2) : '—'}</span>
        <span>last {WINDOW_S}s</span>
        <span>max {Number.isFinite(max) ? max.toFixed(2) : '—'}</span>
      </div>
    </div>
  )
}

const input = z.object({
  topic: z.string().min(1).describe('Bus topic or a loose name, e.g. "titan/left_encoder" or "left encoder"'),
  field: z.string().optional().describe('Numeric field path, e.g. "velocity" or "angular_velocity.z". Picked automatically if omitted.'),
  part: z.string().optional().describe('3D part to place the plot next to, e.g. "left_encoder"'),
})

export async function showPlot(api: PluginApi, args: z.infer<typeof input>): Promise<string> {
  const topics = api.bus.topics()
  const topic = resolveTopic(args.topic, topics)
  if (!topic) {
    return topics.length ? `No live topic matches "${args.topic}". Live topics: ${topics.join(', ')}` : 'Nothing is publishing yet. Start a data source first (for example plugin_mcap_playback_play).'
  }
  const guess = topic.split('/').pop() ?? ''
  const anchorPart = args.part ?? (api.scene.parts().includes(guess) ? guess : undefined)
  await api.panels.open('plot', { topic, field: args.field }, { anchorPart })
  return `Plotting ${topic}${anchorPart ? ` next to ${anchorPart}` : ''}.`
}

export default definePlugin({
  setup(api) {
    api.registerPanel({ id: 'plot', title: 'Live', component: PlotPanel, width: WIDTH, height: HEIGHT })
    api.registerTool({
      name: 'show_stream_plot',
      description: 'Show a live plot of a data-bus topic, optionally next to a 3D part ("focus on the left encoder, show it live").',
      input,
      run: (args) => showPlot(api, args),
    })
  },
})
