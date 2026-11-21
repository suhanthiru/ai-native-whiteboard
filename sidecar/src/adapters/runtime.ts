/**
 * Runs inside the adapter child process (bundled together with the plugin's
 * adapter). Implements AdapterApi over IPC. The process runs under
 * `node --permission` with read access to the board's data/ only.
 */
import { open, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { normaliseBoardPath, type AdapterApi, type AdapterModule, type AdapterToolDefinition, type DataFileInfo, type ReadableFile } from '@wb/sdk'
import type { AdapterStart, ChildMessage, ParentMessage } from './protocol'

function send(message: ChildMessage): void {
  process.send?.(message)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function resolveIn(dataDir: string, path: string): Promise<string> {
  const rel = normaliseBoardPath(path)
  if (!rel) throw new Error(`"${path}" is not a relative path inside data/`)
  const root = await realpath(dataDir)
  const real = await realpath(join(dataDir, ...rel.split('/')))
  if (real !== root && !real.startsWith(root + sep)) throw new Error(`data/${rel} points outside the board`)
  return real
}

async function listData(dataDir: string): Promise<DataFileInfo[]> {
  const out: DataFileInfo[] = []
  const walk = async (d: string, depth: number): Promise<void> => {
    if (depth > 6) return
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (e.name.startsWith('.')) continue
      const full = join(d, e.name)
      if (e.isDirectory()) await walk(full, depth + 1)
      else if (e.isFile()) out.push({ path: relative(dataDir, full).split(sep).join('/'), size: (await stat(full)).size })
    }
  }
  await walk(dataDir, 0)
  return out
}

function makeApi(start: AdapterStart, tools: Map<string, AdapterToolDefinition>): AdapterApi {
  const log = (level: 'info' | 'warn' | 'error') => (message: string, ...rest: unknown[]) =>
    send({ type: 'log', level, message: [message, ...rest.map((r) => (typeof r === 'string' ? r : JSON.stringify(r)))].join(' ') })
  return {
    plugin: start.plugin,
    board: {
      name: start.boardName,
      data: {
        list: () => listData(start.dataDir),
        read: async (path) => new Uint8Array(await readFile(await resolveIn(start.dataDir, path))),
        open: async (path): Promise<ReadableFile> => {
          const handle = await open(await resolveIn(start.dataDir, path), 'r')
          return {
            size: async () => BigInt((await handle.stat()).size),
            read: async (offset, length) => {
              const buffer = Buffer.alloc(Number(length))
              const { bytesRead } = await handle.read(buffer, 0, Number(length), Number(offset))
              return new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead)
            },
            close: () => handle.close(),
          }
        },
      },
    },
    config: start.config,
    publish: (topic, data, t = Date.now() / 1000) => send({ type: 'publish', topic, t, data }),
    publishBinary: (topic, payload, t, meta = {}) => send({ type: 'publishBinary', topic, t, meta, payload }),
    registerTool: (tool) => {
      tools.set(tool.name, tool)
      send({ type: 'registerTool', tool: { name: tool.name, description: tool.description, inputSchema: tool.inputSchema, requiresApproval: tool.requiresApproval } })
    },
    log: log('info'),
  }
}

export function runAdapter(module: AdapterModule | { default: AdapterModule }): void {
  const adapter = 'start' in module ? module : module.default
  const tools = new Map<string, AdapterToolDefinition>()
  let started = false

  process.on('message', (raw: ParentMessage) => {
    void (async () => {
      if (raw.type === 'start' && !started) {
        started = true
        try {
          await adapter.start(makeApi(raw, tools))
          send({ type: 'ready' })
        } catch (error) {
          send({ type: 'fatal', message: `start failed: ${errorText(error)}` })
        }
      } else if (raw.type === 'callTool') {
        const tool = tools.get(raw.name)
        if (!tool) return send({ type: 'toolResult', id: raw.id, ok: false, error: `unknown tool ${raw.name}` })
        try {
          send({ type: 'toolResult', id: raw.id, ok: true, result: (await tool.run(raw.args)) ?? null })
        } catch (error) {
          send({ type: 'toolResult', id: raw.id, ok: false, error: errorText(error) })
        }
      } else if (raw.type === 'stop') {
        try {
          await adapter.stop?.()
        } finally {
          process.exit(0)
        }
      }
    })()
  })
  // The sidecar died or closed the channel: do not linger as an orphan.
  process.on('disconnect', () => process.exit(0))
  process.on('uncaughtException', (error) => {
    send({ type: 'fatal', message: errorText(error) })
    process.exit(1)
  })
  process.on('unhandledRejection', (error) => send({ type: 'log', level: 'error', message: `unhandled rejection: ${errorText(error)}` }))
}
