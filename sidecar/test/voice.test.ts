import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { WebSocket } from 'ws'
import { BinaryKind, decodeBinaryFrame, encodeBinaryFrame, type ServerMessage } from '@wb/sdk'
import { Hub } from '../src/hub'
import { StateStore } from '../src/state/store'
import { VOICE_PERSONA, type Brain } from '../src/voice/brain'
import { VoiceOrchestrator } from '../src/voice/orchestrator'

class FakeSocket extends EventEmitter {
  readonly OPEN = 1
  readyState = 1
  sentText: ServerMessage[] = []
  sentBinary: Uint8Array[] = []
  send(data: string | Uint8Array): void {
    if (typeof data === 'string') this.sentText.push(JSON.parse(data) as ServerMessage)
    else this.sentBinary.push(data)
  }
  close(): void {
    this.emit('close')
  }
  /** Simulate the window sending something. */
  receive(message: object | Uint8Array): void {
    if (message instanceof Uint8Array) this.emit('message', Buffer.from(message), true)
    else this.emit('message', Buffer.from(JSON.stringify(message)), false)
  }
}

function setup(brain: Partial<Brain> = {}) {
  const store = new StateStore()
  const hub = new Hub(store)
  const socket = new FakeSocket()
  hub.attach(socket as unknown as WebSocket)
  socket.receive({ type: 'hello', role: 'control' })
  const fullBrain: Brain = { name: 'fake', available: async () => true, ask: async (t, onActivity) => (onActivity('focus left_encoder'), `reply to ${t}`), cancel: vi.fn(), ...brain }
  const stt = { available: async () => ({ ok: true, detail: 'fake stt' }), transcribe: vi.fn(async () => 'explode it'), stop: vi.fn() }
  const tts = { available: async () => ({ ok: true, detail: 'fake tts' }), speak: vi.fn(async () => Buffer.from('RIFFwav')), stop: vi.fn() }
  const voice = new VoiceOrchestrator(hub, store, stt, tts, fullBrain)
  return { store, hub, socket, voice, stt, tts, brain: fullBrain }
}

const until = async (fn: () => boolean) => {
  for (let i = 0; i < 200 && !fn(); i += 1) await new Promise((r) => setTimeout(r, 10))
  expect(fn()).toBe(true)
}

describe('voice loop', () => {
  it('reports what is available', async () => {
    const { voice, store } = setup()
    await voice.probe()
    expect(store.get().voice.available).toEqual({ stt: true, tts: true, brain: true })
  })

  it('runs text through the brain and speaks the reply to the control window', async () => {
    const { voice, store, socket, tts } = setup()
    await voice.handleText('explain the lidar')
    expect(store.get().voice).toMatchObject({ phase: 'idle', transcript: 'explain the lidar', reply: 'reply to explain the lidar', activity: ['focus left_encoder'] })
    expect(tts.speak).toHaveBeenCalledWith('reply to explain the lidar')
    const frame = decodeBinaryFrame(socket.sentBinary.at(-1) ?? new Uint8Array())
    expect(frame.kind).toBe(BinaryKind.audioOut)
  })

  it('records push-to-talk audio, transcribes it and answers', async () => {
    const { store, socket, stt } = setup()
    socket.receive({ type: 'ptt', state: 'start' })
    expect(store.get().voice.phase).toBe('listening')
    socket.receive(encodeBinaryFrame(BinaryKind.audioIn, {}, new Uint8Array(16_000))) // 0.5 s of audio
    socket.receive({ type: 'ptt', state: 'stop' })
    await until(() => store.get().voice.reply === 'reply to explode it')
    expect(stt.transcribe).toHaveBeenCalledOnce()
    expect((stt.transcribe.mock.calls[0] as unknown[])[0]).toHaveLength(16_000)
  })

  it('ignores taps that are too short to be speech', async () => {
    const { store, socket, stt } = setup()
    socket.receive({ type: 'ptt', state: 'start' })
    socket.receive({ type: 'ptt', state: 'stop' })
    await until(() => store.get().voice.phase === 'idle')
    expect(stt.transcribe).not.toHaveBeenCalled()
  })

  it('shows brain failures instead of hiding them', async () => {
    const { voice, store } = setup({ ask: async () => Promise.reject(new Error('no network')) })
    await voice.handleText('hello')
    expect(store.get().voice.phase).toBe('error')
    expect(store.get().voice.reply).toMatch(/no network/)
  })

  it('interrupts speech when push-to-talk starts again', async () => {
    const { store, socket, brain } = setup()
    socket.receive({ type: 'ptt', state: 'start' })
    socket.receive({ type: 'ptt', state: 'cancel' })
    expect(brain.cancel).toHaveBeenCalled()
    expect(socket.sentText.some((m) => m.type === 'tts_stop')).toBe(true)
    expect(store.get().voice.phase).toBe('idle')
  })

  it('tells the brain to answer briefly and never invent data', () => {
    expect(VOICE_PERSONA).toMatch(/short spoken sentences/)
    expect(VOICE_PERSONA).toMatch(/Never invent sensor data/)
  })
})
