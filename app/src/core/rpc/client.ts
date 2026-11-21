import { useSyncExternalStore } from 'react'
import {
  BinaryKind,
  decodeBinaryFrame,
  encodeBinaryFrame,
  initialAppState,
  type AppState,
  type ClientMessage,
  type Role,
  type ServerMessage,
} from '@wb/sdk'

const DEFAULT_PORT = 4319
const RECONNECT_MS = 1000
const TOOL_TIMEOUT_MS = 60_000
const MAX_PENDING = 200

export const sidecarHttp: string = (import.meta.env.VITE_WB_SIDECAR_HTTP as string | undefined) ?? `http://127.0.0.1:${DEFAULT_PORT}`
const sidecarWs = sidecarHttp.replace(/^http/, 'ws') + '/ws'

type MessageOf<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>
type Handler<T extends ServerMessage['type']> = (message: MessageOf<T>) => void
type RpcHandler = (params: unknown) => unknown | Promise<unknown>
type BinaryHandler = (header: Record<string, unknown>, payload: Uint8Array) => void

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** One WebSocket to the sidecar per window. Holds the mirrored AppState. */
export class SidecarClient {
  private socket: WebSocket | null = null
  private state: AppState = initialAppState()
  private connected = false
  private readonly stateListeners = new Set<() => void>()
  private readonly handlers = new Map<string, Set<(m: ServerMessage) => void>>()
  private readonly rpcHandlers = new Map<string, RpcHandler>()
  private readonly binaryHandlers = new Map<number, Set<BinaryHandler>>()
  private readonly pending: string[] = []
  private readonly toolWaiters = new Map<string, () => void>()
  private latestCanvasSave: string | null = null
  private role: Role = 'control'
  private stopped = false

  connect(role: Role): void {
    this.role = role
    this.stopped = false
    this.open()
  }

  close(): void {
    this.stopped = true
    this.socket?.close()
  }

  getState = (): AppState => this.state
  isConnected = (): boolean => this.connected

  subscribeState = (listener: () => void): (() => void) => {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  on<T extends ServerMessage['type']>(type: T, handler: Handler<T>): () => void {
    let set = this.handlers.get(type)
    if (!set) {
      set = new Set()
      this.handlers.set(type, set)
    }
    const h = handler as (m: ServerMessage) => void
    set.add(h)
    return () => set?.delete(h)
  }

  onBinary(kind: number, handler: BinaryHandler): () => void {
    let set = this.binaryHandlers.get(kind)
    if (!set) {
      set = new Set()
      this.binaryHandlers.set(kind, set)
    }
    set.add(handler)
    return () => set?.delete(handler)
  }

  /** Handle an RPC method the sidecar routes to this window (control only). */
  handleRpc(method: string, handler: RpcHandler): () => void {
    this.rpcHandlers.set(method, handler)
    return () => {
      if (this.rpcHandlers.get(method) === handler) this.rpcHandlers.delete(method)
    }
  }

  /** Run a tool through the sidecar (same path as MCP) and wait for its text. */
  callTool(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const id = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      const finish = (fn: () => void) => {
        globalThis.clearTimeout(timer)
        off()
        this.toolWaiters.delete(id)
        fn()
      }
      const timer = globalThis.setTimeout(() => finish(() => reject(new Error(`${name} timed out`))), TOOL_TIMEOUT_MS) // request timeout, not animation
      const off = this.on('tool_result', (m) => {
        if (m.id !== id) return
        finish(() => (m.ok ? resolve(m.text) : reject(new Error(m.text))))
      })
      this.toolWaiters.set(id, () => finish(() => reject(new Error('lost the connection to the sidecar'))))
      this.send({ type: 'tool_call', id, name, args })
    })
  }

  send(message: ClientMessage): void {
    if (message.type === 'canvas_save') this.latestCanvasSave = JSON.stringify(message)
    this.write(JSON.stringify(message), message.type)
  }

  sendAudio(pcm: Uint8Array, header: Record<string, unknown> = {}): void {
    this.write(encodeBinaryFrame(BinaryKind.audioIn, header, pcm))
  }

  private write(data: string | Uint8Array, type?: ClientMessage['type']): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(data as string | ArrayBuffer)
      return
    }
    // Offline: queue a bounded number of messages. Canvas saves and diffs are not
    // queued one by one; the newest full save is sent once on reconnect instead.
    if (typeof data !== 'string' || type === 'canvas_save' || type === 'canvas') return
    if (this.pending.length >= MAX_PENDING) this.pending.shift()
    this.pending.push(data)
  }

  private open(): void {
    const socket = new WebSocket(sidecarWs)
    socket.binaryType = 'arraybuffer'
    this.socket = socket
    socket.onopen = () => {
      this.connected = true
      socket.send(JSON.stringify({ type: 'hello', role: this.role } satisfies ClientMessage))
      for (const item of this.pending.splice(0)) socket.send(item)
      if (this.latestCanvasSave) socket.send(this.latestCanvasSave)
      this.emitState()
    }
    socket.onmessage = (event) => this.receive(event.data as string | ArrayBuffer)
    socket.onclose = () => {
      this.connected = false
      for (const fail of [...this.toolWaiters.values()]) fail()
      this.emitState()
      if (!this.stopped) window.setTimeout(() => this.open(), RECONNECT_MS)
    }
    socket.onerror = () => socket.close()
  }

  private receive(data: string | ArrayBuffer): void {
    if (typeof data !== 'string') {
      try {
        const frame = decodeBinaryFrame(new Uint8Array(data))
        for (const h of this.binaryHandlers.get(frame.kind) ?? []) h(frame.header, frame.payload)
      } catch (error) {
        this.emitToast(`bad binary frame: ${errorMessage(error)}`)
      }
      return
    }
    let message: ServerMessage
    try {
      message = JSON.parse(data) as ServerMessage
    } catch {
      this.emitToast('sidecar sent malformed JSON')
      return
    }
    if (message.type === 'state') {
      this.state = message.state
      this.emitState()
    } else if (message.type === 'rpc') {
      void this.runRpc(message.id, message.method, message.params)
    }
    for (const h of this.handlers.get(message.type) ?? []) {
      try {
        h(message)
      } catch (error) {
        this.emitToast(`handler for ${message.type} failed: ${errorMessage(error)}`)
      }
    }
  }

  private async runRpc(id: string, method: string, params: unknown): Promise<void> {
    const handler = this.rpcHandlers.get(method)
    if (!handler) {
      this.send({ type: 'rpc_result', id, ok: false, error: `no handler for ${method} in ${this.role} window` })
      return
    }
    try {
      const result = await handler(params)
      this.send({ type: 'rpc_result', id, ok: true, result: result ?? null })
    } catch (error) {
      this.send({ type: 'rpc_result', id, ok: false, error: errorMessage(error) })
    }
  }

  private emitState(): void {
    for (const l of this.stateListeners) l()
  }

  private emitToast(text: string): void {
    for (const h of this.handlers.get('toast') ?? []) h({ type: 'toast', level: 'error', text })
  }
}

export const sidecar = new SidecarClient()

export function useAppState(): AppState {
  return useSyncExternalStore(sidecar.subscribeState, sidecar.getState)
}

export function useConnected(): boolean {
  return useSyncExternalStore(sidecar.subscribeState, sidecar.isConnected)
}

export function boardDataUrl(path: string): string {
  const clean = path.replace(/^data\//, '').split('/').map(encodeURIComponent).join('/')
  return `${sidecarHttp}/board-data/${clean}`
}
