/**
 * Wire protocol between the Node sidecar and the app windows (WebSocket).
 * JSON text frames carry these messages; binary frames carry bus payloads and
 * audio (see `encodeBinaryFrame`).
 */
import type { SkillMeta } from './manifest'

export type Role = 'control' | 'output'

export interface Annotation {
  id: string
  part: string
  text: string
}

export interface SceneState {
  /** URL the windows load the model from (served by the sidecar from the board's data/). */
  model: string | null
  modelFile: string | null
  explode: number
  focus: string | null
  annotations: Annotation[]
  /** Incremented by reset_view so both windows fly home together. */
  viewNonce: number
}

export interface DataFileStatus {
  path: string
  size: number
  status: 'ok' | 'missing' | 'changed' | 'unlocked'
}

export interface BoardStatus {
  name: string
  title: string
  aliases: string[]
  description?: string
  files: DataFileStatus[]
  issues: string[]
  /** Per-plugin config from board.json. */
  config: Record<string, Record<string, unknown>>
}

export type PluginState = 'active' | 'disabled' | 'pending' | 'preview' | 'error'

export interface PluginInfo {
  name: string
  version: string
  description: string
  source: 'shared' | 'board'
  state: PluginState
  message?: string
  tools: string[]
  hash: string
  /** Skill tree placement and explainer (defaults when the manifest has none). */
  skill?: SkillMeta
  /** URL of the skill's recorded preview (video or image), when one exists. */
  previewUrl?: string
  /** When the plugin's manifest last changed (ISO), so the viewer can show what was learned recently. */
  updatedAt?: string
}

export type OutputView = 'scene' | 'canvas' | 'split'

export interface Corner {
  x: number
  y: number
}

/** Four output corners in normalised 0..1 coordinates: TL, TR, BR, BL. */
export type WarpCorners = [Corner, Corner, Corner, Corner]

export interface OutputState {
  view: OutputView
  warp: WarpCorners | null
  calibrating: boolean
}

export type VoicePhase = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking' | 'error'

export interface VoiceState {
  phase: VoicePhase
  transcript: string
  reply: string
  activity: string[]
  available: { stt: boolean; tts: boolean; brain: boolean }
}

export interface PanelInstance {
  id: string
  panel: string
  plugin: string
  props: Record<string, unknown>
  /** Optional 3D part to sit next to. */
  anchorPart?: string
}

export interface ApprovalRequest {
  id: string
  kind: 'plugin' | 'tool' | 'install'
  title: string
  detail: string
  plugin?: string
}

export interface AppState {
  board: BoardStatus | null
  boards: { name: string; title: string; aliases: string[] }[]
  scene: SceneState
  output: OutputState
  plugins: PluginInfo[]
  panels: PanelInstance[]
  voice: VoiceState
  approvals: ApprovalRequest[]
  topics: string[]
}

export interface ToolDescriptor {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  requiresApproval?: boolean
}

export interface PluginBundle {
  name: string
  hash: string
  code: string
  source: 'shared' | 'board'
  preview: boolean
}

export interface CanvasSync {
  /** Full tldraw store snapshot (records) when `full` is true, otherwise a diff. */
  full: boolean
  payload: unknown
}

export type ClientMessage =
  | { type: 'hello'; role: Role }
  | { type: 'rpc_result'; id: string; ok: true; result: unknown }
  | { type: 'rpc_result'; id: string; ok: false; error: string }
  | { type: 'command'; text: string }
  | { type: 'model_info'; file: string; parts: string[] }
  | { type: 'register_tools'; plugin: string; tools: ToolDescriptor[] }
  | { type: 'plugin_loaded'; plugin: string; ok: boolean; error?: string }
  | { type: 'canvas'; sync: CanvasSync }
  | { type: 'canvas_save'; snapshot: unknown; board?: string }
  | { type: 'approval'; id: string; approve: boolean }
  | { type: 'publish'; topic: string; t: number; data: unknown }
  | { type: 'ptt'; state: 'start' | 'stop' | 'cancel' }
  | { type: 'warp'; corners: WarpCorners | null }
  | { type: 'calibrate'; on: boolean }
  | { type: 'panel_open'; panel: PanelInstance }
  | { type: 'tool_call'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'panel_close'; id: string }

export type ServerMessage =
  | { type: 'state'; state: AppState }
  | { type: 'rpc'; id: string; method: string; params: unknown }
  | { type: 'plugin_bundle'; bundle: PluginBundle }
  | { type: 'plugin_unload'; name: string }
  | { type: 'bus'; topic: string; t: number; data: unknown }
  | { type: 'canvas'; sync: CanvasSync }
  | { type: 'canvas_load'; snapshot: unknown | null; board?: string }
  | { type: 'toast'; level: 'info' | 'warn' | 'error'; text: string }
  | { type: 'tts_stop' }
  | { type: 'tool_result'; id: string; ok: boolean; text: string }

/** Binary frame kinds. */
export const BinaryKind = { bus: 1, audioIn: 2, audioOut: 3 } as const
export type BinaryKindValue = (typeof BinaryKind)[keyof typeof BinaryKind]

/**
 * Binary frame layout: [u8 kind][u16 headerLength][header JSON utf8][payload bytes].
 * The header carries the topic and timestamp for bus frames.
 */
export function encodeBinaryFrame(kind: BinaryKindValue, header: Record<string, unknown>, payload: Uint8Array): Uint8Array {
  const headerBytes = new TextEncoder().encode(JSON.stringify(header))
  if (headerBytes.length > 0xffff) throw new Error('binary frame header too large')
  const out = new Uint8Array(3 + headerBytes.length + payload.length)
  out[0] = kind
  out[1] = headerBytes.length >> 8
  out[2] = headerBytes.length & 0xff
  out.set(headerBytes, 3)
  out.set(payload, 3 + headerBytes.length)
  return out
}

export function decodeBinaryFrame(frame: Uint8Array): { kind: number; header: Record<string, unknown>; payload: Uint8Array } {
  if (frame.length < 3) throw new Error('binary frame too short')
  const kind = frame[0] ?? 0
  const headerLength = ((frame[1] ?? 0) << 8) | (frame[2] ?? 0)
  if (3 + headerLength > frame.length) throw new Error('binary frame header overruns frame')
  const header = JSON.parse(new TextDecoder().decode(frame.subarray(3, 3 + headerLength))) as Record<string, unknown>
  return { kind, header, payload: frame.subarray(3 + headerLength) }
}

export function initialAppState(): AppState {
  return {
    board: null,
    boards: [],
    scene: { model: null, modelFile: null, explode: 0, focus: null, annotations: [], viewNonce: 0 },
    output: { view: 'scene', warp: null, calibrating: false },
    plugins: [],
    panels: [],
    voice: { phase: 'idle', transcript: '', reply: '', activity: [], available: { stt: false, tts: false, brain: false } },
    approvals: [],
    topics: [],
  }
}
