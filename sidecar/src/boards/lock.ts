import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import type { DataFileInfo, DataFileStatus } from '@wb/sdk'
import { lockSchema, type LockFile } from './schema'
import type { BoardData } from './scoped'

export async function sha256File(absolute: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    createReadStream(absolute)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve())
      .on('error', reject)
  })
  return hash.digest('hex')
}

export async function computeLock(data: BoardData): Promise<LockFile> {
  const files = await data.list()
  const entries = []
  for (const f of files) {
    entries.push({ path: f.path, size: f.size, sha256: await sha256File(await data.resolve(f.path)) })
  }
  return { version: 1, files: entries }
}

export async function readLock(file: string): Promise<LockFile | null> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return null
  }
  const parsed = lockSchema.safeParse(JSON.parse(raw))
  if (!parsed.success) throw new Error(`data.lock.json is invalid: ${parsed.error.issues[0]?.message ?? 'unknown'}`)
  return parsed.data
}

export async function writeLock(file: string, lock: LockFile): Promise<void> {
  await writeFile(file, JSON.stringify(lock, null, 2) + '\n', 'utf8')
}

/**
 * Compare what is on disk with what the lock file expects.
 * `hash` lets callers skip hashing (size-only check) for very large files.
 */
export async function compareLock(
  lock: LockFile | null,
  present: DataFileInfo[],
  hash: (path: string) => Promise<string>,
): Promise<{ files: DataFileStatus[]; issues: string[] }> {
  const files: DataFileStatus[] = []
  const issues: string[] = []
  const onDisk = new Map(present.map((f) => [f.path, f]))
  const expected = new Map((lock?.files ?? []).map((f) => [f.path, f]))

  for (const want of expected.values()) {
    const have = onDisk.get(want.path)
    if (!have) {
      files.push({ path: want.path, size: want.size, status: 'missing' })
      issues.push(`data/${want.path} is missing (expected ${want.size} bytes)`)
      continue
    }
    let same = have.size === want.size
    if (same) same = (await hash(want.path)) === want.sha256
    files.push({ path: want.path, size: have.size, status: same ? 'ok' : 'changed' })
    if (!same) issues.push(`data/${want.path} does not match data.lock.json`)
  }
  for (const have of onDisk.values()) {
    if (!expected.has(have.path)) files.push({ path: have.path, size: have.size, status: 'unlocked' })
  }
  if (!lock && present.length > 0) issues.push('no data.lock.json yet; run lock_board_data to record the expected files')
  return { files: files.sort((a, b) => a.path.localeCompare(b.path)), issues }
}
