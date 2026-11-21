import { useSyncExternalStore } from 'react'
import { AnimatePresence } from 'motion/react'
import type { PanelInstance } from '@wb/sdk'
import { ErrorBoundary } from '../core/ErrorBoundary'
import { Button, GlassPanel } from '../core/design/ui'
import type { PluginRuntime } from '../core/plugins/runtime'
import { sidecar } from '../core/rpc/client'
import { useAnchor } from '../core/scene/anchors'

const DEFAULT_W = 360
const DEFAULT_H = 240
const ANCHOR_GAP = 48
const STACK_GAP = 12

interface PanelHostProps {
  instance: PanelInstance
  runtime: PluginRuntime
  index: number
  /** Offset of the 3D stage inside the window, for anchored panels. */
  stageOrigin: { left: number; top: number }
  readOnly: boolean
}

function PanelHost({ instance, runtime, index, stageOrigin, readOnly }: PanelHostProps) {
  const def = runtime.panel(instance.plugin, instance.panel)
  const api = runtime.apiFor(instance.plugin)
  const anchor = useAnchor(instance.anchorPart)
  if (!def || !api) return null
  const w = def.width ?? DEFAULT_W
  const h = def.height ?? DEFAULT_H
  const close = () => sidecar.send({ type: 'panel_close', id: instance.id })
  const layout =
    anchor && anchor.visible
      ? { position: 'absolute' as const, left: stageOrigin.left + anchor.x + ANCHOR_GAP, top: stageOrigin.top + anchor.y - h / 2, width: w, height: h, zIndex: 30 }
      : { position: 'absolute' as const, right: 16, top: 64 + index * (h + STACK_GAP), width: w, height: h, zIndex: 30 }
  const Component = def.component as (props: { api: typeof api; props: Record<string, unknown>; close: () => void }) => React.ReactNode
  return (
    <GlassPanel title={def.title} actions={readOnly ? undefined : <Button icon title="Close" onClick={close}>×</Button>} layout={layout} testId={`panel-${instance.panel}`}>
      <ErrorBoundary source={`plugin ${instance.plugin}: ${def.title}`} resetKey={runtime.getVersion()}>
        <Component api={api} props={instance.props} close={close} />
      </ErrorBoundary>
    </GlassPanel>
  )
}

interface PanelLayerProps {
  panels: PanelInstance[]
  runtime: PluginRuntime
  stageOrigin: { left: number; top: number }
  readOnly?: boolean
}

export function PanelLayer({ panels, runtime, stageOrigin, readOnly = false }: PanelLayerProps) {
  useSyncExternalStore(runtime.subscribe, runtime.getVersion)
  return (
    <AnimatePresence>
      {panels.map((p, i) => (
        <PanelHost key={p.id} instance={p} runtime={runtime} index={i} stageOrigin={stageOrigin} readOnly={readOnly} />
      ))}
    </AnimatePresence>
  )
}
