import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws'
import { BinaryKind, encodeBinaryFrame, initialAppState, type ClientMessage } from '@wb/sdk'

let wss: WebSocketServer
let server: ServerSocket
const fromClient: ClientMessage[] = []
let client: typeof import('./client')
let busModule: typeof import('../bus')

const until = async (fn: () => boolean) => {
  for (let i = 0; i < 200 && !fn(); i += 1) await new Promise((r) => setTimeout(r, 10))
  expect(fn()).toBe(true)
}

beforeAll(async () => {
  wss = new WebSocketServer({ port: 0 })
  const port = (wss.address() as { port: number }).port
  const connected = new Promise<void>((resolve) =>
    wss.on('connection', (socket) => {
      server = socket
      socket.on('message', (raw, isBinary) => {
        if (!isBinary) fromClient.push(JSON.parse(raw.toString()) as ClientMessage)
      })
      resolve()
    }),
  )
  vi.stubEnv('VITE_WB_SIDECAR_HTTP', `http://127.0.0.1:${port}`)
  client = await import('./client')
  busModule = await import('../bus')
  busModule.connectBusToSidecar()
  client.sidecar.send({ type: 'command', text: 'queued before connect' })
  client.sidecar.connect('control')
  await connected
})

afterAll(() => {
  client.sidecar.close()
  wss.close()
})

describe('SidecarClient', () => {
  it('says hello with its role, then flushes queued messages', async () => {
    await until(() => fromClient.length >= 2)
    expect(fromClient[0]).toEqual({ type: 'hello', role: 'control' })
    expect(fromClient[1]).toEqual({ type: 'command', text: 'queued before connect' })
    expect(client.sidecar.isConnected()).toBe(true)
  })

  it('mirrors the app state', async () => {
    const state = { ...initialAppState(), topics: ['titan/imu'] }
    server.send(JSON.stringify({ type: 'state', state }))
    await until(() => client.sidecar.getState().topics[0] === 'titan/imu')
  })

  it('answers RPCs and reports missing handlers as errors', async () => {
    const off = client.sidecar.handleRpc('canvas.note', (p) => `note: ${(p as { text: string }).text}`)
    server.send(JSON.stringify({ type: 'rpc', id: 'r1', method: 'canvas.note', params: { text: 'hi' } }))
    server.send(JSON.stringify({ type: 'rpc', id: 'r2', method: 'nope', params: {} }))
    await until(() => fromClient.some((m) => m.type === 'rpc_result' && m.id === 'r2'))
    expect(fromClient.find((m) => m.type === 'rpc_result' && m.id === 'r1')).toMatchObject({ ok: true, result: 'note: hi' })
    expect(fromClient.find((m) => m.type === 'rpc_result' && m.id === 'r2')).toMatchObject({ ok: false })
    off()
  })

  it('resolves callTool with the tool text', async () => {
    const pending = client.sidecar.callTool('explode', { amount: 1 })
    await until(() => fromClient.some((m) => m.type === 'tool_call'))
    const call = fromClient.find((m) => m.type === 'tool_call') as Extract<ClientMessage, { type: 'tool_call' }>
    server.send(JSON.stringify({ type: 'tool_result', id: call.id, ok: true, text: 'Exploded.' }))
    await expect(pending).resolves.toBe('Exploded.')
  })

  it('feeds bus messages, including float32 binary frames, into the window bus', async () => {
    server.send(JSON.stringify({ type: 'bus', topic: 'titan/imu', t: 1, data: { ok: true } }))
    server.send(encodeBinaryFrame(BinaryKind.bus, { topic: 'titan/lidar', t: 2, dtype: 'f32', meta: { frame: 'lidar' } }, new Uint8Array(new Float32Array([1, 2, 3]).buffer)))
    await until(() => busModule.bus.latest('titan/lidar') !== undefined)
    expect(busModule.bus.latest('titan/imu')?.data).toEqual({ ok: true })
    const lidar = busModule.bus.latest<{ values: Float32Array; meta: { frame: string } }>('titan/lidar')
    expect([...(lidar?.data.values ?? [])]).toEqual([1, 2, 3])
    expect(lidar?.data.meta.frame).toBe('lidar')
  })

  it('builds board data URLs safely', () => {
    expect(client.boardDataUrl('data/logs/run 1.mcap')).toMatch(/\/board-data\/logs\/run%201\.mcap$/)
  })
})
