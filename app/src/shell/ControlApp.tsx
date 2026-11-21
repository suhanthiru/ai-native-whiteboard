import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { AnimatePresence } from 'motion/react'
import { toRichText, type TLShapePartial } from 'tldraw'
import { themes } from '@wb/sdk'
import { CanvasHost } from '../core/canvas/CanvasHost'
import { createShape, getEditor, viewportCenter } from '../core/canvas/controller'
import { saveDocument } from '../core/canvas/snapshot'
import { CARD_TYPE } from '../core/canvas/CardShape'
import { Button, Segmented } from '../core/design/ui'
import { ErrorBoundary } from '../core/ErrorBoundary'
import { sidecar, useAppState, useConnected } from '../core/rpc/client'
import { Stage } from '../core/scene/Stage'
import { CommandBar } from './CommandBar'
import { Notices, PluginTray } from './Overlays'
import { PanelLayer } from './PanelLayer'
import { recordCanvasElement, snapshotNewShapes } from './previewRecorder'
import { SkillTrees } from './SkillTrees'
import { ReplyPlayer } from './audio'
import { usePluginRuntime } from './usePlugins'
import { openOutputWindow } from './tauri'

type Layout = 'canvas' | 'split' | 'scene'

const GUTTER = 12
const TOP = 56
const NOTE_WIDTH = 320

function useCanvasRpc(): void {
  useEffect(() => {
    const offNote = sidecar.handleRpc('canvas.note', (p) => {
      const { text, x, y } = p as { text: string; x?: number; y?: number }
      const editor = getEditor()
      if (!editor) throw new Error('The canvas is not ready yet.')
      const c = viewportCenter()
      return createShapeNote(text, x ?? c.x - NOTE_WIDTH / 2, y ?? c.y - NOTE_WIDTH / 2)
    })
    const offCard = sidecar.handleRpc('canvas.card', (p) => {
      const { svg, html } = p as { svg?: string; html?: string }
      return createShape({ type: CARD_TYPE, props: { w: 520, h: 380, title: 'Result', svg: svg ?? '', html: html ?? '' } })
    })
    const offSnap = sidecar.handleRpc('canvas.snapshot', () => {
      const editor = getEditor()
      return editor ? saveDocument(editor) : null
    })
    return () => {
      offNote()
      offCard()
      offSnap()
    }
  }, [])
}

/** Two frames, so a layout change has painted before recording starts. */
const nextPaint = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))

/** rpc "preview.record": capture a skill in action for the skill viewer. */
function usePreviewRpc(layout: Layout, setLayout: (l: Layout) => void, stage: RefObject<HTMLDivElement | null>): void {
  const layoutRef = useRef(layout)
  layoutRef.current = layout
  useEffect(
    () =>
      sidecar.handleRpc('preview.record', async (p) => {
        const { view, seconds } = p as { view: 'scene' | 'canvas'; seconds: number }
        const hidden = view === 'scene' ? layoutRef.current === 'canvas' : layoutRef.current === 'scene'
        if (hidden) {
          setLayout('split')
          await nextPaint()
        }
        if (view === 'canvas') {
          const editor = getEditor()
          if (!editor) throw new Error('The canvas is not ready yet.')
          return snapshotNewShapes(editor, new Set(editor.getCurrentPageShapeIds()), seconds)
        }
        const canvas = stage.current?.querySelector('canvas')
        if (!canvas) throw new Error('The 3D view is not ready yet.')
        return recordCanvasElement(canvas, seconds)
      }),
    [setLayout, stage],
  )
}

function createShapeNote(text: string, x: number, y: number): string {
  const editor = getEditor()
  if (!editor) throw new Error('The canvas is not ready yet.')
  const id = createShape({ type: 'note', x, y, props: {} })
  editor.updateShape({ id, type: 'note', props: { richText: toRichText(text), color: 'yellow' } } as unknown as TLShapePartial)
  return id
}

export function ControlApp() {
  const state = useAppState()
  const connected = useConnected()
  const runtime = usePluginRuntime('control')
  const [layout, setLayout] = useState<Layout>('split')
  const [trayOpen, setTrayOpen] = useState(false)
  const stageRef = useRef<HTMLDivElement>(null)
  const [stageOrigin, setStageOrigin] = useState({ left: 0, top: 0 })
  const [skillsOpen, setSkillsOpen] = useState(false)
  useCanvasRpc()
  usePreviewRpc(layout, setLayout, stageRef)

  useEffect(() => new ReplyPlayer().connect(), [])
  useEffect(() => {
    const measure = () => {
      const r = stageRef.current?.getBoundingClientRect()
      if (r) setStageOrigin({ left: r.left, top: r.top })
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [layout])

  const onModelInfo = useCallback((file: string, parts: string[]) => sidecar.send({ type: 'model_info', file, parts }), [])
  const anchorParts = useMemo(() => state.panels.map((p) => p.anchorPart).filter((p): p is string => !!p), [state.panels])
  const pluginIssues = state.plugins.filter((p) => p.state === 'error' || p.state === 'preview').length

  const canvasStyle = { position: 'absolute' as const, top: TOP, bottom: GUTTER, left: GUTTER, right: layout === 'split' ? `calc(50% + ${GUTTER / 2}px)` : GUTTER, display: layout === 'scene' ? 'none' : 'block' }
  const sceneStyle = { position: 'absolute' as const, top: TOP, bottom: GUTTER, right: GUTTER, left: layout === 'split' ? `calc(50% + ${GUTTER / 2}px)` : GUTTER, display: layout === 'canvas' ? 'none' : 'block' }

  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <header style={{ position: 'absolute', top: 0, left: 0, right: 0, height: TOP, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: `0 ${GUTTER + 4}px` }} data-tauri-drag-region>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }} data-tauri-drag-region>
          <span className={`wb-dot ${connected ? 'wb-dot--ok' : 'wb-dot--bad'}`} title={connected ? 'Connected' : 'Sidecar not reachable'} />
          <span className="wb-text-md" style={{ fontWeight: 600 }} data-testid="board-title">{state.board?.title ?? 'No board'}</span>
          {state.board?.issues.length ? <span className="wb-text-xs wb-muted" title={state.board.issues.join('\n')}>{state.board.issues.length} data issue{state.board.issues.length > 1 ? 's' : ''}</span> : null}
        </div>
        <Segmented<Layout> value={layout} onChange={setLayout} options={[{ value: 'canvas', label: 'Board' }, { value: 'split', label: 'Split' }, { value: 'scene', label: 'Model' }]} />
        <div style={{ display: 'flex', gap: 8 }}>
          <Button onClick={() => setSkillsOpen((o) => !o)} pressed={skillsOpen} testId="skills-button" title="Skill trees the whiteboard has learned">
            Skills
          </Button>
          <Button onClick={() => setTrayOpen((o) => !o)} pressed={trayOpen} testId="plugins-button">
            Plugins{pluginIssues ? ` · ${pluginIssues}` : ''}
          </Button>
          <Button onClick={() => void openOutputWindow()} title="Open the projector output window">Output</Button>
        </div>
      </header>

      <div className="wb-glass" style={{ ...canvasStyle, overflow: 'hidden', borderRadius: 20 }}>
        <ErrorBoundary source="canvas">
          <CanvasHost role="control" runtime={runtime} />
        </ErrorBoundary>
      </div>
      <div ref={stageRef} className="wb-glass" style={{ ...sceneStyle, overflow: 'hidden', borderRadius: 20 }}>
        <ErrorBoundary source="3D scene">
          <Stage scene={state.scene} theme={themes.glass} interactive onModelInfo={onModelInfo} anchorParts={anchorParts} />
        </ErrorBoundary>
        {!state.scene.model && (
          <div className="wb-muted wb-text-sm" style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', pointerEvents: 'none' }}>
            {state.board ? 'No model on this board' : 'Open a board: /open titan'}
          </div>
        )}
      </div>

      <PanelLayer panels={state.panels} runtime={runtime} stageOrigin={stageOrigin} />
      {trayOpen && <PluginTray plugins={state.plugins} onClose={() => setTrayOpen(false)} />}
      <AnimatePresence>{skillsOpen && <SkillTrees plugins={state.plugins} onClose={() => setSkillsOpen(false)} />}</AnimatePresence>
      <Notices approvals={state.approvals} />
      <CommandBar voice={state.voice} />
    </div>
  )
}
