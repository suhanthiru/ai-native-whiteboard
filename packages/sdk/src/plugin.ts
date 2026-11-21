/**
 * The plugin contract. Plugins touch the core ONLY through these interfaces.
 * If a plugin needs something that is not here, the core API is missing a
 * feature: ask for a core change instead of reaching around it.
 */
import type { z } from 'zod'
import type { BusListener, BusMessage, Unsubscribe } from './bus'
import type { Design, Theme } from './design'
import type { MotionTokens } from './motion'

export type Vec3 = [number, number, number]

/* ------------------------------------------------------------------ tools */

export interface ToolContext {
  /** The plugin calling, for logging. */
  plugin: string
  signal?: AbortSignal
}

export interface ToolDefinition<S extends z.ZodType = z.ZodType> {
  /** snake_case, unique within the plugin. Claude sees plugin_<plugin>_<name>. */
  name: string
  description: string
  input: S
  /** Anything that moves hardware MUST set this. The user confirms every call. */
  requiresApproval?: boolean
  run: (args: z.infer<S>, ctx: ToolContext) => unknown | Promise<unknown>
}

/* ------------------------------------------------------------------ canvas */

export interface CanvasShapeInput {
  type: string
  x?: number
  y?: number
  props?: Record<string, unknown>
}

export interface CanvasApi {
  /** The live tldraw Editor. Prefer the helpers below; use this for anything else. */
  readonly editor: unknown
  /** Creates a shape (centred in the viewport when x/y are omitted). Returns its id. */
  createShape(shape: CanvasShapeInput): string
  updateShape(id: string, props: Record<string, unknown>): void
  deleteShape(id: string): void
  /** Centre of the current viewport in page coordinates. */
  viewportCenter(): { x: number; y: number }
  zoomTo(id: string): void
}

/* ------------------------------------------------------------------ scene */

export interface PartHandle {
  readonly name: string
  /** The THREE.Object3D for this part. */
  readonly object: unknown
  /** World-space centre of the part's bounding box. */
  center(): Vec3
  /** Size of the part's bounding box. */
  size(): Vec3
  /** Rotate around a local axis, relative to the part's rest pose (radians). */
  setRotation(axis: 'x' | 'y' | 'z', radians: number): void
  /** Absolute orientation relative to rest pose, quaternion [x, y, z, w]. */
  setQuaternion(q: [number, number, number, number]): void
  resetPose(): void
}

export interface SceneObjectOptions {
  /** Attach to a part so the object moves with it (explode, IMU tilt). */
  attachTo?: string
}

export interface SceneApi {
  /** THREE namespace shared by the core, so plugins never bundle their own copy. */
  readonly three: unknown
  /** Add a THREE.Object3D to the scene. Re-adding the same id replaces it. */
  addObject(id: string, object: unknown, options?: SceneObjectOptions): void
  removeObject(id: string): void
  part(name: string): PartHandle | null
  /** The whole model (e.g. to tilt it from an IMU). Null when no model is loaded. */
  root(): PartHandle | null
  parts(): string[]
  /** Called whenever a model loads or unloads. */
  onModelChange(listener: (parts: string[]) => void): Unsubscribe
  /** Ask for a re-render (the scene renders on demand). */
  invalidate(): void
  /** Register a per-frame callback (dt in seconds) while the plugin is loaded. */
  onFrame(callback: (dt: number) => void): Unsubscribe
}

/* ------------------------------------------------------------------ panels */

export interface PanelProps<P = Record<string, unknown>> {
  api: PluginApi
  props: P
  close: () => void
}

export interface PanelDefinition {
  id: string
  title: string
  /** A React component: (props: PanelProps) => ReactNode */
  component: (props: PanelProps<any>) => unknown
  /** Default size in px. */
  width?: number
  height?: number
}

export interface PanelsApi {
  open(panel: string, props?: Record<string, unknown>, options?: { anchorPart?: string }): Promise<string>
  close(instanceId: string): Promise<void>
}

/* ------------------------------------------------------------------ board */

export interface DataFileInfo {
  path: string
  size: number
}

export interface FrontendBoardApi {
  readonly name: string | null
  config(): Record<string, unknown>
  data: {
    list(): Promise<DataFileInfo[]>
    /** URL the frontend can fetch the file from. Only files inside the board's data/. */
    url(path: string): string
  }
}

/* ------------------------------------------------------------------ bus */

export interface BusApi {
  subscribe<T = unknown>(topic: string, listener: BusListener<T>): Unsubscribe
  publish<T>(topic: string, data: T, t?: number): void
  latest<T = unknown>(topic: string): BusMessage<T> | undefined
  history<T = unknown>(topic: string, n?: number): BusMessage<T>[]
  topics(): string[]
}

/* ------------------------------------------------------------------ plugin */

export interface PluginApi {
  readonly name: string
  readonly role: 'control' | 'output'
  registerShape(shapeUtil: unknown): void
  registerPanel(panel: PanelDefinition): void
  /** Frontend tools run in the control window only; registering in the output window is a no-op. */
  registerTool<S extends z.ZodType>(tool: ToolDefinition<S>): void
  subscribe: BusApi['subscribe']
  publish: BusApi['publish']
  bus: BusApi
  canvas: CanvasApi
  scene: SceneApi
  panels: PanelsApi
  board: FrontendBoardApi
  design: Design & { theme(): Theme }
  motion: MotionTokens
  /** Call any tool by its MCP name (e.g. "plugin_mcap_playback_play"). Resolves with the tool's text. */
  callTool(name: string, args?: Record<string, unknown>): Promise<string>
  /** Core React and UI building blocks (GlassPanel, Motion components, hooks). */
  ui: CoreUi
  log(message: string, ...rest: unknown[]): void
}

/** Core UI exported to plugins. Typed loosely so the SDK has no React dependency. */
export interface CoreUi {
  GlassPanel: unknown
  Text: unknown
  Enter: unknown
  Reveal: unknown
  useTheme: unknown
  useBusLatest: unknown
}

export interface PluginModule {
  setup(api: PluginApi): void | (() => void) | Promise<void | (() => void)>
}

export function definePlugin(module: PluginModule): PluginModule {
  return module
}

/* ------------------------------------------------------------------ backend adapters */

/** Random-access reader for big files (MCAP, point clouds). */
export interface ReadableFile {
  size(): Promise<bigint>
  read(offset: bigint, length: bigint): Promise<Uint8Array>
  close(): Promise<void>
}

export interface AdapterToolDefinition {
  name: string
  description: string
  /** JSON Schema for the input (adapters run outside the app, so no zod objects cross over). */
  inputSchema: Record<string, unknown>
  requiresApproval?: boolean
  run: (args: Record<string, unknown>) => unknown | Promise<unknown>
}

export interface AdapterApi {
  readonly plugin: string
  board: {
    readonly name: string
    data: {
      list(): Promise<DataFileInfo[]>
      /** Read a whole file. Paths are relative to the board's data/. */
      read(path: string): Promise<Uint8Array>
      open(path: string): Promise<ReadableFile>
    }
  }
  config: Record<string, unknown>
  publish(topic: string, data: unknown, t?: number): void
  /** Publish a binary payload (e.g. Float32Array points) without JSON encoding. */
  publishBinary(topic: string, payload: Uint8Array, t: number, meta?: Record<string, unknown>): void
  registerTool(tool: AdapterToolDefinition): void
  log(message: string, ...rest: unknown[]): void
}

export interface AdapterModule {
  start(api: AdapterApi): void | Promise<void>
  stop?(): void | Promise<void>
}

export function defineAdapter(module: AdapterModule): AdapterModule {
  return module
}
