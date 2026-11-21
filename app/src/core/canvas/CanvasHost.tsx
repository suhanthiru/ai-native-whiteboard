import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { Tldraw, type Editor, type TLAnyShapeUtilConstructor, type TLRecord } from 'tldraw'
import 'tldraw/tldraw.css'
import { durations, type CanvasSync, type Role } from '@wb/sdk'
import { reportError } from '../errors'
import { sidecar } from '../rpc/client'
import type { PluginRuntime } from '../plugins/runtime'
import { CardShapeUtil } from './CardShape'
import { setEditor } from './controller'
import { applyDiff, loadDocument, restoreParked, saveDocument, type CanvasDiff } from './snapshot'

const SAVE_DEBOUNCE_MS = 700
const FIT_DEBOUNCE_MS = 250
const MAX_PENDING_SYNC = 500
const licenseKey = import.meta.env.TLDRAW_LICENSE_KEY as string | undefined

interface CanvasHostProps {
  role: Role
  runtime: PluginRuntime
}

function applySync(editor: Editor, sync: CanvasSync): void {
  try {
    if (sync.full) loadDocument(editor, sync.payload)
    else applyDiff(editor, sync.payload as CanvasDiff)
  } catch (error) {
    reportError('canvas sync', error)
  }
}

/**
 * The whiteboard. Remounts tldraw when plugin shape types change (the store
 * schema is fixed per mount) and carries the document across the remount.
 */
export function CanvasHost({ role, runtime }: CanvasHostProps) {
  const version = useSyncExternalStore(runtime.subscribe, runtime.getVersion)
  const shapeUtils = useMemo(() => [CardShapeUtil, ...(runtime.shapeUtils() as TLAnyShapeUtilConstructor[])], [runtime, version])
  const key = shapeUtils.map((u) => u.type).join('|')
  const carried = useRef<unknown>(null)
  const pendingLoad = useRef<{ snapshot: unknown; board?: string } | null>(null)
  /** Output window: syncs that arrive before tldraw mounts. */
  const pendingSync = useRef<CanvasSync[]>([])
  const editorRef = useRef<Editor | null>(null)
  /** Board whose document is in the editor, and whether it has edits not yet loaded back from disk. */
  const loadedBoard = useRef<string | undefined>(undefined)
  const dirty = useRef(false)

  useEffect(() => {
    const offLoad = sidecar.on('canvas_load', (m) => {
      const editor = editorRef.current
      if (!editor) {
        pendingLoad.current = { snapshot: m.snapshot, board: m.board }
        return
      }
      // After a reconnect the disk copy can be older than what is on screen: keep ours and save it.
      if (m.board && m.board === loadedBoard.current && dirty.current) {
        sidecar.send({ type: 'canvas_save', snapshot: saveDocument(editor), board: m.board })
        return
      }
      loadDocument(editor, m.snapshot)
      loadedBoard.current = m.board
      dirty.current = false
    })
    const offSync = sidecar.on('canvas', (m) => {
      if (role !== 'output') return
      const editor = editorRef.current
      if (!editor) {
        pendingSync.current = m.sync.full ? [m.sync] : [...pendingSync.current, m.sync].slice(-MAX_PENDING_SYNC)
        return
      }
      applySync(editor, m.sync)
    })
    return () => {
      offLoad()
      offSync()
    }
  }, [role])

  const onMount = useCallback(
    (editor: Editor) => {
      editorRef.current = editor
      setEditor(editor)
      editor.user.updateUserPreferences({ colorScheme: 'dark' })
      if (carried.current) loadDocument(editor, carried.current)
      if (pendingLoad.current) {
        loadDocument(editor, pendingLoad.current.snapshot)
        loadedBoard.current = pendingLoad.current.board
        dirty.current = false
        pendingLoad.current = null
      }
      for (const sync of pendingSync.current.splice(0)) applySync(editor, sync)
      restoreParked(editor)

      const timers: number[] = []
      const debounce = (index: number, ms: number, fn: () => void) => {
        window.clearTimeout(timers[index])
        timers[index] = window.setTimeout(fn, ms) // persistence debounce, not animation
      }
      let off: () => void = () => undefined
      let savePending = false
      const save = () => {
        savePending = false
        sidecar.send({ type: 'canvas_save', snapshot: saveDocument(editor), board: loadedBoard.current ?? sidecar.getState().board?.name })
      }
      if (role === 'control') {
        off = editor.store.listen(
          (entry) => {
            const { added, updated, removed } = entry.changes
            const diff: CanvasDiff = {
              put: [...Object.values(added), ...Object.values(updated).map(([, to]) => to)] as TLRecord[],
              remove: Object.keys(removed),
            }
            sidecar.send({ type: 'canvas', sync: { full: false, payload: diff } })
            dirty.current = true
            savePending = true
            debounce(0, SAVE_DEBOUNCE_MS, save)
          },
          { source: 'user', scope: 'document' },
        )
      } else {
        editor.updateInstanceState({ isReadonly: true })
        off = editor.store.listen(
          () => debounce(1, FIT_DEBOUNCE_MS, () => editor.zoomToFit({ animation: { duration: durations.slow } })),
          { source: 'remote', scope: 'document' },
        )
      }
      return () => {
        off()
        timers.forEach((t) => window.clearTimeout(t))
        if (savePending) save() // a plugin remount must not drop the last edits
        carried.current = saveDocument(editor)
        editorRef.current = null
        setEditor(null)
      }
    },
    [role],
  )

  return (
    <div style={{ position: 'absolute', inset: 0 }} data-testid="canvas">
      <Tldraw key={key} shapeUtils={shapeUtils} hideUi={role === 'output'} licenseKey={licenseKey} onMount={onMount} />
    </div>
  )
}
