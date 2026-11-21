/**
 * Canvas snapshots and sync. Shapes whose plugin is not loaded are parked
 * (kept aside, still saved) instead of failing the whole load.
 */
import { getSnapshot, loadSnapshot, type Editor, type TLRecord, type TLStoreSnapshot } from 'tldraw'
import { reportError } from '../errors'

interface DocumentSnapshot {
  document?: TLStoreSnapshot
}

const parked = new Map<string, TLRecord>()

function knownShapeTypes(editor: Editor): Set<string> {
  return new Set(Object.keys(editor.shapeUtils))
}

function isUnknownShape(record: TLRecord, known: Set<string>): boolean {
  return record.typeName === 'shape' && !known.has((record as { type: string }).type)
}

/** Load a saved document, parking shapes the current editor cannot render. */
export function loadDocument(editor: Editor, snapshot: unknown): void {
  const doc = (snapshot as DocumentSnapshot | null)?.document
  if (!doc) {
    clearCanvas(editor)
    return
  }
  const known = knownShapeTypes(editor)
  const store: Record<string, TLRecord> = {}
  for (const [id, record] of Object.entries(doc.store as Record<string, TLRecord>)) {
    if (isUnknownShape(record, known)) parked.set(id, record)
    else {
      store[id] = record
      parked.delete(id)
    }
  }
  try {
    loadSnapshot(editor.store, { document: { ...doc, store } as TLStoreSnapshot })
  } catch (error) {
    reportError('loading the canvas', error)
  }
}

/** Snapshot of the document including parked shapes, for saving. */
export function saveDocument(editor: Editor): DocumentSnapshot {
  const { document } = getSnapshot(editor.store)
  const store = { ...(document.store as Record<string, TLRecord>) }
  for (const [id, record] of parked) if (!store[id]) store[id] = record
  return { document: { ...document, store } as TLStoreSnapshot }
}

/** Put parked shapes back once their plugin's shape util is registered. */
export function restoreParked(editor: Editor): void {
  const known = knownShapeTypes(editor)
  const ready = [...parked.values()].filter((r) => !isUnknownShape(r, known))
  if (!ready.length) return
  for (const r of ready) parked.delete(r.id)
  try {
    editor.store.mergeRemoteChanges(() => editor.store.put(ready))
  } catch (error) {
    reportError('restoring plugin shapes', error)
  }
}

export function clearCanvas(editor: Editor): void {
  parked.clear()
  const ids = [...editor.getCurrentPageShapeIds()]
  if (ids.length) editor.deleteShapes(ids)
}

export interface CanvasDiff {
  put: TLRecord[]
  remove: string[]
}

/** Apply a diff from the control window (output window only). */
export function applyDiff(editor: Editor, diff: CanvasDiff): void {
  const known = knownShapeTypes(editor)
  const put: TLRecord[] = []
  for (const r of diff.put) {
    // Shapes from plugins this window has not loaded yet are parked, not dropped.
    if (isUnknownShape(r, known)) parked.set(r.id, r)
    else put.push(r)
  }
  for (const id of diff.remove) parked.delete(id)
  editor.store.mergeRemoteChanges(() => {
    if (put.length) editor.store.put(put)
    const remove = diff.remove.filter((id) => editor.store.has(id as TLRecord['id']))
    if (remove.length) editor.store.remove(remove as TLRecord['id'][])
  })
}
