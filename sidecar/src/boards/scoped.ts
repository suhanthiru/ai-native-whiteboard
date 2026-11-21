import { createReadStream, realpath as realpathCb, realpathSync } from 'node:fs'
import { promisify } from 'node:util'
import { open, readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { normaliseBoardPath, type DataFileInfo, type ReadableFile } from '@wb/sdk'

export class BoardPathError extends Error {}

/** Native realpath on both sides so drive-letter and folder casing always match. */
const realpath = promisify(realpathCb.native)

const IGNORED = new Set(['.gitkeep', '.DS_Store', 'Thumbs.db'])
const MAX_DEPTH = 6

/**
 * File access scoped to one board's data/ folder. Every path is relative,
 * normalised, and resolved on disk so symlinks cannot point outside.
 */
export class BoardData {
  private readonly realRoot: string

  constructor(readonly dataDir: string) {
    try {
      this.realRoot = realpathSync.native(dataDir)
    } catch {
      this.realRoot = dataDir
    }
  }

  /** Absolute path for a board-relative path, or throws BoardPathError. */
  async resolve(path: string): Promise<string> {
    const rel = normaliseBoardPath(path)
    if (!rel) throw new BoardPathError(`"${path}" is not a relative path inside the board's data/`)
    const absolute = join(this.dataDir, ...rel.split('/'))
    let real: string
    try {
      real = await realpath(absolute)
    } catch {
      throw new BoardPathError(`data/${rel} does not exist`)
    }
    if (real !== this.realRoot && !real.startsWith(this.realRoot + sep)) {
      throw new BoardPathError(`data/${rel} points outside the board`)
    }
    return real
  }

  async list(): Promise<DataFileInfo[]> {
    const out: DataFileInfo[] = []
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > MAX_DEPTH) return
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (IGNORED.has(entry.name) || entry.name.startsWith('.')) continue
        const full = join(dir, entry.name)
        if (entry.isDirectory()) await walk(full, depth + 1)
        else if (entry.isFile()) {
          const info = await stat(full)
          out.push({ path: relative(this.dataDir, full).split(sep).join('/'), size: info.size })
        }
      }
    }
    await walk(this.dataDir, 0)
    return out.sort((a, b) => a.path.localeCompare(b.path))
  }

  async read(path: string): Promise<Buffer> {
    return readFile(await this.resolve(path))
  }

  async stream(path: string): Promise<{ stream: NodeJS.ReadableStream; size: number; absolute: string }> {
    const absolute = await this.resolve(path)
    const info = await stat(absolute)
    if (!info.isFile()) throw new BoardPathError(`data/${path} is not a file`)
    return { stream: createReadStream(absolute), size: info.size, absolute }
  }

  async open(path: string): Promise<ReadableFile> {
    const handle = await open(await this.resolve(path), 'r')
    return {
      size: async () => BigInt((await handle.stat()).size),
      read: async (offset, length) => {
        const buffer = Buffer.alloc(Number(length))
        const { bytesRead } = await handle.read(buffer, 0, Number(length), Number(offset))
        return new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead)
      },
      close: () => handle.close(),
    }
  }
}
