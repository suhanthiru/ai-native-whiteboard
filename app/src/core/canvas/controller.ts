/**
 * Holds the live tldraw Editor and implements the CanvasApi plugins use.
 */
import { createShapeId, type Editor, type TLShapeId, type TLShapePartial } from 'tldraw'
import { durations, type CanvasApi, type CanvasShapeInput } from '@wb/sdk'

let editor: Editor | null = null
const listeners = new Set<(e: Editor | null) => void>()

export function setEditor(next: Editor | null): void {
  editor = next
  for (const l of listeners) l(next)
}

export function getEditor(): Editor | null {
  return editor
}

export function onEditor(listener: (e: Editor | null) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function requireEditor(): Editor {
  if (!editor) throw new Error('The canvas is not ready yet.')
  return editor
}

const DEFAULT_SIZE = { w: 480, h: 320 }

export function viewportCenter(): { x: number; y: number } {
  const e = requireEditor()
  const b = e.getViewportPageBounds()
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 }
}

export function createShape(shape: CanvasShapeInput): string {
  const e = requireEditor()
  const id = createShapeId()
  const props = shape.props ?? {}
  const w = typeof props.w === 'number' ? props.w : DEFAULT_SIZE.w
  const h = typeof props.h === 'number' ? props.h : DEFAULT_SIZE.h
  const center = viewportCenter()
  // Plugin shape types are only known at runtime, so the partial is built loosely.
  const partial = { id, type: shape.type, x: shape.x ?? center.x - w / 2, y: shape.y ?? center.y - h / 2, props } as unknown as TLShapePartial
  e.createShape(partial)
  e.select(id)
  return id
}

export function zoomTo(id: string): void {
  const e = requireEditor()
  const bounds = e.getShapePageBounds(id as TLShapeId)
  if (bounds) e.zoomToBounds(bounds, { inset: 80, animation: { duration: durations.slow } })
}

export const canvasApi: CanvasApi = {
  get editor() {
    return editor
  },
  createShape,
  updateShape(id, props) {
    const e = requireEditor()
    const shape = e.getShape(id as TLShapeId)
    if (!shape) throw new Error(`no shape ${id}`)
    e.updateShape({ id: shape.id, type: shape.type, props } as unknown as TLShapePartial)
  },
  deleteShape(id) {
    requireEditor().deleteShape(id as TLShapeId)
  },
  viewportCenter,
  zoomTo,
}
