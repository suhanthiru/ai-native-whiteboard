import { fork, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { errorMessage, logger } from '../log'
import type { AdapterToolInfo, ChildMessage, ParentMessage } from './protocol'

const here = dirname(fileURLToPath(import.meta.url))
export const RUNTIME_ENTRY = join(here, 'runtime.ts')
const TOOL_TIMEOUT_MS = 30_000
const START_TIMEOUT_MS = 15_000
const MAX_OLD_SPACE_MB = 512

/** Build the network guard preload once per runtime dir. */
export async function ensureNetGuard(runtimeDir: string): Promise<string> {
  const out = join(runtimeDir, 'net-guard.mjs')
  if (!existsSync(out)) {
    await build({ entryPoints: [join(here, 'netGuardPreload.ts')], bundle: true, outfile: out, format: 'esm', platform: 'node', target: 'node22', logLevel: 'silent' })
  }
  return out
}

export interface SandboxSpawnOptions {
  entry: string
  readPaths: string[]
  writePaths?: string[]
  network: boolean
  netGuard: string
  maxOldSpaceMb?: number
  cwd?: string
}

/** Fork a Node child under the permission model: read/write only where listed, no child processes, no workers. */
export function spawnRestricted(options: SandboxSpawnOptions): ChildProcess {
  const execArgv = ['--permission', `--max-old-space-size=${options.maxOldSpaceMb ?? MAX_OLD_SPACE_MB}`]
  const reads = [options.entry, ...options.readPaths]
  if (!options.network) {
    execArgv.push(`--import=${options.netGuard.split('\\').join('/').replace(/^([A-Za-z]):/, 'file:///$1:')}`)
    reads.push(options.netGuard)
  }
  for (const p of reads) execArgv.push(`--allow-fs-read=${p}`)
  for (const p of options.writePaths ?? []) execArgv.push(`--allow-fs-write=${p}`)
  return fork(options.entry, [], {
    execArgv,
    cwd: options.cwd,
    serialization: 'advanced',
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { NODE_ENV: 'production', PATH: process.env.PATH ?? '' },
  })
}

export interface AdapterHandlers {
  onPublish(topic: string, data: unknown, t: number): void
  onPublishBinary(topic: string, payload: Uint8Array, t: number, meta: Record<string, unknown>): void
  onTools(tools: AdapterToolInfo[]): void
  onExit(reason: string): void
}

export interface AdapterStartOptions {
  plugin: string
  bundle: string
  boardName: string
  dataDir: string
  config: Record<string, unknown>
  network: boolean
  netGuard: string
}

/** One running backend adapter. */
export class AdapterProcess {
  private child: ChildProcess | null = null
  private readonly tools: AdapterToolInfo[] = []
  private readonly pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  private readonly log

  constructor(
    private readonly options: AdapterStartOptions,
    private readonly handlers: AdapterHandlers,
  ) {
    this.log = logger(`adapter:${options.plugin}`)
  }

  start(): Promise<void> {
    const child = spawnRestricted({ entry: this.options.bundle, readPaths: [this.options.dataDir], network: this.options.network, netGuard: this.options.netGuard })
    this.child = child
    child.stdout?.on('data', (d: Buffer) => this.log.info(d.toString().trimEnd()))
    child.stderr?.on('data', (d: Buffer) => this.log.warn(d.toString().trimEnd()))
    return new Promise((resolve, reject) => {
      let settled = false
      // A start() that never finishes must not block the plugin queue (or board open) forever.
      const startTimer = setTimeout(() => {
        if (settled) return
        settled = true
        child.kill('SIGKILL')
        reject(new Error(`adapter did not start within ${START_TIMEOUT_MS / 1000}s`))
      }, START_TIMEOUT_MS)
      child.on('message', (m: ChildMessage) => {
        if (m.type === 'ready' && !settled) {
          settled = true
          clearTimeout(startTimer)
          resolve()
        } else if (m.type === 'fatal') {
          this.log.error(m.message)
          if (!settled) {
            settled = true
            clearTimeout(startTimer)
            reject(new Error(m.message))
          }
        } else this.handle(m)
      })
      child.on('exit', (code, signal) => {
        const reason = `exited (${signal ?? code ?? 'unknown'})`
        for (const p of this.pending.values()) {
          clearTimeout(p.timer)
          p.reject(new Error(`adapter ${reason}`))
        }
        this.pending.clear()
        clearTimeout(startTimer)
        if (!settled) {
          settled = true
          reject(new Error(`adapter ${reason} before it was ready`))
        }
        this.handlers.onExit(reason)
      })
      const start: ParentMessage = {
        type: 'start',
        plugin: this.options.plugin,
        boardName: this.options.boardName,
        dataDir: this.options.dataDir,
        config: this.options.config,
        network: this.options.network,
      }
      child.send(start)
    })
  }

  callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const child = this.child
    if (!child || !child.connected) return Promise.reject(new Error('adapter is not running'))
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${name} timed out`))
      }, TOOL_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      child.send({ type: 'callTool', id, name, args } satisfies ParentMessage)
    })
  }

  async stop(): Promise<void> {
    const child = this.child
    this.child = null
    if (!child || child.exitCode !== null) return
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, 1500)
      child.once('exit', () => {
        clearTimeout(kill)
        resolve()
      })
      try {
        child.send({ type: 'stop' } satisfies ParentMessage)
      } catch (error) {
        this.log.warn('stop failed', errorMessage(error))
        child.kill()
      }
    })
  }

  private handle(m: ChildMessage): void {
    switch (m.type) {
      case 'publish':
        return this.handlers.onPublish(m.topic, m.data, m.t)
      case 'publishBinary':
        return this.handlers.onPublishBinary(m.topic, m.payload, m.t, m.meta)
      case 'registerTool':
        this.tools.push(m.tool)
        return this.handlers.onTools([...this.tools])
      case 'toolResult': {
        const p = this.pending.get(m.id)
        if (!p) return
        this.pending.delete(m.id)
        clearTimeout(p.timer)
        if (m.ok) p.resolve(m.result)
        else p.reject(new Error(m.error))
        return
      }
      case 'log':
        return this.log[m.level](m.message)
      default:
        return undefined
    }
  }
}
