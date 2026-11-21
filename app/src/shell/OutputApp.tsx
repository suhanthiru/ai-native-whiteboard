import { useMemo } from 'react'
import { themes } from '@wb/sdk'
import { CanvasHost } from '../core/canvas/CanvasHost'
import { ErrorBoundary } from '../core/ErrorBoundary'
import { useAppState } from '../core/rpc/client'
import { Stage } from '../core/scene/Stage'
import { PanelLayer } from './PanelLayer'
import { usePluginRuntime } from './usePlugins'
import { Warp } from './Warp'

/** Projector output: solid black, bright hairlines, larger type, no blur. Read-only mirror. */
export function OutputApp() {
  const state = useAppState()
  const runtime = usePluginRuntime('output')
  const view = state.output.view
  const anchorParts = useMemo(() => state.panels.map((p) => p.anchorPart).filter((p): p is string => !!p), [state.panels])
  const half = view === 'split'

  return (
    <Warp corners={state.output.warp} calibrating={state.output.calibrating}>
      <div style={{ position: 'absolute', inset: 0, right: half ? '50%' : 0, display: view === 'scene' ? 'none' : 'block' }}>
        <ErrorBoundary source="canvas">
          <CanvasHost role="output" runtime={runtime} />
        </ErrorBoundary>
      </div>
      <div style={{ position: 'absolute', inset: 0, left: half ? '50%' : 0, display: view === 'canvas' ? 'none' : 'block' }}>
        <ErrorBoundary source="3D scene">
          <Stage scene={state.scene} theme={themes.projector} interactive={false} anchorParts={anchorParts} />
        </ErrorBoundary>
      </div>
      <PanelLayer panels={state.panels} runtime={runtime} stageOrigin={{ left: 0, top: 0 }} readOnly />
    </Warp>
  )
}
