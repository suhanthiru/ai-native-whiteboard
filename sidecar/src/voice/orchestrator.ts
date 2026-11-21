import { BinaryKind, encodeBinaryFrame, type VoicePhase } from '@wb/sdk'
import type { Hub } from '../hub'
import type { StateStore } from '../state/store'
import { errorMessage, logger } from '../log'
import type { Brain } from './brain'
import type { SpeechToText, TextToSpeech } from './workers'

const log = logger('voice')
const SAMPLE_RATE = 16_000
const MAX_RECORDING_BYTES = SAMPLE_RATE * 2 * 60 // one minute of 16-bit mono
const MIN_RECORDING_BYTES = SAMPLE_RATE * 2 * 0.25
const MAX_ACTIVITY = 6

/**
 * Push-to-talk loop: audio from the control window, speech-to-text, the
 * brain (which calls the MCP tools), then text-to-speech back to the window.
 * The text command bar enters the same loop at the brain step.
 */
export class VoiceOrchestrator {
  private chunks: Buffer[] = []
  private bytes = 0
  private turn = 0

  constructor(
    private readonly hub: Hub,
    private readonly store: StateStore,
    private readonly stt: SpeechToText,
    private readonly tts: TextToSpeech,
    private readonly brain: Brain,
  ) {
    hub.on('ptt', (m) => {
      if (m.state === 'start') this.startListening()
      else if (m.state === 'stop') void this.stopListening()
      else {
        // The window gave up (e.g. no microphone): drop any recording and go idle.
        this.cancel()
        this.chunks = []
        this.bytes = 0
        this.patch({ phase: 'idle' })
      }
    })
    hub.onBinary(BinaryKind.audioIn, (_header, payload) => {
      if (this.store.get().voice.phase !== 'listening') return
      if (this.bytes + payload.byteLength > MAX_RECORDING_BYTES) return
      this.chunks.push(Buffer.from(payload))
      this.bytes += payload.byteLength
    })
  }

  async probe(): Promise<void> {
    const [stt, tts, brain] = await Promise.all([this.stt.available(), this.tts.available(), this.brain.available()])
    log.info(`speech-to-text: ${stt.detail}`)
    log.info(`text-to-speech: ${tts.detail}`)
    log.info(`brain: ${brain ? this.brain.name : 'not found (install Claude Code or set WB_CLAUDE_BIN)'}`)
    this.patch({ available: { stt: stt.ok, tts: tts.ok, brain } })
  }

  /** Text from the command bar (anything that is not a /command). */
  async handleText(text: string): Promise<void> {
    const turn = ++this.turn
    this.patch({ phase: 'thinking', transcript: text, reply: '', activity: [] })
    let reply: string
    try {
      reply = await this.brain.ask(text, (line) => {
        if (turn !== this.turn) return
        const activity = [...this.store.get().voice.activity, line].slice(-MAX_ACTIVITY)
        this.patch({ activity })
      })
    } catch (error) {
      if (turn !== this.turn) return
      this.patch({ phase: 'error', reply: `Sorry, that did not work: ${errorMessage(error)}` })
      return
    }
    if (turn !== this.turn) return
    this.patch({ phase: 'speaking', reply })
    await this.say(reply, turn)
  }

  private startListening(): void {
    this.cancel()
    this.chunks = []
    this.bytes = 0
    this.patch({ phase: 'listening', transcript: '', reply: '', activity: [] })
  }

  private async stopListening(): Promise<void> {
    if (this.store.get().voice.phase !== 'listening') return
    const audio = Buffer.concat(this.chunks)
    this.chunks = []
    this.bytes = 0
    if (audio.byteLength < MIN_RECORDING_BYTES) {
      this.patch({ phase: 'idle' })
      return
    }
    const turn = ++this.turn
    this.patch({ phase: 'transcribing' })
    let text: string
    try {
      text = (await this.stt.transcribe(audio, SAMPLE_RATE)).trim()
    } catch (error) {
      if (turn === this.turn) this.patch({ phase: 'error', reply: `Speech-to-text failed: ${errorMessage(error)}` })
      return
    }
    if (turn !== this.turn) return
    if (!text) {
      this.patch({ phase: 'idle', transcript: '' })
      return
    }
    await this.handleText(text)
  }

  private async say(text: string, turn: number): Promise<void> {
    if (!text) return this.patch({ phase: 'idle' })
    try {
      const wav = await this.tts.speak(text)
      if (turn !== this.turn) return
      this.hub.broadcastBinary(encodeBinaryFrame(BinaryKind.audioOut, { format: 'wav', turn }, new Uint8Array(wav)), 'control')
    } catch (error) {
      log.warn('text-to-speech failed', errorMessage(error))
    }
    if (turn === this.turn) this.patch({ phase: 'idle' })
  }

  /** Push-to-talk while it is thinking or speaking interrupts it. */
  cancel(): void {
    this.turn += 1
    this.brain.cancel()
    this.hub.broadcast({ type: 'tts_stop' })
    const phase: VoicePhase = this.store.get().voice.phase
    if (phase !== 'idle' && phase !== 'listening') this.patch({ phase: 'idle' })
  }

  stop(): void {
    this.cancel()
    this.stt.stop()
    this.tts.stop()
  }

  private patch(partial: Partial<ReturnType<StateStore['get']>['voice']>): void {
    this.store.update((s) => ({ ...s, voice: { ...s.voice, ...partial } }))
  }
}
