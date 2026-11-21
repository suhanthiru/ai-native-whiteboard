import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { errorMessage, logger } from '../log'
import type { ToolResult } from '../tools/registry'

const log = logger('previews')

/** File names a recorded skill preview may have, inside the plugin folder. */
export const PREVIEW_FILES = ['preview.webm', 'preview.mp4', 'preview.png'] as const
/** A preview being written; never part of the plugin's hash. */
export const PREVIEW_TMP = /^\.preview-[^\\/]*\.tmp$/i
export type PreviewKind = 'webm' | 'mp4' | 'png'

export const PREVIEW_TYPES: Readonly<Record<PreviewKind, string>> = { webm: 'video/webm', mp4: 'video/mp4', png: 'image/png' }
export const MAX_PREVIEW_BYTES = 12 * 1024 * 1024
export const DEFAULT_PREVIEW_SECONDS = 5
export const MAX_PREVIEW_SECONDS = 10
/** Lets the control window start recording before the tool runs. */
const PREROLL_MS = 400
/** Encoding and transfer on top of the recording itself. */
const RPC_SLACK_MS = 20_000

export interface PreviewFile {
  path: string
  kind: PreviewKind
  type: string
  mtimeMs: number
}

/** The recorded preview in a plugin folder, if any. */
export function previewFileIn(dir: string): PreviewFile | null {
  for (const name of PREVIEW_FILES) {
    const path = join(dir, name)
    if (!existsSync(path)) continue
    const kind = name.slice('preview.'.length) as PreviewKind
    try {
      return { path, kind, type: PREVIEW_TYPES[kind], mtimeMs: Math.floor(statSync(path).mtimeMs) }
    } catch {
      // Replaced between the check and the stat (a new recording); try the next name.
    }
  }
  return null
}

/** Identify a preview by its magic bytes, never by what the sender claims. */
export function sniffPreview(bytes: Uint8Array): PreviewKind | null {
  const at = (i: number) => bytes[i] ?? -1
  if (at(0) === 0x1a && at(1) === 0x45 && at(2) === 0xdf && at(3) === 0xa3) return 'webm'
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47 && at(4) === 0x0d && at(5) === 0x0a && at(6) === 0x1a && at(7) === 0x0a) return 'png'
  if (at(4) === 0x66 && at(5) === 0x74 && at(6) === 0x79 && at(7) === 0x70) return 'mp4'
  return null
}

/** Validate and store a preview, replacing any earlier one. Returns the file name. */
export async function savePreview(dir: string, bytes: Uint8Array): Promise<string> {
  if (!bytes.length) throw new Error('the recording is empty')
  if (bytes.length > MAX_PREVIEW_BYTES) throw new Error(`the recording is ${bytes.length} bytes; the limit is ${MAX_PREVIEW_BYTES}`)
  const kind = sniffPreview(bytes)
  if (!kind) throw new Error('the recording is not a WebM, MP4 or PNG file')
  const name = `preview.${kind}`
  const tmp = join(dir, `.preview-${randomUUID()}.tmp`)
  try {
    await writeFile(tmp, bytes)
    for (const other of PREVIEW_FILES) if (other !== name) await rm(join(dir, other), { force: true })
    await rename(tmp, join(dir, name))
    return name
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined)
  }
}

export type PreviewView = 'scene' | 'canvas'

export interface RecordingClient {
  hasRole(role: 'control'): boolean
  rpc(method: string, params: unknown, timeoutMs?: number): Promise<unknown>
}

export interface RecordOutcome {
  result: ToolResult
  /** File name of the saved preview, when recording worked. */
  saved?: string
  /** Why there is no preview (the tool result is still valid). */
  problem?: string
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function decodeClip(value: unknown): Uint8Array {
  const data = value && typeof value === 'object' ? (value as { data?: unknown }).data : undefined
  if (typeof data !== 'string' || !data) throw new Error('the app returned no recording')
  return new Uint8Array(Buffer.from(data, 'base64'))
}

/**
 * Records a skill in action: the control window starts capturing the 3D
 * scene (or the canvas), the tool runs, and the clip lands next to the plugin
 * as preview.webm / .mp4 / .png. A failed recording never fails the tool call.
 */
export async function recordWhileRunning(client: RecordingClient, dir: string, view: PreviewView, seconds: number, run: () => Promise<ToolResult>): Promise<RecordOutcome> {
  if (!client.hasRole('control')) return { result: await run(), problem: 'the control window is not open' }
  const length = Math.min(Math.max(seconds, 1), MAX_PREVIEW_SECONDS)
  const recording = client.rpc('preview.record', { view, seconds: length }, length * 1000 + RPC_SLACK_MS).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error: errorMessage(error) }),
  )
  await delay(PREROLL_MS)
  const result = await run()
  const clip = await recording
  if (result.isError) return { result, problem: 'the tool failed, so the recording was not kept' }
  if (!clip.ok) return { result, problem: clip.error }
  try {
    return { result, saved: await savePreview(dir, decodeClip(clip.value)) }
  } catch (error) {
    log.warn('preview not saved', errorMessage(error))
    return { result, problem: errorMessage(error) }
  }
}
