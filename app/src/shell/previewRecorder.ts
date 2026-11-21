/**
 * Records skill previews for the skill viewer. The sidecar asks for one
 * (rpc "preview.record"), then runs the skill's tool while this records:
 * the 3D stage becomes a short video, the canvas becomes a PNG of the shapes
 * the tool created.
 */
import type { Editor, TLShapeId } from 'tldraw'

const FRAME_RATE = 30
const VIDEO_BITS_PER_SECOND = 2_500_000
const CHUNK_MS = 250
/** A canvas tool usually creates its shapes quickly; wait at most this long. */
const CANVAS_SETTLE_MS = 2500
const MIME_CANDIDATES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4']

export interface RecordedClip {
  mime: string
  /** Base64 without the data: prefix. */
  data: string
}

const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms)) // recording length, not animation

export function pickVideoMime(isSupported: (mime: string) => boolean): string | null {
  return MIME_CANDIDATES.find((m) => isSupported(m)) ?? null
}

async function toBase64(blob: Blob): Promise<string> {
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('could not read the recording'))
    reader.readAsDataURL(blob)
  })
  return url.slice(url.indexOf(',') + 1)
}

/** Record a canvas element (the WebGL stage) for `seconds`. */
export async function recordCanvasElement(canvas: HTMLCanvasElement, seconds: number): Promise<RecordedClip> {
  if (typeof MediaRecorder === 'undefined') throw new Error('this window cannot record video (no MediaRecorder)')
  if (!canvas.width || !canvas.height) throw new Error('the 3D view is hidden; show the Model or Split layout')
  const mime = pickVideoMime((m) => MediaRecorder.isTypeSupported(m))
  if (!mime) throw new Error('no supported video format for recording')
  const stream = canvas.captureStream(FRAME_RATE)
  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: VIDEO_BITS_PER_SECOND })
  const chunks: Blob[] = []
  recorder.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data)
  }
  const stopped = new Promise<void>((resolve) => (recorder.onstop = () => resolve()))
  recorder.start(CHUNK_MS)
  await wait(seconds * 1000)
  recorder.stop()
  await stopped
  for (const track of stream.getTracks()) track.stop()
  const blob = new Blob(chunks, { type: mime.split(';')[0] })
  if (!blob.size) throw new Error('the 3D view did not draw any frames while recording; the window is probably minimised or hidden')
  return { mime: blob.type, data: await toBase64(blob) }
}

/**
 * Wait for the tool to put shapes on the canvas, then export only those as a
 * PNG. Never falls back to the whole board: the preview is stored with the
 * plugin, and the user's board content must not end up there.
 */
export async function snapshotNewShapes(editor: Editor, before: ReadonlySet<TLShapeId>, seconds: number): Promise<RecordedClip> {
  const deadline = Math.min(seconds * 1000, CANVAS_SETTLE_MS)
  const fresh = () => [...editor.getCurrentPageShapeIds()].filter((id) => !before.has(id))
  let waited = 0
  while (!fresh().length && waited < deadline) {
    await wait(CHUNK_MS)
    waited += CHUNK_MS
  }
  await wait(CHUNK_MS) // let the new shapes render once
  const ids = fresh()
  if (!ids.length) throw new Error('the tool put nothing new on the canvas to preview')
  const { blob } = await editor.toImage(ids, { format: 'png', background: true, padding: 24 })
  return { mime: 'image/png', data: await toBase64(blob) }
}
