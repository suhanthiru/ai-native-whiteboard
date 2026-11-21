import { McapIndexedReader } from '@mcap/core'
import { matchesPattern, type DataFileInfo, type PluginRequirement } from '@wb/sdk'
import type { BoardData } from './scoped'
import { errorMessage } from '../log'

const EXTENSIONS: Record<PluginRequirement['type'], string[]> = {
  mcap: ['.mcap'],
  glb: ['.glb', '.gltf'],
  pointcloud: ['.ply', '.las', '.laz', '.pcd'],
  file: [],
}

export interface RequirementResult {
  met: boolean
  /** Human message for the plugin tray and for tools that cannot run. */
  message?: string
  /** Files that satisfied the requirement. */
  files: string[]
}

function candidates(req: PluginRequirement, files: DataFileInfo[]): DataFileInfo[] {
  const exts = EXTENSIONS[req.type]
  return files.filter((f) => {
    if (req.pattern && !matchesPattern(f.path, req.pattern)) return false
    if (exts.length && !exts.some((e) => f.path.toLowerCase().endsWith(e))) return false
    return true
  })
}

/** Topics in an MCAP file's summary. Cached by path and size. */
const topicCache = new Map<string, string[]>()

export async function mcapTopics(data: BoardData, path: string, size: number): Promise<string[]> {
  const key = `${data.dataDir}|${path}|${size}`
  const cached = topicCache.get(key)
  if (cached) return cached
  const file = await data.open(path)
  try {
    const reader = await McapIndexedReader.Initialize({ readable: file })
    const topics = [...new Set([...reader.channelsById.values()].map((c) => c.topic))].sort()
    topicCache.set(key, topics)
    return topics
  } finally {
    await file.close()
  }
}

function describe(req: PluginRequirement): string {
  if (req.hint) return req.hint
  const what = req.type === 'file' ? `a file matching ${req.pattern ?? '*'}` : `an ${req.type.toUpperCase()}${req.pattern ? ` matching ${req.pattern}` : ''}`
  const topics = req.topics?.length ? ` with ${req.topics.join(', ')}` : ''
  return `drop ${what}${topics} into data/`
}

export async function checkRequirement(req: PluginRequirement, data: BoardData | null, files: DataFileInfo[]): Promise<RequirementResult> {
  if (!data) return { met: false, message: 'open a board first', files: [] }
  const matching = candidates(req, files)
  if (matching.length === 0) return { met: false, message: describe(req), files: [] }
  if (req.type !== 'mcap' || !req.topics?.length) return { met: true, files: matching.map((f) => f.path) }

  const found: string[] = []
  const problems: string[] = []
  for (const f of matching) {
    try {
      const topics = await mcapTopics(data, f.path, f.size)
      if (req.topics.every((t) => topics.includes(t))) found.push(f.path)
    } catch (error) {
      problems.push(`data/${f.path}: ${errorMessage(error)}`)
    }
  }
  if (found.length) return { met: true, files: found }
  return { met: false, message: problems.length ? `${describe(req)} (${problems.join('; ')})` : describe(req), files: [] }
}

export async function checkRequirements(reqs: PluginRequirement[], data: BoardData | null, files: DataFileInfo[]): Promise<RequirementResult> {
  const all: string[] = []
  for (const req of reqs) {
    const r = await checkRequirement(req, data, files)
    if (!r.met) return r
    all.push(...r.files)
  }
  return { met: true, files: [...new Set(all)] }
}
