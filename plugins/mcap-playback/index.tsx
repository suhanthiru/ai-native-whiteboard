import { useState } from 'react'
import { z } from 'zod'
import { definePlugin, pluginToolName, type PanelProps, type PluginApi } from '@wb/sdk'

interface PlaybackStatus {
  playing: boolean
  t: number
  duration: number
  rate: number
  file: string
}

const RATES = [0.5, 1, 2]
const tool = (name: string) => pluginToolName('mcap-playback', name)

function format(t: number): string {
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

function PlaybackPanel({ api }: PanelProps) {
  const useBusLatest = api.ui.useBusLatest as <T>(topic: string) => { data: T } | undefined
  const prefix = (api.board.config().topicPrefix as string | undefined) ?? 'titan'
  const status = useBusLatest<PlaybackStatus>(`${prefix}/playback`)?.data
  const [error, setError] = useState('')
  const call = (name: string, args: Record<string, unknown> = {}) => {
    api.callTool(tool(name), args).then(
      () => setError(''),
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    )
  }
  if (!status) return <div className="wb-panel-body wb-text-sm wb-muted">Waiting for the log…</div>
  return (
    <div className="wb-panel-body" style={{ display: 'flex', flexDirection: 'column', gap: api.design.space[3] }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: api.design.space[3] }}>
        <button type="button" className="wb-button wb-button--primary" onClick={() => call(status.playing ? 'pause' : 'play')} data-testid="playback-toggle">
          {status.playing ? 'Pause' : 'Play'}
        </button>
        <span className="wb-text-sm wb-mono">
          {format(status.t)} / {format(status.duration)}
        </span>
        <span className="wb-text-xs wb-faint" style={{ marginLeft: 'auto' }}>
          {status.file}
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={status.duration}
        step={0.1}
        value={status.t}
        onChange={(e) => call('seek', { t: Number(e.target.value) })}
        style={{ width: '100%', accentColor: 'var(--wb-accent)' }}
        aria-label="Position"
      />
      <div className="wb-segmented wb-glass wb-glass--pill" role="group" style={{ alignSelf: 'flex-start' }}>
        {RATES.map((r) => (
          <button key={r} type="button" aria-pressed={status.rate === r} onClick={() => call('set_rate', { rate: r })}>
            {r}x
          </button>
        ))}
      </div>
      {error && <div className="wb-text-xs" style={{ color: 'var(--wb-danger)' }}>{error}</div>}
    </div>
  )
}

export async function showPlayback(api: PluginApi): Promise<string> {
  const id = await api.panels.open('playback')
  return `Playback controls open (${id}).`
}

export default definePlugin({
  setup(api) {
    api.registerPanel({ id: 'playback', title: 'Playback', component: PlaybackPanel, width: 380, height: 168 })
    api.registerTool({
      name: 'show_playback',
      description: 'Open the playback controls (play, pause, scrub, speed) for the recorded log.',
      input: z.object({}),
      run: () => showPlayback(api),
    })
  },
})
