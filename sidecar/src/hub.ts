import { randomUUID } from 'node:crypto'
import type { WebSocket } from 'ws'
import { decodeBinaryFrame, type ClientMessage, type Role, type ServerMessage } from '@wb/sdk'
import type { StateStore } from './state/store'
import { errorMessage, logger } from './log'

const log = logger('hub')
const RPC_TIMEOUT_MS = 5000
const STATE_COALESCE_MS = 16
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024

export interface HubClient {
  id: string
  role: Role | null
  socket: WebSocket
  send(message: ServerMessage): void
  sendBinary(frame: Uint8Array): void
}

type MessageOf<T extends ClientMessage['type']> = Extract<ClientMessage, { type: T }>
type Handler<T extends ClientMessage['type']> = (message: MessageOf<T>, client: HubClient) => void | Promise<void>
type BinaryHandler = (header: Record<string, unknown>, payload: Uint8Array, client: HubClient) => void

interface PendingRpc {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export class RpcError extends Error {}

/** All connected windows. Routes messages, RPCs and state broadcasts. */
export class Hub {
  private readonly clients = new Set<HubClient>()
  private readonly handlers = new Map<string, Set<(m: ClientMessage, c: HubClient) => void | Promise<void>>>()
  private readonly binaryHandlers = new Map<number, Set<BinaryHandler>>()
  private readonly readyHandlers = new Set<(client: HubClient) => void>()
  private readonly pending = new Map<string, PendingRpc>()
  private stateTimer: NodeJS.Timeout | null = null

  constructor(private readonly store: StateStore) {
    store.subscribe(() => this.scheduleState())
    this.on('rpc_result', (m) => this.settleRpc(m))
  }

  attach(socket: WebSocket): HubClient {
    const client: HubClient = {
      id: randomUUID(),
      role: null,
      socket,
      send: (message) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message))
      },
      sendBinary: (frame) => {
        if (socket.readyState === socket.OPEN) socket.send(frame)
      },
    }
    this.clients.add(client)
    socket.on('message', (data, isBinary) => this.receive(client, data as Buffer, isBinary))
    socket.on('close', () => this.clients.delete(client))
    socket.on('error', (error) => log.warn('socket error', errorMessage(error)))
    return client
  }

  on<T extends ClientMessage['type']>(type: T, handler: Handler<T>): () => void {
    let set = this.handlers.get(type)
    if (!set) {
      set = new Set()
      this.handlers.set(type, set)
    }
    const h = handler as (m: ClientMessage, c: HubClient) => void
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

  /** Called after a window says hello, so services can send it what it needs. */
  onReady(handler: (client: HubClient) => void): () => void {
    this.readyHandlers.add(handler)
    return () => this.readyHandlers.delete(handler)
  }

  broadcast(message: ServerMessage, filter?: (c: HubClient) => boolean): void {
    const text = JSON.stringify(message)
    for (const c of this.clients) {
      if (c.role && (!filter || filter(c)) && c.socket.readyState === c.socket.OPEN) c.socket.send(text)
    }
  }

  broadcastBinary(frame: Uint8Array, role?: Role): void {
    for (const c of this.clients) if (c.role && (!role || c.role === role)) c.sendBinary(frame)
  }

  sendTo(role: Role, message: ServerMessage): void {
    this.broadcast(message, (c) => c.role === role)
  }

  hasRole(role: Role): boolean {
    return [...this.clients].some((c) => c.role === role)
  }

  /** Call a method in the control window and wait for its result. */
  rpc(method: string, params: unknown, timeoutMs = RPC_TIMEOUT_MS): Promise<unknown> {
    const control = [...this.clients].find((c) => c.role === 'control')
    if (!control) return Promise.reject(new RpcError('The control window is not open, so canvas and plugin tools cannot run.'))
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new RpcError(`${method} timed out after ${timeoutMs}ms in the control window`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      control.send({ type: 'rpc', id, method, params })
    })
  }

  close(): void {
    for (const c of this.clients) c.socket.close()
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new RpcError('sidecar shutting down'))
    }
    this.pending.clear()
    if (this.stateTimer) clearTimeout(this.stateTimer)
  }

  private settleRpc(message: MessageOf<'rpc_result'>): void {
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    clearTimeout(pending.timer)
    if (message.ok) pending.resolve(message.result)
    else pending.reject(new RpcError(message.error))
  }

  private receive(client: HubClient, data: Buffer, isBinary: boolean): void {
    if (data.byteLength > MAX_MESSAGE_BYTES) {
      log.warn('dropping oversized message', data.byteLength)
      return
    }
    if (isBinary) {
      try {
        const frame = decodeBinaryFrame(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
        for (const h of this.binaryHandlers.get(frame.kind) ?? []) h(frame.header, frame.payload, client)
      } catch (error) {
        log.warn('bad binary frame', errorMessage(error))
      }
      return
    }
    let message: ClientMessage
    try {
      message = JSON.parse(data.toString('utf8')) as ClientMessage
    } catch {
      log.warn('malformed JSON from client')
      return
    }
    if (!message || typeof message.type !== 'string') return
    if (message.type === 'hello') {
      if (message.role !== 'control' && message.role !== 'output') return
      client.role = message.role
      client.send({ type: 'state', state: this.store.get() })
      for (const h of this.readyHandlers) h(client)
      return
    }
    if (!client.role) return
    for (const h of this.handlers.get(message.type) ?? []) {
      Promise.resolve(h(message, client)).catch((error: unknown) => {
        log.error(`handler for ${message.type} failed`, error)
        client.send({ type: 'toast', level: 'error', text: `${message.type}: ${errorMessage(error)}` })
      })
    }
  }

  private scheduleState(): void {
    if (this.stateTimer) return
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null
      this.broadcast({ type: 'state', state: this.store.get() })
    }, STATE_COALESCE_MS)
  }
}
