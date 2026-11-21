import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { errorMessage, logger } from '../log'

const REQUEST_TIMEOUT_MS = 60_000
const READY_TIMEOUT_MS = 180_000

interface Ready {
  ready: boolean
  error?: string
  [key: string]: unknown
}

/** A long-running Python worker speaking JSON lines. */
export class JsonLineWorker {
  private child: ChildProcess | null = null
  private readonly waiting = new Map<string, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  private readyInfo: Promise<Ready> | null = null
  private readonly log

  constructor(
    private readonly name: string,
    private readonly python: string,
    private readonly script: string,
  ) {
    this.log = logger(name)
  }

  start(): Promise<Ready> {
    if (this.readyInfo) return this.readyInfo
    this.readyInfo = new Promise<Ready>((resolve) => {
      if (!existsSync(this.script)) return resolve({ ready: false, error: `${this.script} not found` })
      const child = spawn(this.python, ['-u', this.script], { stdio: ['pipe', 'pipe', 'pipe'] })
      this.child = child
      let buffer = ''
      let gotReady = false
      const readyTimer = setTimeout(() => {
        if (!gotReady) resolve({ ready: false, error: 'worker did not start in time' })
      }, READY_TIMEOUT_MS)
      child.stdout?.on('data', (d: Buffer) => {
        buffer += d.toString('utf8')
        let nl = buffer.indexOf('\n')
        while (nl >= 0) {
          const line = buffer.slice(0, nl).trim()
          buffer = buffer.slice(nl + 1)
          nl = buffer.indexOf('\n')
          if (!line) continue
          let msg: Record<string, unknown>
          try {
            msg = JSON.parse(line) as Record<string, unknown>
          } catch {
            continue
          }
          if (!gotReady && 'ready' in msg) {
            gotReady = true
            clearTimeout(readyTimer)
            resolve(msg as Ready)
            continue
          }
          const id = String(msg.id ?? '')
          const w = this.waiting.get(id)
          if (!w) continue
          this.waiting.delete(id)
          clearTimeout(w.timer)
          if (msg.error) w.reject(new Error(String(msg.error)))
          else w.resolve(msg)
        }
      })
      child.stderr?.on('data', (d: Buffer) => this.log.debug(d.toString().trimEnd()))
      child.on('error', (error) => {
        clearTimeout(readyTimer)
        resolve({ ready: false, error: `could not start ${this.python}: ${errorMessage(error)}` })
      })
      child.on('exit', (code) => {
        clearTimeout(readyTimer)
        if (!gotReady) resolve({ ready: false, error: `${this.name} exited (${code})` })
        for (const w of this.waiting.values()) {
          clearTimeout(w.timer)
          w.reject(new Error(`${this.name} exited`))
        }
        this.waiting.clear()
        this.child = null
        this.readyInfo = null
      })
    })
    return this.readyInfo
  }

  async request(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const info = await this.start()
    if (!info.ready || !this.child?.stdin) throw new Error(info.error ?? `${this.name} is not available`)
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        reject(new Error(`${this.name} timed out`))
      }, REQUEST_TIMEOUT_MS)
      this.waiting.set(id, { resolve, reject, timer })
      this.child?.stdin?.write(JSON.stringify({ ...payload, id }) + '\n')
    })
  }

  stop(): void {
    this.child?.kill()
    this.child = null
  }
}

export interface SpeechToText {
  available(): Promise<{ ok: boolean; detail: string }>
  transcribe(pcm16: Buffer, rate: number): Promise<string>
  stop(): void
}

export interface TextToSpeech {
  available(): Promise<{ ok: boolean; detail: string }>
  /** WAV bytes. */
  speak(text: string): Promise<Buffer>
  stop(): void
}

export function whisperStt(rootDir: string, python: string): SpeechToText {
  const worker = new JsonLineWorker('stt', python, join(rootDir, 'voice', 'stt_worker.py'))
  return {
    async available() {
      const info = await worker.start()
      return { ok: info.ready, detail: info.ready ? `faster-whisper ${String(info.model)} on ${String(info.device)}` : (info.error ?? 'unavailable') }
    },
    async transcribe(pcm16, rate) {
      const res = await worker.request({ pcm16_b64: pcm16.toString('base64'), rate })
      return String(res.text ?? '')
    },
    stop: () => worker.stop(),
  }
}

/** Windows built-in voice through System.Speech. Works with no downloads; Kokoro sounds better. */
function windowsSapi(runtimeDir: string): TextToSpeech {
  return {
    async available() {
      return { ok: process.platform === 'win32', detail: 'Windows System.Speech' }
    },
    async speak(text) {
      const file = join(runtimeDir, `tts-${randomUUID()}.wav`)
      // Text goes in through stdin, never the command line.
      const script = [
        'Add-Type -AssemblyName System.Speech',
        '$t = [Console]::In.ReadToEnd()',
        '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
        `$s.SetOutputToWaveFile('${file.replace(/'/g, "''")}')`,
        '$s.Speak($t)',
        '$s.Dispose()',
      ].join('; ')
      await new Promise<void>((resolve, reject) => {
        const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['pipe', 'ignore', 'pipe'] })
        let err = ''
        child.stderr.on('data', (d: Buffer) => (err += d.toString()))
        child.on('error', reject)
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `powershell exited ${code}`))))
        child.stdin.end(text, 'utf8')
      })
      try {
        return await readFile(file)
      } finally {
        await rm(file, { force: true })
      }
    },
    stop: () => undefined,
  }
}

/** Kokoro/Piper through the Python worker, falling back to the OS voice. */
export function bestTts(rootDir: string, runtimeDir: string, python: string): TextToSpeech {
  const worker = new JsonLineWorker('tts', python, join(rootDir, 'voice', 'tts_worker.py'))
  const fallback = windowsSapi(runtimeDir)
  let useFallback: boolean | null = null
  let detail = ''
  const decide = async (): Promise<boolean> => {
    if (useFallback !== null) return useFallback
    const info = await worker.start()
    useFallback = !info.ready
    detail = info.ready ? String(info.engine) : `${(await fallback.available()).detail} (Kokoro/Piper unavailable: ${info.error ?? 'unknown'})`
    if (useFallback) worker.stop()
    return useFallback
  }
  return {
    async available() {
      const fb = await decide()
      return { ok: fb ? (await fallback.available()).ok : true, detail }
    },
    async speak(text) {
      if (await decide()) return fallback.speak(text)
      const res = await worker.request({ text })
      return Buffer.from(String(res.wav_b64 ?? ''), 'base64')
    },
    stop: () => worker.stop(),
  }
}
