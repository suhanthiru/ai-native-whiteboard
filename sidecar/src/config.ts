import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface SidecarConfig {
  rootDir: string
  boardsDir: string
  pluginsDir: string
  runtimeDir: string
  port: number
  host: string
  token: string
  /** Origins allowed to open the WebSocket and fetch board data. */
  allowedOrigins: string[]
  /** Board opened on start. */
  defaultBoard: string | null
}

const DEFAULT_PORT = 4319
const here = dirname(fileURLToPath(import.meta.url))

export function findRootDir(): string {
  if (process.env.WB_ROOT) return resolve(process.env.WB_ROOT)
  return resolve(here, '..', '..')
}

function loadOrCreateToken(runtimeDir: string): string {
  const file = join(runtimeDir, 'token')
  if (existsSync(file)) {
    const existing = readFileSync(file, 'utf8').trim()
    if (/^[a-f0-9]{48}$/.test(existing)) return existing
  }
  const token = randomBytes(24).toString('hex')
  writeFileSync(file, token, { encoding: 'utf8', mode: 0o600 })
  return token
}

export function loadConfig(overrides: Partial<SidecarConfig> = {}): SidecarConfig {
  const rootDir = overrides.rootDir ?? findRootDir()
  const env = process.env
  const runtimeDir = overrides.runtimeDir ?? (env.WB_RUNTIME_DIR ? resolve(env.WB_RUNTIME_DIR) : join(rootDir, '.wb'))
  mkdirSync(runtimeDir, { recursive: true })
  const port = overrides.port ?? Number(process.env.WB_PORT ?? DEFAULT_PORT)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid WB_PORT: ${process.env.WB_PORT}`)
  return {
    rootDir,
    boardsDir: overrides.boardsDir ?? (env.WB_BOARDS_DIR ? resolve(env.WB_BOARDS_DIR) : join(rootDir, 'boards')),
    pluginsDir: overrides.pluginsDir ?? (env.WB_PLUGINS_DIR ? resolve(env.WB_PLUGINS_DIR) : join(rootDir, 'plugins')),
    runtimeDir,
    port,
    host: '127.0.0.1',
    token: overrides.token ?? loadOrCreateToken(runtimeDir),
    allowedOrigins: overrides.allowedOrigins ?? [
      'http://localhost:1420',
      'http://127.0.0.1:1420',
      'tauri://localhost',
      'http://tauri.localhost',
      'https://tauri.localhost',
      ...(env.WB_EXTRA_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean),
    ],
    defaultBoard: overrides.defaultBoard !== undefined ? overrides.defaultBoard : (process.env.WB_BOARD ?? 'titan-demo'),
  }
}

/**
 * Write .mcp.json so Claude Code in this folder finds the whiteboard tools.
 * The file holds the local token, so it is gitignored.
 */
export function writeMcpConfig(config: SidecarConfig, port: number): string {
  const file = join(config.rootDir, '.mcp.json')
  let existing: { mcpServers?: Record<string, unknown> } = {}
  if (existsSync(file)) {
    try {
      existing = JSON.parse(readFileSync(file, 'utf8')) as typeof existing
    } catch {
      existing = {}
    }
  }
  const next = {
    ...existing,
    mcpServers: {
      ...(existing.mcpServers ?? {}),
      whiteboard: {
        type: 'http',
        url: `http://${config.host}:${port}/mcp`,
        headers: { Authorization: `Bearer ${config.token}` },
      },
    },
  }
  writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf8')
  return file
}
