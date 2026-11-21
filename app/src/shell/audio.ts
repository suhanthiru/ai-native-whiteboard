/**
 * Microphone capture (16 kHz mono PCM16 to the sidecar) and playback of the
 * spoken reply.
 */
import { BinaryKind } from '@wb/sdk'
import { sidecar } from '../core/rpc/client'
import { reportError } from '../core/errors'

const SAMPLE_RATE = 16_000

const WORKLET = `
class PcmCapture extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch) this.port.postMessage(ch.slice(0))
    return true
  }
}
registerProcessor('wb-pcm-capture', PcmCapture)
`

function toPcm16(samples: Float32Array): Uint8Array {
  const out = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0))
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return new Uint8Array(out.buffer)
}

export class Microphone {
  private context: AudioContext | null = null
  private stream: MediaStream | null = null
  private node: AudioWorkletNode | null = null

  async start(): Promise<void> {
    if (this.context) return
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
    this.context = new AudioContext({ sampleRate: SAMPLE_RATE })
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }))
    try {
      await this.context.audioWorklet.addModule(url)
    } finally {
      URL.revokeObjectURL(url)
    }
    const source = this.context.createMediaStreamSource(this.stream)
    this.node = new AudioWorkletNode(this.context, 'wb-pcm-capture')
    this.node.port.onmessage = (e: MessageEvent<Float32Array>) => sidecar.sendAudio(toPcm16(e.data))
    source.connect(this.node)
  }

  async stop(): Promise<void> {
    this.node?.disconnect()
    this.node = null
    for (const t of this.stream?.getTracks() ?? []) t.stop()
    this.stream = null
    await this.context?.close().catch(() => undefined)
    this.context = null
  }
}

/** Plays WAV replies from the sidecar; stops on tts_stop or a new push-to-talk. */
export class ReplyPlayer {
  private context: AudioContext | null = null
  private source: AudioBufferSourceNode | null = null

  connect(): () => void {
    const offAudio = sidecar.onBinary(BinaryKind.audioOut, (_header, payload) => void this.play(payload))
    const offStop = sidecar.on('tts_stop', () => this.stop())
    return () => {
      offAudio()
      offStop()
      this.stop()
    }
  }

  async play(wav: Uint8Array): Promise<void> {
    try {
      this.stop()
      this.context ??= new AudioContext()
      const buffer = await this.context.decodeAudioData(wav.slice().buffer)
      const source = this.context.createBufferSource()
      source.buffer = buffer
      source.connect(this.context.destination)
      source.start()
      this.source = source
    } catch (error) {
      reportError('playing the reply', error)
    }
  }

  stop(): void {
    try {
      this.source?.stop()
    } catch {
      // already stopped
    }
    this.source = null
  }
}
