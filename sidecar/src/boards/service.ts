import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { normaliseBoardPath, type BoardStatus, type DataFileInfo } from '@wb/sdk'
import type { Hub } from '../hub'
import type { StateStore } from '../state/store'
import { errorMessage, logger } from '../log'
import { BoardIndex, type BoardEntry } from './index'
import { compareLock, computeLock, readLock, sha256File, writeLock } from './lock'
import { BoardData } from './scoped'

const log = logger('board')
const CANVAS_FILE = 'canvas.json'
const CANVAS_SAVE_DEBOUNCE_MS = 800

export interface OpenBoard {
  entry: BoardEntry
  data: BoardData
  files: DataFileInfo[]
}

/** Opens boards, tracks the current one, and keeps its canvas saved. */
export class BoardService extends EventEmitter<{ opened: [OpenBoard]; dataChanged: [OpenBoard] }> {
  readonly index: BoardIndex
  private current: OpenBoard | null = null
  private canvasTimer: NodeJS.Timeout | null = null
  private pendingCanvas: unknown = null
  /** True while switching boards: saves from the old board's canvas are dropped. */
  private switching = false

  constructor(
    boardsDir: string,
    private readonly store: StateStore,
    private readonly hub: Hub,
    private readonly publicUrl: () => string,
  ) {
    super()
    this.index = new BoardIndex(boardsDir)
    hub.on('canvas_save', (m) => this.scheduleCanvasSave(m.snapshot, m.board))
    hub.onReady((client) => {
      if (client.role === 'control' && this.current) void this.sendCanvas(client.send)
    })
  }

  get open(): OpenBoard | null {
    return this.current
  }

  async refreshIndex(): Promise<void> {
    const boards = await this.index.scan()
    this.store.patch(
      'boards',
      boards.map((b) => ({ name: b.file.name, title: b.file.title ?? b.file.name, aliases: b.file.aliases })),
    )
  }

  async openBoard(query: string): Promise<BoardStatus> {
    await this.refreshIndex()
    const entry = this.index.find(query)
    if (!entry) {
      const names = this.index.list().map((b) => b.file.name)
      throw new Error(`No board matches "${query}". Boards: ${names.join(', ') || 'none'}`)
    }
    await this.flushCanvas()
    this.switching = true
    const data = new BoardData(join(entry.dir, 'data'))
    const files = await data.list()
    this.current = { entry, data, files }
    const status = await this.computeStatus()
    const model = entry.file.model ? normaliseBoardPath(entry.file.model) : null
    this.store.update((s) => ({
      ...s,
      board: status,
      scene: {
        ...s.scene,
        model: model && files.some((f) => f.path === model) ? this.dataUrl(model) : null,
        modelFile: model,
        explode: 0,
        focus: null,
        annotations: [],
        viewNonce: s.scene.viewNonce + 1,
      },
      panels: [],
    }))
    await this.sendCanvas((m) => this.hub.sendTo('control', m))
    this.switching = false
    log.info(`opened board ${entry.file.name} (${files.length} data files)`)
    this.emit('opened', this.current)
    return status
  }

  dataUrl(path: string): string {
    return `${this.publicUrl()}/board-data/${path.split('/').map(encodeURIComponent).join('/')}`
  }

  async rescanData(): Promise<void> {
    if (!this.current) return
    this.current = { ...this.current, files: await this.current.data.list() }
    this.store.patch('board', await this.computeStatus())
    this.emit('dataChanged', this.current)
  }

  async lockData(): Promise<{ files: number }> {
    const board = this.requireOpen()
    const lock = await computeLock(board.data)
    await writeLock(join(board.entry.dir, 'data.lock.json'), lock)
    await this.rescanData()
    return { files: lock.files.length }
  }

  async computeStatus(): Promise<BoardStatus> {
    const board = this.requireOpen()
    const f = board.entry.file
    let issues: string[] = []
    let files: BoardStatus['files'] = board.files.map((x) => ({ path: x.path, size: x.size, status: 'unlocked' as const }))
    try {
      const lock = await readLock(join(board.entry.dir, 'data.lock.json'))
      const compared = await compareLock(lock, board.files, async (p) => sha256File(await board.data.resolve(p)))
      files = compared.files
      issues = compared.issues
    } catch (error) {
      issues = [errorMessage(error)]
    }
    if (f.model && !board.files.some((x) => x.path === normaliseBoardPath(f.model ?? ''))) {
      issues.push(`model ${f.model} is not in data/ (run npm run make:demo for the demo board)`)
    }
    return { name: f.name, title: f.title ?? f.name, aliases: f.aliases, description: f.description, files, issues, config: f.pluginConfig }
  }

  pluginConfig(plugin: string): Record<string, unknown> {
    return this.current?.entry.file.pluginConfig[plugin] ?? {}
  }

  enabledPlugins(): string[] {
    return this.current?.entry.file.enabledPlugins ?? []
  }

  boardPluginsDir(): string | null {
    return this.current ? join(this.current.entry.dir, 'plugins') : null
  }

  async flushCanvas(): Promise<void> {
    if (this.canvasTimer) clearTimeout(this.canvasTimer)
    this.canvasTimer = null
    if (this.pendingCanvas !== null && this.current) {
      const snapshot = this.pendingCanvas
      const file = join(this.current.entry.dir, CANVAS_FILE)
      // Write a temp file and rename it, so a crash mid-write never corrupts canvas.json.
      // pendingCanvas is only cleared after the write succeeds.
      await writeFile(`${file}.tmp`, JSON.stringify(snapshot) + '\n', 'utf8')
      await rename(`${file}.tmp`, file)
      if (this.pendingCanvas === snapshot) this.pendingCanvas = null
    }
  }

  private scheduleCanvasSave(snapshot: unknown, board: string | undefined): void {
    if (!this.current || this.switching) return
    if (board && board !== this.current.entry.file.name) return // a late save from the previous board's canvas
    this.pendingCanvas = snapshot
    if (this.canvasTimer) clearTimeout(this.canvasTimer)
    this.canvasTimer = setTimeout(() => {
      this.flushCanvas().catch((error: unknown) => log.error('saving canvas failed', error))
    }, CANVAS_SAVE_DEBOUNCE_MS)
  }

  private async sendCanvas(send: (m: { type: 'canvas_load'; snapshot: unknown | null; board: string }) => void): Promise<void> {
    if (!this.current) return
    const file = join(this.current.entry.dir, CANVAS_FILE)
    let snapshot: unknown = null
    if (existsSync(file)) {
      try {
        snapshot = JSON.parse(await readFile(file, 'utf8'))
      } catch (error) {
        log.warn(`${CANVAS_FILE} is unreadable; starting with an empty canvas`, errorMessage(error))
      }
    }
    send({ type: 'canvas_load', snapshot, board: this.current.entry.file.name })
  }

  private requireOpen(): OpenBoard {
    if (!this.current) throw new Error('No board is open. Call open_board first.')
    return this.current
  }
}
