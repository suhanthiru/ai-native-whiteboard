import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { PREVIEW_FILES } from './previews'

/** Limits for plugin source written through MCP. */
export const MAX_FILES = 40
export const MAX_FILE_BYTES = 200_000
export const MAX_TOTAL_BYTES = 1_000_000
const READ_MAX_FILE_BYTES = 60_000

const ALLOWED_EXT = /\.(tsx?|jsx?|mjs|json|css|md|svg|glsl|txt|csv)$/i
/** Compared lowercased: Windows file names ignore case. */
const SKIP_DIRS = new Set(['node_modules', '.build', 'coverage', 'test-results'])
const RESERVED = new Set(['manifest.json', 'approved.json', 'package-lock.json'])
/** Characters Windows forbids in names; ':' would also open an NTFS alternate data stream. */
const BAD_CHARS = /[:*?"<>|\u0000-\u001f]/
const DEVICE_NAMES = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i

export type PluginFiles = Readonly<Record<string, string>>

function segmentProblem(s: string): string | null {
  if (s === '' || s === '.' || s === '..') return 'no empty, "." or ".." segments'
  if (s.startsWith('.')) return 'hidden files and folders are not allowed'
  if (BAD_CHARS.test(s)) return 'no : * ? " < > | or control characters'
  if (/[. ]$/.test(s)) return 'names cannot end with a dot or a space'
  if (DEVICE_NAMES.test(s)) return `"${s}" is a reserved device name on Windows`
  if (SKIP_DIRS.has(s.toLowerCase())) return `${s} is managed by the app`
  return null
}

/** Normalise a relative plugin path to forward slashes, or explain why it is not allowed. */
export function checkPluginPath(path: string): { ok: true; path: string } | { ok: false; error: string } {
  const p = path.trim().replace(/\\/g, '/')
  if (!p) return { ok: false, error: 'empty path' }
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return { ok: false, error: `${path}: must be relative to the plugin folder` }
  for (const s of p.split('/')) {
    const problem = segmentProblem(s)
    if (problem) return { ok: false, error: `${path}: ${problem}` }
  }
  if (RESERVED.has(p.toLowerCase())) return { ok: false, error: `${path}: written by the app (pass the manifest separately; npm writes the lockfile)` }
  if (!ALLOWED_EXT.test(p)) return { ok: false, error: `${path}: only source, style, data and text files (.ts .tsx .js .json .css .md .svg .glsl .txt .csv)` }
  return { ok: true, path: p }
}

/** Registry version ranges and tags only: no file:, git, URL, alias or user/repo specifiers. */
const NON_REGISTRY_SPEC = /^(file|link|git|git\+[a-z]+|https?|github|gitlab|bitbucket|npm|workspace|portal|patch):|\/|\\/i

/** Validate a whole file set. Returns normalised entries or the list of problems. */
export function checkPluginFiles(files: PluginFiles): { ok: true; files: [string, string][] } | { ok: false; errors: string[] } {
  const entries = Object.entries(files)
  const errors: string[] = []
  if (entries.length > MAX_FILES) errors.push(`at most ${MAX_FILES} files per call`)
  const seen = new Set<string>()
  const normalised: [string, string][] = []
  let total = 0
  for (const [path, content] of entries) {
    const checked = checkPluginPath(path)
    if (!checked.ok) {
      errors.push(checked.error)
      continue
    }
    const key = checked.path.toLowerCase()
    if (seen.has(key)) errors.push(`${checked.path}: listed twice`)
    seen.add(key)
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > MAX_FILE_BYTES) errors.push(`${checked.path}: ${bytes} bytes; the limit is ${MAX_FILE_BYTES}`)
    total += bytes
    normalised.push([checked.path, content])
  }
  if (total > MAX_TOTAL_BYTES) errors.push(`${total} bytes in total; the limit is ${MAX_TOTAL_BYTES}`)
  return errors.length ? { ok: false, errors } : { ok: true, files: normalised }
}

/**
 * npm dependencies declared by a package.json text, as name@range. Throws on
 * invalid JSON or on specifiers that would bypass the registry.
 */
export function dependenciesIn(packageJson: string | undefined): string[] {
  if (!packageJson) return []
  const parsed = JSON.parse(packageJson) as { dependencies?: Record<string, unknown> }
  const entries = Object.entries(parsed.dependencies ?? {})
  const bad = entries.filter(([, range]) => typeof range !== 'string' || NON_REGISTRY_SPEC.test(range))
  if (bad.length) throw new Error(`dependencies must be npm registry versions (like ^1.2.0), not: ${bad.map(([n, r]) => `${n}@${String(r)}`).join(', ')}`)
  return entries.map(([name, range]) => `${name}@${String(range)}`)
}

function inside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path))
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(sep) && !/^[a-zA-Z]:/.test(rel)
}

/** Write manifest.json plus the given files into a plugin folder. Paths must already be checked. */
export async function writePluginFiles(dir: string, manifest: Record<string, unknown>, files: readonly (readonly [string, string])[]): Promise<void> {
  await mkdir(dir, { recursive: true })
  const realRoot = await realpath(dir)
  for (const [path, content] of files) {
    const target = join(dir, ...path.split('/'))
    if (!inside(dir, target)) throw new Error(`${path} escapes the plugin folder`)
    await mkdir(dirname(target), { recursive: true })
    // A junction or symlink inside the folder must not redirect the write elsewhere.
    const realParent = await realpath(dirname(target))
    if (realParent !== realRoot && !inside(realRoot, realParent)) throw new Error(`${path} resolves outside the plugin folder`)
    await writeFile(target, content, 'utf8')
  }
  // Manifest last: the watcher's debounce then sees one consistent plugin.
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
}

export interface PluginSourceFile {
  path: string
  bytes: number
  /** Omitted when the file is too large to return. */
  content?: string
}

/** Read a plugin's source files (no node_modules or build output). */
export async function readPluginFiles(dir: string): Promise<PluginSourceFile[]> {
  if (!existsSync(dir)) return []
  const out: PluginSourceFile[] = []
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const lower = e.name.toLowerCase()
      if (SKIP_DIRS.has(lower) || e.name.startsWith('.') || lower === 'package-lock.json' || (PREVIEW_FILES as readonly string[]).includes(lower)) continue
      const full = join(d, e.name)
      if (e.isDirectory()) {
        await walk(full)
        continue
      }
      if (!e.isFile()) continue
      const path = relative(dir, full).split(sep).join('/')
      const { size } = await stat(full)
      out.push(size > READ_MAX_FILE_BYTES ? { path, bytes: size } : { path, bytes: size, content: await readFile(full, 'utf8') })
    }
  }
  await walk(dir)
  return out.sort((a, b) => a.path.localeCompare(b.path))
}
