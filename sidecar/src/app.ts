import { join } from 'node:path'
import { BinaryKind, encodeBinaryFrame } from '@wb/sdk'
import { Approvals } from './approvals'
import { BoardService } from './boards/service'
import { loadConfig, writeMcpConfig, type SidecarConfig } from './config'
import { loadWarp, parseWarp, saveWarp } from './outputConfig'
import { Hub } from './hub'
import { startHttp, type RunningServer } from './http'
import { errorMessage, logger } from './log'
import { McpBridge } from './mcp/server'
import { npmInstall, PluginManager } from './plugins/manager'
import { runCodeTool } from './sandbox/runCode'
import { noteTools, NotesStore } from './skills/notes'
import { previewFileIn } from './skills/previews'
import { skillTools } from './skills/skillTools'
import { StateStore } from './state/store'
import { parseCommand } from './tools/commands'
import { coreTools, ModelInfo } from './tools/coreTools'
import { ToolRegistry } from './tools/registry'
import { ClaudeCodeBrain, type Brain } from './voice/brain'
import { VoiceOrchestrator } from './voice/orchestrator'
import { bestTts, whisperStt, type SpeechToText, type TextToSpeech } from './voice/workers'

const log = logger('sidecar')
const TOPICS_THROTTLE_MS = 500

export interface SidecarOptions {
  config?: Partial<SidecarConfig>
  /** Replace the voice pieces (tests). */
  brain?: Brain
  stt?: SpeechToText
  tts?: TextToSpeech
  /** Do not write .mcp.json (tests). */
  skipMcpConfig?: boolean
  /** Skip lint/test/approval for plugins (tests of the wiring only). */
  trustPlugins?: boolean
}

export interface Sidecar {
  config: SidecarConfig
  port: number
  store: StateStore
  hub: Hub
  tools: ToolRegistry
  boards: BoardService
  plugins: PluginManager
  approvals: Approvals
  close(): Promise<void>
}

/** Topics seen on the bus, mirrored into AppState for the UI and list_topics. */
class TopicTracker {
  private readonly topics = new Set<string>()
  private timer: NodeJS.Timeout | null = null
  constructor(private readonly store: StateStore) {}
  see(topic: string): void {
    if (this.topics.has(topic)) return
    this.topics.add(topic)
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null
        this.store.patch('topics', this.list())
      }, TOPICS_THROTTLE_MS)
    }
  }
  list(): string[] {
    return [...this.topics].sort()
  }
  clear(): void {
    this.topics.clear()
    this.store.patch('topics', [])
  }
}

export async function createSidecar(options: SidecarOptions = {}): Promise<Sidecar> {
  const config = loadConfig(options.config)
  const store = new StateStore()
  store.update((s) => ({ ...s, output: { ...s.output, warp: loadWarp(config.runtimeDir) } }))
  const hub = new Hub(store)
  const approvals = new Approvals(store)
  const tools = new ToolRegistry(approvals)
  const model = new ModelInfo()
  const topics = new TopicTracker(store)
  let server: RunningServer | null = null
  const publicUrl = () => `http://${config.host}:${server?.port ?? config.port}`
  const boards = new BoardService(config.boardsDir, store, hub, publicUrl)
  const notes = new NotesStore(join(config.runtimeDir, 'memory.json'))
  const mcp = new McpBridge(tools, () => notes.promptBlock())

  const relayBus = (topic: string, data: unknown, t: number) => {
    topics.see(topic)
    hub.broadcast({ type: 'bus', topic, t, data })
  }
  const relayBinary = (topic: string, payload: Uint8Array, t: number, meta: Record<string, unknown>) => {
    topics.see(topic)
    const { dtype, ...rest } = meta
    hub.broadcastBinary(encodeBinaryFrame(BinaryKind.bus, { topic, t, dtype: dtype ?? 'u8', meta: rest }, payload))
  }

  const plugins = new PluginManager({
    rootDir: config.rootDir,
    sharedDir: config.pluginsDir,
    runtimeDir: config.runtimeDir,
    hub,
    store,
    boards,
    tools,
    approvals,
    onBusPublish: relayBus,
    onBusBinary: relayBinary,
    trustAll: options.trustPlugins,
    previewUrlFor: (name, dir) => {
      const file = previewFileIn(dir)
      return file ? `${publicUrl()}/skill-preview/${name}?v=${file.mtimeMs}&k=${file.kind}` : undefined
    },
  })
  const skillPreview = (name: string) => {
    const dir = plugins.pluginDir(name)
    return dir ? previewFileIn(dir) : null
  }

  let netGuard = ''
  for (const t of coreTools({ store, hub, boards, model, plugins: () => plugins.infos(), topics: () => topics.list() })) tools.register(t)
  tools.register(runCodeTool({ runtimeDir: () => config.runtimeDir, netGuard: () => netGuard, boards, hub }))
  const guidePath = join(config.rootDir, 'docs', 'PLUGIN_GUIDE.md')
  const previews = { client: hub, dirOf: (name: string) => plugins.pluginDir(name), onSaved: () => plugins.notifyChanged() }
  for (const t of skillTools({ host: plugins, approvals, tools, guidePath, install: npmInstall, previews })) tools.register(t)
  for (const t of noteTools(notes)) tools.register(t)

  const python = process.env.WB_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
  const voice = new VoiceOrchestrator(
    hub,
    store,
    options.stt ?? whisperStt(config.rootDir, python),
    options.tts ?? bestTts(config.rootDir, config.runtimeDir, python),
    // The brain's claude -p gets the notes through the whiteboard MCP instructions.
    options.brain ?? new ClaudeCodeBrain(config.rootDir, config.runtimeDir),
  )

  hub.on('command', async (m, client) => {
    const parsed = parseCommand(m.text)
    if (!parsed) return voice.handleText(m.text)
    const result = await tools.call(parsed.tool, parsed.args)
    client.send({ type: 'toast', level: result.isError ? 'error' : 'info', text: result.text })
  })
  hub.on('tool_call', async (m, client) => {
    const result = await tools.call(m.name, m.args)
    client.send({ type: 'tool_result', id: m.id, ok: !result.isError, text: result.text })
  })
  hub.on('model_info', (m) => model.set(m.file, m.parts))
  hub.on('approval', (m) => void approvals.settle(m.id, m.approve))
  hub.on('warp', async (m) => {
    const warp = parseWarp(m.corners)
    if (warp === undefined) return
    store.update((s) => ({ ...s, output: { ...s.output, warp } }))
    await saveWarp(config.runtimeDir, warp)
  })
  hub.on('calibrate', (m) => void store.update((s) => ({ ...s, output: { ...s.output, calibrating: m.on } })))
  hub.on('panel_open', (m) => void store.update((s) => ({ ...s, panels: [...s.panels.filter((p) => p.id !== m.panel.id), m.panel] })))
  hub.on('panel_close', (m) => void store.update((s) => ({ ...s, panels: s.panels.filter((p) => p.id !== m.id) })))
  hub.on('canvas', (m, client) => hub.broadcast({ type: 'canvas', sync: m.sync }, (c) => c !== client && c.role === 'output'))
  hub.on('publish', (m) => relayBus(m.topic, m.data, m.t))

  // A newly opened output window gets the control window's canvas in full.
  hub.onReady((client) => {
    if (client.role !== 'output' || !hub.hasRole('control')) return
    hub
      .rpc('canvas.snapshot', {})
      .then((payload) => client.send({ type: 'canvas', sync: { full: true, payload } }))
      .catch((error: unknown) => log.debug('canvas snapshot for output failed', errorMessage(error)))
  })

  boards.on('opened', () => {
    topics.clear()
    plugins.reloadAll().catch((error: unknown) => log.error('reloading plugins failed', error))
  })

  server = await startHttp({ config, hub, boards, mcp: (req, res) => mcp.handle(req, res), skillPreview })
  if (!options.skipMcpConfig && process.env.WB_NO_MCP_CONFIG !== '1') log.info(`wrote ${writeMcpConfig(config, server.port)}`)

  await plugins.start()
  netGuard = `${config.runtimeDir}/net-guard.mjs`
  await boards.refreshIndex()
  if (config.defaultBoard) {
    try {
      await boards.openBoard(config.defaultBoard)
    } catch (error) {
      log.warn(`could not open default board ${config.defaultBoard}`, errorMessage(error))
    }
  }
  void voice.probe().catch((error: unknown) => log.warn('voice probe failed', errorMessage(error)))

  const port = server.port
  return {
    config,
    port,
    store,
    hub,
    tools,
    boards,
    plugins,
    approvals,
    async close() {
      voice.stop()
      await boards.flushCanvas().catch(() => undefined)
      await plugins.stop()
      await mcp.close()
      hub.close()
      await server?.close()
    },
  }
}
