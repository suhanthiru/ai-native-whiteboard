import { randomId } from './ids'
import { z } from 'zod'
import { design, motionTokens, type PanelDefinition, type PluginApi, type PluginBundle, type PluginModule, type Role, type Theme, type ToolDefinition } from '@wb/sdk'
import { bus } from '../bus'
import { canvasApi } from '../canvas/controller'
import { devLog, errorText, reportError } from '../errors'
import { boardDataUrl, sidecar } from '../rpc/client'
import { createSceneApi } from '../scene/registry'
import { coreUi } from './coreUi'

export interface RegisteredPanel extends PanelDefinition {
  plugin: string
}

interface LoadedPlugin {
  name: string
  hash: string
  preview: boolean
  api: PluginApi
  shapes: unknown[]
  panels: RegisteredPanel[]
  tools: Map<string, ToolDefinition>
  disposers: (() => void)[]
}

type Listener = () => void

const TOOL_TIMEOUT_MS = 25_000

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`${what} timed out`)), ms) // core timer, not animation
    promise.then(
      (v) => {
        window.clearTimeout(timer)
        resolve(v)
      },
      (e: unknown) => {
        window.clearTimeout(timer)
        reject(e instanceof Error ? e : new Error(String(e)))
      },
    )
  })
}

/** Loads plugin bundles into this window and keeps their registrations. */
export class PluginRuntime {
  private readonly plugins = new Map<string, LoadedPlugin>()
  private readonly listeners = new Set<Listener>()
  private version = 0
  private readonly loading = new Map<string, Promise<void>>()

  constructor(
    private readonly role: Role,
    private readonly theme: () => Theme,
  ) {}

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getVersion = (): number => this.version

  shapeUtils(): unknown[] {
    return [...this.plugins.values()].flatMap((p) => p.shapes)
  }

  panel(plugin: string, id: string): RegisteredPanel | undefined {
    return this.plugins.get(plugin)?.panels.find((p) => p.id === id)
  }

  apiFor(plugin: string): PluginApi | undefined {
    return this.plugins.get(plugin)?.api
  }

  load(bundle: PluginBundle): Promise<void> {
    const prev = this.loading.get(bundle.name) ?? Promise.resolve()
    const next = prev.then(() => this.doLoad(bundle))
    this.loading.set(bundle.name, next)
    return next
  }

  unload(name: string): void {
    const p = this.plugins.get(name)
    if (!p) return
    for (const d of p.disposers.reverse()) {
      try {
        d()
      } catch (error) {
        reportError(`plugin ${name} cleanup`, error)
      }
    }
    this.plugins.delete(name)
    this.changed()
  }

  async callTool(plugin: string, tool: string, args: unknown): Promise<unknown> {
    const p = this.plugins.get(plugin)
    const def = p?.tools.get(tool)
    if (!p || !def) throw new Error(`plugin ${plugin} has no tool ${tool} in this window`)
    const parsed = def.input.safeParse(args ?? {})
    if (!parsed.success) throw new Error(`invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
    return withTimeout(Promise.resolve(def.run(parsed.data, { plugin })), TOOL_TIMEOUT_MS, `${plugin}.${tool}`)
  }

  private async doLoad(bundle: PluginBundle): Promise<void> {
    const existing = this.plugins.get(bundle.name)
    if (existing && existing.hash === bundle.hash) {
      existing.preview = bundle.preview
      this.changed()
      return
    }
    let module: PluginModule
    const url = URL.createObjectURL(new Blob([bundle.code], { type: 'text/javascript' }))
    try {
      const imported = (await import(/* @vite-ignore */ url)) as { default?: PluginModule }
      if (!imported.default || typeof imported.default.setup !== 'function') throw new Error('the plugin must `export default definePlugin({ setup(api) { ... } })`')
      module = imported.default
    } catch (error) {
      this.reportLoad(bundle.name, false, errorText(error))
      return
    } finally {
      URL.revokeObjectURL(url)
    }

    this.unload(bundle.name)
    const loaded = this.createPlugin(bundle)
    this.plugins.set(bundle.name, loaded)
    try {
      const cleanup = await module.setup(loaded.api)
      if (typeof cleanup === 'function') loaded.disposers.push(cleanup)
    } catch (error) {
      this.unload(bundle.name)
      this.reportLoad(bundle.name, false, `setup failed: ${errorText(error)}`)
      return
    }
    if (this.role === 'control') {
      sidecar.send({
        type: 'register_tools',
        plugin: bundle.name,
        tools: [...loaded.tools.values()].map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: z.toJSONSchema(t.input, { target: 'draft-7' }) as Record<string, unknown>,
          requiresApproval: t.requiresApproval,
        })),
      })
    }
    this.reportLoad(bundle.name, true)
    this.changed()
  }

  private reportLoad(plugin: string, ok: boolean, error?: string): void {
    if (!ok) reportError(`plugin ${plugin}`, error)
    if (this.role === 'control') sidecar.send({ type: 'plugin_loaded', plugin, ok, error })
  }

  private createPlugin(bundle: PluginBundle): LoadedPlugin {
    const name = bundle.name
    const scene = createSceneApi(name)
    const loaded: LoadedPlugin = { name, hash: bundle.hash, preview: bundle.preview, api: null as unknown as PluginApi, shapes: [], panels: [], tools: new Map(), disposers: [scene.dispose] }
    const track = (off: () => void): (() => void) => {
      loaded.disposers.push(off)
      return off
    }
    const busApi = {
      subscribe: <T>(topic: string, listener: (m: { topic: string; t: number; data: T }) => void) => track(bus.subscribe<T>(topic, listener)),
      publish: <T>(topic: string, data: T, t: number = Date.now() / 1000) => {
        bus.publish(topic, data, t)
        if (this.role === 'control') sidecar.send({ type: 'publish', topic, t, data })
      },
      latest: bus.latest.bind(bus),
      history: bus.history.bind(bus),
      topics: bus.topics.bind(bus),
    }
    const api: PluginApi = {
      name,
      role: this.role,
      registerShape: (util) => {
        loaded.shapes.push(util)
        this.changed()
      },
      registerPanel: (panel) => {
        loaded.panels.push({ ...panel, plugin: name })
        this.changed()
      },
      registerTool: (tool) => {
        if (!/^[a-z][a-z0-9_]{0,40}$/.test(tool.name)) throw new Error(`tool name "${tool.name}" must be snake_case`)
        loaded.tools.set(tool.name, tool as unknown as ToolDefinition)
      },
      subscribe: busApi.subscribe,
      publish: busApi.publish,
      bus: busApi,
      canvas: canvasApi,
      scene: scene.api,
      panels: {
        open: async (panel, props = {}, options) => {
          if (!loaded.panels.some((p) => p.id === panel)) throw new Error(`${name} has no panel ${panel}`)
          const id = `${name}:${panel}:${randomId()}`
          sidecar.send({ type: 'panel_open', panel: { id, panel, plugin: name, props, anchorPart: options?.anchorPart } })
          return id
        },
        close: async (instanceId) => sidecar.send({ type: 'panel_close', id: instanceId }),
      },
      board: {
        get name() {
          return sidecar.getState().board?.name ?? null
        },
        config: () => sidecar.getState().board?.config[name] ?? {},
        data: {
          list: async () => (sidecar.getState().board?.files ?? []).filter((f) => f.status !== 'missing').map((f) => ({ path: f.path, size: f.size })),
          url: (path) => boardDataUrl(path),
        },
      },
      design: { ...design, theme: () => this.theme() },
      motion: motionTokens,
      callTool: (toolName, args = {}) => sidecar.callTool(toolName, args),
      ui: coreUi,
      log: (message, ...rest) => devLog(name, [message, ...rest.map(errorText)].join(' ')),
    }
    loaded.api = api
    return loaded
  }

  private changed(): void {
    this.version += 1
    for (const l of this.listeners) l()
  }
}
