import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { normaliseBoardPath, type AppState, type OutputView, type PluginInfo } from '@wb/sdk'
import type { BoardService } from '../boards/service'
import type { Hub } from '../hub'
import type { StateStore } from '../state/store'
import { bestMatch } from './match'
import { defineCoreTool, type RegisteredTool, type ToolResult } from './registry'

/** What the control window reported about the loaded model. */
export class ModelInfo {
  file: string | null = null
  parts: string[] = []
  private waiters: ((parts: string[]) => void)[] = []

  set(file: string, parts: string[]): void {
    this.file = file
    this.parts = parts
    for (const w of this.waiters.splice(0)) w(parts)
  }

  clear(): void {
    this.file = null
    this.parts = []
  }

  /** Wait for the control window to finish loading the model. */
  waitForParts(timeoutMs: number): Promise<string[]> {
    if (this.parts.length) return Promise.resolve(this.parts)
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(this.parts), timeoutMs)
      this.waiters.push((parts) => {
        clearTimeout(timer)
        resolve(parts)
      })
    })
  }
}

export interface CoreToolDeps {
  store: StateStore
  hub: Hub
  boards: BoardService
  model: ModelInfo
  plugins: () => PluginInfo[]
  topics: () => string[]
}

const MODEL_WAIT_MS = 4000

function ok(text: string, data?: unknown): ToolResult {
  return { text, data }
}

function fail(text: string): ToolResult {
  return { text, isError: true }
}

async function resolvePart(deps: CoreToolDeps, query: string): Promise<string | ToolResult> {
  const parts = await deps.model.waitForParts(MODEL_WAIT_MS)
  if (!parts.length) return fail('No model is loaded. Open a board with a model, or call load_model.')
  if (parts.includes(query)) return query
  const match = bestMatch(query, parts)
  if (!match) return fail(`No part matches "${query}". Parts: ${parts.join(', ')}`)
  return match.name
}

function updateScene(store: StateStore, fn: (scene: AppState['scene']) => AppState['scene']): void {
  store.update((s) => ({ ...s, scene: fn(s.scene) }))
}

export function coreTools(deps: CoreToolDeps): RegisteredTool[] {
  const { store, boards, model } = deps
  return [
    defineCoreTool({
      name: 'list_boards',
      description: 'List the boards (self-contained folders with a canvas, data and plugins). Use the name or an alias with open_board.',
      input: z.object({}),
      run: async () => {
        await boards.refreshIndex()
        const list = boards.index.list().map((b) => ({ name: b.file.name, title: b.file.title ?? b.file.name, aliases: b.file.aliases }))
        return ok(list.length ? list.map((b) => `${b.name}${b.aliases.length ? ` (${b.aliases.join(', ')})` : ''}`).join('\n') : 'No boards yet.', list)
      },
    }),
    defineCoreTool({
      name: 'open_board',
      description: 'Open a board by name or spoken alias, e.g. "titan" or "the proto forest". Loads its canvas, model, data and plugins.',
      input: z.object({ name: z.string().min(1) }),
      run: async ({ name }) => {
        model.clear()
        const status = await boards.openBoard(name)
        const lines = [`Opened ${status.title}.`]
        if (status.issues.length) lines.push(`Issues: ${status.issues.join('; ')}`)
        return ok(lines.join(' '), status)
      },
    }),
    defineCoreTool({
      name: 'board_status',
      description: 'Show the open board: data files, lock-file problems, and which plugins are active or waiting for data.',
      input: z.object({}),
      run: () => {
        const s = store.get()
        if (!s.board) return fail('No board is open.')
        const plugins = deps.plugins().map((p) => `${p.name}: ${p.state}${p.message ? ` (${p.message})` : ''}`)
        return ok([`Board ${s.board.title}`, `Files: ${s.board.files.map((f) => `${f.path} [${f.status}]`).join(', ') || 'none'}`, `Issues: ${s.board.issues.join('; ') || 'none'}`, `Plugins: ${plugins.join('; ') || 'none'}`].join('\n'), {
          board: s.board,
          plugins: deps.plugins(),
        })
      },
    }),
    defineCoreTool({
      name: 'lock_board_data',
      description: "Record the open board's data files (names, sizes, sha256) in data.lock.json. Only call when the user asks to lock or accept the current data.",
      input: z.object({}),
      run: async () => {
        const { files } = await boards.lockData()
        return ok(`Locked ${files} data file(s) in data.lock.json.`)
      },
    }),
    defineCoreTool({
      name: 'load_model',
      description: "Show a glTF/GLB model from the open board's data/ folder, e.g. data/titan.glb.",
      input: z.object({ file: z.string().min(1) }),
      run: ({ file }) => {
        const board = boards.open
        if (!board) return fail('No board is open.')
        const rel = normaliseBoardPath(file)
        if (!rel || !board.files.some((f) => f.path === rel)) {
          const glbs = board.files.filter((f) => /\.(glb|gltf)$/i.test(f.path)).map((f) => f.path)
          return fail(`data/${file} is not in this board. Models here: ${glbs.join(', ') || 'none'}`)
        }
        model.clear()
        updateScene(store, (sc) => ({ ...sc, model: boards.dataUrl(rel), modelFile: rel, explode: 0, focus: null, annotations: [], viewNonce: sc.viewNonce + 1 }))
        return ok(`Loading ${rel}.`)
      },
    }),
    defineCoreTool({
      name: 'list_parts',
      description: 'List the named parts of the loaded model. Use these names with focus and annotate.',
      input: z.object({}),
      run: async () => {
        const parts = await model.waitForParts(MODEL_WAIT_MS)
        if (!parts.length) return fail('No model is loaded.')
        return ok(parts.join(', '), parts)
      },
    }),
    defineCoreTool({
      name: 'explode',
      description: 'Explode the model so its parts separate (staggered). 0 = assembled, 1 = fully exploded.',
      input: z.object({ amount: z.number().min(0).max(1).default(0.7) }),
      run: ({ amount }) => {
        if (!store.get().scene.model) return fail('No model is loaded.')
        updateScene(store, (sc) => ({ ...sc, explode: amount }))
        return ok(amount === 0 ? 'Assembled.' : `Exploded to ${Math.round(amount * 100)}%.`)
      },
    }),
    defineCoreTool({
      name: 'focus',
      description: 'Fly the camera to one part, highlight it and dim the rest. Accepts loose names ("left wheel encoder"). Pass an empty part to clear focus.',
      input: z.object({ part: z.string().default('') }),
      run: async ({ part }) => {
        if (!part.trim()) {
          updateScene(store, (sc) => ({ ...sc, focus: null, viewNonce: sc.viewNonce + 1 }))
          return ok('Focus cleared.')
        }
        const resolved = await resolvePart(deps, part)
        if (typeof resolved !== 'string') return resolved
        updateScene(store, (sc) => ({ ...sc, focus: resolved }))
        return ok(`Focused on ${resolved}.`, { part: resolved })
      },
    }),
    defineCoreTool({
      name: 'annotate',
      description: 'Attach a short label to a part (leader line, then label). Use several short labels rather than one long one.',
      input: z.object({ part: z.string().min(1), text: z.string().min(1).max(120) }),
      run: async ({ part, text }) => {
        const resolved = await resolvePart(deps, part)
        if (typeof resolved !== 'string') return resolved
        updateScene(store, (sc) => ({
          ...sc,
          annotations: [...sc.annotations.filter((a) => !(a.part === resolved && a.text === text)), { id: randomUUID(), part: resolved, text }],
        }))
        return ok(`Labelled ${resolved}.`)
      },
    }),
    defineCoreTool({
      name: 'clear_annotations',
      description: 'Remove labels, from one part or all.',
      input: z.object({ part: z.string().optional() }),
      run: async ({ part }) => {
        const target = part ? await resolvePart(deps, part) : null
        if (target && typeof target !== 'string') return target
        updateScene(store, (sc) => ({ ...sc, annotations: target ? sc.annotations.filter((a) => a.part !== target) : [] }))
        return ok('Labels cleared.')
      },
    }),
    defineCoreTool({
      name: 'reset_view',
      description: 'Assemble the model, clear focus and labels, and fly the camera home.',
      input: z.object({}),
      run: () => {
        updateScene(store, (sc) => ({ ...sc, explode: 0, focus: null, annotations: [], viewNonce: sc.viewNonce + 1 }))
        return ok('View reset.')
      },
    }),
    defineCoreTool({
      name: 'set_output',
      description: 'Choose what the output (projector) window shows: the 3D scene, the canvas, or both side by side.',
      input: z.object({ view: z.enum(['scene', 'canvas', 'split']) }),
      run: ({ view }) => {
        store.update((s) => ({ ...s, output: { ...s.output, view: view as OutputView } }))
        return ok(`Output shows ${view}.`)
      },
    }),
    defineCoreTool({
      name: 'list_plugins',
      description: 'List plugins with their state (active, disabled waiting for data, pending approval, error) and their tools.',
      input: z.object({}),
      run: () => {
        const list = deps.plugins()
        if (!list.length) return ok('No plugins.')
        return ok(list.map((p) => `${p.name} [${p.state}]${p.message ? ` ${p.message}` : ''}${p.tools.length ? ` tools: ${p.tools.join(', ')}` : ''}`).join('\n'), list)
      },
    }),
    defineCoreTool({
      name: 'list_topics',
      description: 'List live data-bus topics (e.g. titan/left_encoder) currently publishing.',
      input: z.object({}),
      run: () => {
        const topics = deps.topics()
        return ok(topics.length ? topics.join(', ') : 'No topics are publishing. Start a data source (for example mcap playback) first.', topics)
      },
    }),
    defineCoreTool({
      name: 'add_note',
      description: 'Put a short text note on the canvas.',
      input: z.object({ text: z.string().min(1).max(2000), x: z.number().optional(), y: z.number().optional() }),
      run: async (args) => {
        const id = await deps.hub.rpc('canvas.note', args)
        return ok('Note added.', { id })
      },
    }),
  ]
}
