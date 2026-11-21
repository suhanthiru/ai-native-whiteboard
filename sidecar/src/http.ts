import { createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { WebSocketServer } from 'ws'
import type { SidecarConfig } from './config'
import type { Hub } from './hub'
import type { BoardService } from './boards/service'
import { BoardPathError } from './boards/scoped'
import { errorMessage, logger } from './log'

const log = logger('http')

const CONTENT_TYPES: Record<string, string> = {
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.mcap': 'application/octet-stream',
  '.ply': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.hdr': 'application/octet-stream',
}

export type McpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

export function isAllowedOrigin(origin: string | undefined, config: SidecarConfig): boolean {
  if (!origin) return true // non-browser clients (tests, curl) send no Origin
  return config.allowedOrigins.includes(origin)
}

/** Host header must be loopback, which blocks DNS-rebinding attacks. */
export function isLoopbackHost(host: string | undefined, port: number): boolean {
  if (!host) return false
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host)
}

function setCors(req: IncomingMessage, res: ServerResponse, config: SidecarConfig): void {
  const origin = req.headers.origin
  if (origin && config.allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

interface HttpDeps {
  config: SidecarConfig
  hub: Hub
  boards: BoardService
  mcp: McpHandler
  /** A plugin's recorded preview (skill viewer tooltips). */
  skillPreview?: (name: string) => { path: string; type: string } | null
}

const PLUGIN_NAME = /^[a-z][a-z0-9-]{1,47}$/

export interface RunningServer {
  server: Server
  port: number
  close(): Promise<void>
}

export async function startHttp({ config, hub, boards, mcp, skillPreview }: HttpDeps): Promise<RunningServer> {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 })
  let boundPort = config.port

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      log.error('request failed', error)
      if (!res.headersSent) sendJson(res, 500, { error: errorMessage(error) })
      else res.end()
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
    if (!isLoopbackHost(req.headers.host, boundPort)) return sendJson(res, 403, { error: 'host not allowed' })

    if (url.pathname === '/mcp') {
      if (req.headers.origin && !isAllowedOrigin(req.headers.origin, config)) return sendJson(res, 403, { error: 'origin not allowed' })
      const auth = req.headers.authorization ?? ''
      if (!safeEqual(auth, `Bearer ${config.token}`)) return sendJson(res, 401, { error: 'missing or wrong bearer token' })
      return mcp(req, res)
    }

    if (!isAllowedOrigin(req.headers.origin, config)) return sendJson(res, 403, { error: 'origin not allowed' })
    setCors(req, res, config)

    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Headers': 'Content-Type' })
      return void res.end()
    }
    if (url.pathname === '/health') return sendJson(res, 200, { ok: true, board: boards.open?.entry.file.name ?? null })

    if (url.pathname.startsWith('/board-data/') && req.method === 'GET') {
      const board = boards.open
      if (!board) return sendJson(res, 404, { error: 'no board open' })
      const rel = decodeURIComponent(url.pathname.slice('/board-data/'.length))
      try {
        const { stream, size, absolute } = await board.data.stream(rel)
        const ext = absolute.slice(absolute.lastIndexOf('.')).toLowerCase()
        res.writeHead(200, { 'Content-Type': CONTENT_TYPES[ext] ?? 'application/octet-stream', 'Content-Length': size, 'Cache-Control': 'no-cache' })
        // pipeline closes the file on client abort and turns read errors into a closed response, not a crash.
        pipeline(stream, res).catch((error: unknown) => log.debug('board-data stream ended early', errorMessage(error)))
      } catch (error) {
        sendJson(res, error instanceof BoardPathError ? 404 : 500, { error: errorMessage(error) })
      }
      return
    }
    if (url.pathname.startsWith('/skill-preview/') && req.method === 'GET') {
      const name = decodeURIComponent(url.pathname.slice('/skill-preview/'.length))
      const file = PLUGIN_NAME.test(name) ? skillPreview?.(name) ?? null : null
      if (!file) return sendJson(res, 404, { error: 'no preview' })
      res.writeHead(200, { 'Content-Type': file.type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' })
      createReadStream(file.path)
        .on('error', (error) => {
          log.warn('preview read failed', errorMessage(error))
          res.destroy()
        })
        .pipe(res)
      return
    }
    sendJson(res, 404, { error: 'not found' })
  }

  server.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '').split('?')[0]
    if (path !== '/ws' || !isLoopbackHost(req.headers.host, boundPort) || !isAllowedOrigin(req.headers.origin, config)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => hub.attach(ws))
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  boundPort = typeof address === 'object' && address ? address.port : config.port
  log.info(`listening on http://${config.host}:${boundPort}`)

  return {
    server,
    port: boundPort,
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of wss.clients) c.terminate()
        wss.close()
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}
