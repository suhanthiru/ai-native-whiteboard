import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { parseManifest, type PluginManifest } from '@wb/sdk'
import { PREVIEW_FILES, PREVIEW_TMP } from '../skills/previews'

export interface PluginSource {
  name: string
  dir: string
  source: 'shared' | 'board'
  manifest: PluginManifest | null
  error?: string
  /** When manifest.json last changed (ISO). */
  updatedAt?: string
}

/**
 * Folders and files that do not change what a plugin does (compared
 * lowercased: Windows paths ignore case). Recorded previews are media, not
 * code, so recording one never asks for approval again.
 */
const SKIP = new Set(['node_modules', '.build', 'coverage', 'test-results', '.ds_store', ...PREVIEW_FILES])

async function readSource(dir: string, source: 'shared' | 'board'): Promise<PluginSource> {
  const folder = dir.split(sep).pop() ?? dir
  const file = join(dir, 'manifest.json')
  try {
    const parsed = parseManifest(JSON.parse(await readFile(file, 'utf8')))
    if (!parsed.ok) return { name: folder, dir, source, manifest: null, error: `manifest.json: ${parsed.error}` }
    if (parsed.manifest.name !== folder) {
      return { name: folder, dir, source, manifest: null, error: `manifest name "${parsed.manifest.name}" must match folder "${folder}"` }
    }
    const updatedAt = (await stat(file)).mtime.toISOString()
    return { name: folder, dir, source, manifest: parsed.manifest, updatedAt }
  } catch (error) {
    return { name: folder, dir, source, manifest: null, error: `manifest.json unreadable: ${error instanceof Error ? error.message : String(error)}` }
  }
}

async function listPluginDirs(root: string | null): Promise<string[]> {
  if (!root || !existsSync(root)) return []
  const entries = await readdir(root, { withFileTypes: true })
  return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.') && existsSync(join(root, e.name, 'manifest.json'))).map((e) => join(root, e.name))
}

/** Shared plugins plus the open board's plugins; a board plugin overrides a shared one with the same name. */
export async function discoverPlugins(sharedDir: string, boardDir: string | null): Promise<PluginSource[]> {
  const byName = new Map<string, PluginSource>()
  for (const dir of await listPluginDirs(sharedDir)) {
    const s = await readSource(dir, 'shared')
    byName.set(s.name, s)
  }
  for (const dir of await listPluginDirs(boardDir)) {
    const s = await readSource(dir, 'board')
    byName.set(s.name, s)
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** Content hash of a plugin folder. Any edit changes it, which asks for approval again. */
export async function hashPluginDir(dir: string): Promise<string> {
  const files: string[] = []
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (SKIP.has(e.name.toLowerCase()) || PREVIEW_TMP.test(e.name)) continue
      const full = join(d, e.name)
      if (e.isDirectory()) await walk(full)
      else if (e.isFile()) files.push(full)
    }
  }
  await walk(dir)
  files.sort()
  const hash = createHash('sha256')
  for (const f of files) {
    hash.update(relative(dir, f).split(sep).join('/'))
    hash.update('\0')
    hash.update(await readFile(f))
    hash.update('\0')
  }
  return hash.digest('hex').slice(0, 16)
}
