/**
 * Test helpers for plugins. `createTestApi()` gives a PluginApi whose
 * registrations are recorded so a plugin test can call its tools and render
 * its shapes without the app running.
 */
import { DataBus } from './bus'
import { design, themes } from './design'
import { motionTokens } from './motion'
import type { CanvasShapeInput, PanelDefinition, PartHandle, PluginApi, PluginModule, ToolDefinition } from './plugin'

export interface TestShape extends CanvasShapeInput {
  id: string
}

export interface TestApi extends PluginApi {
  readonly recorded: {
    shapes: unknown[]
    panels: PanelDefinition[]
    tools: ToolDefinition[]
    canvasShapes: TestShape[]
    openedPanels: { panel: string; props: Record<string, unknown>; anchorPart?: string }[]
    toolCalls: { name: string; args: Record<string, unknown> }[]
    sceneObjects: Map<string, unknown>
    logs: string[]
  }
  /** Run a registered tool the way the core would: validate input, then call run. */
  runTool(name: string, args: unknown): Promise<unknown>
  tool(name: string): ToolDefinition
}

export interface TestApiOptions {
  name?: string
  role?: 'control' | 'output'
  parts?: Record<string, PartHandle>
  three?: unknown
  boardConfig?: Record<string, unknown>
}

export function createTestApi(options: TestApiOptions = {}): TestApi {
  const name = options.name ?? 'test-plugin'
  const bus = new DataBus({ historySize: 500 })
  const parts = options.parts ?? {}
  let nextId = 1
  const recorded: TestApi['recorded'] = {
    shapes: [],
    panels: [],
    tools: [],
    canvasShapes: [],
    openedPanels: [],
    sceneObjects: new Map(),
    logs: [],
    toolCalls: [],
  }

  const api: TestApi = {
    name,
    role: options.role ?? 'control',
    recorded,
    registerShape: (util) => void recorded.shapes.push(util),
    registerPanel: (panel) => void recorded.panels.push(panel),
    registerTool: (tool) => void recorded.tools.push(tool as unknown as ToolDefinition),
    subscribe: (topic, listener) => bus.subscribe(topic, listener),
    publish: (topic, data, t) => bus.publish(topic, data, t),
    bus,
    canvas: {
      editor: null,
      createShape: (shape) => {
        const id = `shape:test-${nextId++}`
        recorded.canvasShapes.push({ ...shape, id })
        return id
      },
      updateShape: (id, props) => {
        const index = recorded.canvasShapes.findIndex((s) => s.id === id)
        const existing = recorded.canvasShapes[index]
        if (existing) recorded.canvasShapes[index] = { ...existing, props: { ...existing.props, ...props } }
      },
      deleteShape: (id) => {
        const index = recorded.canvasShapes.findIndex((s) => s.id === id)
        if (index >= 0) recorded.canvasShapes.splice(index, 1)
      },
      viewportCenter: () => ({ x: 0, y: 0 }),
      zoomTo: () => undefined,
    },
    scene: {
      three: options.three ?? null,
      addObject: (id, object) => void recorded.sceneObjects.set(id, object),
      removeObject: (id) => void recorded.sceneObjects.delete(id),
      part: (partName) => parts[partName] ?? null,
      root: () => parts.__root__ ?? null,
      parts: () => Object.keys(parts),
      onModelChange: () => () => undefined,
      invalidate: () => undefined,
      onFrame: () => () => undefined,
    },
    panels: {
      open: async (panel, props = {}, opts) => {
        recorded.openedPanels.push({ panel, props, anchorPart: opts?.anchorPart })
        return `panel-${recorded.openedPanels.length}`
      },
      close: async () => undefined,
    },
    board: {
      name: 'test-board',
      config: () => options.boardConfig ?? {},
      data: { list: async () => [], url: (path) => `http://test/board-data/${path}` },
    },
    design: { ...design, theme: () => themes.glass },
    motion: motionTokens,
    ui: { GlassPanel: null, Text: null, Enter: null, Reveal: null, useTheme: null, useBusLatest: null },
    log: (message) => void recorded.logs.push(message),
    callTool: async (toolName, args = {}) => {
      recorded.toolCalls.push({ name: toolName, args })
      return 'ok'
    },
    tool(toolName) {
      const tool = recorded.tools.find((t) => t.name === toolName)
      if (!tool) throw new Error(`tool ${toolName} was not registered`)
      return tool
    },
    async runTool(toolName, args) {
      const tool = api.tool(toolName)
      const parsed = tool.input.parse(args)
      return tool.run(parsed, { plugin: name })
    },
  }
  return api
}

export async function setupForTest(module: PluginModule, options?: TestApiOptions): Promise<TestApi> {
  const api = createTestApi(options)
  await module.setup(api)
  return api
}
