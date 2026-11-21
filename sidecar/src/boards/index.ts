import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { boardSchema, type BoardFile } from './schema'
import { logger } from '../log'

const log = logger('boards')

export interface BoardEntry {
  dir: string
  file: BoardFile
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w.length > 0 && !STOP_WORDS.has(w))
}

const STOP_WORDS = new Set(['the', 'a', 'an', 'board', 'up', 'pull', 'open', 'show', 'me', 'my'])

/** Score how well a spoken name ("the proto forest") matches a board. */
export function scoreBoard(query: string, board: BoardFile): number {
  const q = query.trim().toLowerCase()
  const names = [board.name, board.title ?? '', ...board.aliases].map((n) => n.toLowerCase()).filter(Boolean)
  if (names.includes(q)) return 100
  const qWords = words(q)
  if (qWords.length === 0) return 0
  let best = 0
  for (const name of names) {
    const nWords = words(name)
    if (nWords.length === 0) continue
    if (nWords.join(' ') === qWords.join(' ')) best = Math.max(best, 90)
    const matches = (a: string, b: string) => a === b || a.startsWith(b) || b.startsWith(a)
    // Covering every word of the board's name matters most; extra spoken words cost a little.
    const nameCovered = nWords.filter((n) => qWords.some((w) => matches(n, w))).length / nWords.length
    const queryCovered = qWords.filter((w) => nWords.some((n) => matches(n, w))).length / qWords.length
    const score = nameCovered * 60 + queryCovered * 20
    best = Math.max(best, score)
  }
  return best
}

const MIN_MATCH = 40

export class BoardIndex {
  private boards: BoardEntry[] = []

  constructor(private readonly boardsDir: string) {}

  async scan(): Promise<BoardEntry[]> {
    const out: BoardEntry[] = []
    if (!existsSync(this.boardsDir)) {
      this.boards = []
      return []
    }
    for (const entry of await readdir(this.boardsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = join(this.boardsDir, entry.name)
      const file = join(dir, 'board.json')
      if (!existsSync(file)) continue
      try {
        const parsed = boardSchema.safeParse(JSON.parse(await readFile(file, 'utf8')))
        if (!parsed.success) {
          log.warn(`boards/${entry.name}/board.json is invalid`, parsed.error.issues[0]?.message)
          continue
        }
        if (parsed.data.name !== entry.name) log.warn(`board ${entry.name}: name in board.json is "${parsed.data.name}"; using folder name`)
        out.push({ dir, file: { ...parsed.data, name: entry.name } })
      } catch (error) {
        log.warn(`could not read boards/${entry.name}/board.json`, error)
      }
    }
    this.boards = out.sort((a, b) => a.file.name.localeCompare(b.file.name))
    return this.boards
  }

  list(): BoardEntry[] {
    return this.boards
  }

  find(query: string): BoardEntry | null {
    let best: { entry: BoardEntry; score: number } | null = null
    for (const entry of this.boards) {
      const score = scoreBoard(query, entry.file)
      if (!best || score > best.score) best = { entry, score }
    }
    return best && best.score >= MIN_MATCH ? best.entry : null
  }
}
