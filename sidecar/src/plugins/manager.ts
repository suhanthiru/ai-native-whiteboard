import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'
import chokidar, { type FSWatcher } from 'chokidar'
import { pluginToolName, type PluginBundle, type PluginInfo, type PluginState, type ToolDescriptor } from '@wb/sdk'
import { AdapterProcess, ensureNetGuard, RUNTIME_ENTRY } from '../adapters/host'
import type { AdapterToolInfo } from '../adapters/protocol'
import type { Approvals } from '../approvals'
import type { BoardService } from '../boards/service'
import { checkRequirements } from '../boards/requirements'
import type { Hub } from '../hub'
import type { StateStore } from '../state/store'
import type { RegisteredTool, ToolRegistry } from '../tools/registry'
import { errorMessage, logger } from '../log'
import { ApprovedStore } from './approvedStore'
import { bundleAdapter, bundleFrontend } from './bundler'
import { formatProblems, lintPlugin } from './designLint'
import { discoverPlugins, hashPluginDir, type PluginSource } from './discover'
import { runPluginTest } from './testRunner'

const log = logger('plugins')
const WATCH_DEBOUNCE_MS = 350
const FRONTEND_TOOL_TIMEOUT_MS = 30_000
const NPM_TIMEOUT_MS = 5 * 60_000
export const AWAITING_KEEP = 'passed the design lint; waiting for you to click Keep. None of its code runs before that: its test runs after you approve, and it loads only if the test passes.'

interface PluginRecord {
  src: PluginSource
  hash: string
  state: PluginState
  message?: string
  bundle?: PluginBundle
  adapter?: AdapterProcess
  rejectedHash?: string
  /** Passed the lint; its Keep card is showing and none of its code has run. */
  awaitingKeep?: boolean
}

export interface PluginManagerDeps {
  rootDir: string
  sharedDir: string
  runtimeDir: string
  hub: Hub
  store: StateStore
  boards: BoardService
  tools: ToolRegistry
  approvals: Approvals
  onBusPublish: (topic: string, data: unknown, t: number) => void
  onBusBinary: (topic: string, payload: Uint8Array, t: number, meta: Record<string, unknown>) => void
  /** Skip lint+test+approval (used by tests of the manager itself). */
  trustAll?: boolean
  /** URL of a plugin's recorded preview, if it has one (skill viewer). */
  previewUrlFor?: (name: string, dir: string) => string | undefined
}

export function npmInstall(dir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const child = spawn(npm, ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--omit=dev'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' })
    let output = ''
    child.stdout.on('data', (d: Buffer) => (output += d.toString()))
    child.stderr.on('data', (d: Buffer) => (output += d.toString()))
    const timer = setTimeout(() => child.kill(), NPM_TIMEOUT_MS)
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`npm install failed (${code}): ${output.slice(-600)}`))
    })
    child.on('error', reject)
  })
}

/** Manifest entry files must stay inside the plugin folder. */
export function insidePlugin(dir: string, entry: string): string {
  const full = resolve(dir, entry)
  const rel = relative(dir, full)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`manifest entry "${entry}" must be a file inside the plugin folder`)
  return full
}

/** Plugin tools may return a string, or an object with an optional `text` field plus data. */
export function toolResultFrom(name: string, result: unknown): { text: string; data?: unknown } {
  if (typeof result === 'string') return { text: result }
  if (result && typeof result === 'object' && typeof (result as { text?: unknown }).text === 'string') {
    const { text, ...rest } = result as { text: string } & Record<string, unknown>
    return { text, data: Object.keys(rest).length ? rest : undefined }
  }
  return { text: `${name} done.`, data: result ?? undefined }
}

async function dependenciesOf(dir: string): Promise<string[]> {
  const file = join(dir, 'package.json')
  if (!existsSync(file)) return []
  const pkg = JSON.parse(await readFile(file, 'utf8')) as { dependencies?: Record<string, string> }
  return Object.entries(pkg.dependencies ?? {}).map(([n, v]) => `${n}@${v}`)
}

/**
 * Discovers, checks, bundles and hot-loads plugins. A plugin that is new or
 * changed must pass its design lint and test, then the user keeps it once.
 */
export class PluginManager {
  private readonly records = new Map<string, PluginRecord>()
  private readonly approvedStore = new ApprovedStore()
  private readonly queues = new Map<string, Promise<void>>()
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private watcher: FSWatcher | null = null
  /** Bumped on every (re)load of a plugin, so a late answer to an old Keep card is ignored. */
  private readonly attempts = new Map<string, number>()
  private watching: Promise<void> = Promise.resolve()
  /** Plugins a skill tool is writing or installing; file events for them are ignored until refresh(). */
  private readonly held = new Set<string>()
  private netGuard = ''

  constructor(private readonly deps: PluginManagerDeps) {
    deps.hub.onReady((client) => {
      for (const r of this.records.values()) if (r.bundle) client.send({ type: 'plugin_bundle', bundle: r.bundle })
    })
    deps.hub.on('register_tools', (m) => this.registerFrontendTools(m.plugin, m.tools))
    deps.hub.on('plugin_loaded', (m) => {
      const r = this.records.get(m.plugin)
      if (r && !m.ok) this.setState(r, 'error', `frontend failed to load: ${m.error ?? 'unknown error'}`)
    })
  }

  infos(): PluginInfo[] {
    return [...this.records.values()].map((r) => ({
      name: r.src.name,
      version: r.src.manifest?.version ?? '0.0.0',
      description: r.src.manifest?.description ?? r.message ?? '',
      source: r.src.source,
      state: r.state,
      message: r.message,
      tools: this.toolsOf(r.src.name),
      hash: r.hash,
      skill: r.src.manifest?.skill,
      previewUrl: this.deps.previewUrlFor?.(r.src.name, r.src.dir),
      updatedAt: r.src.updatedAt,
    }))
  }

  /** Folder of a known plugin (shared or board), or null. */
  pluginDir(name: string): string | null {
    return this.records.get(name)?.src.dir ?? null
  }

  /** Push plugin infos to the windows again (e.g. a preview was recorded). */
  notifyChanged(): void {
    this.publishInfos()
  }

  async start(): Promise<void> {
    this.netGuard = await ensureNetGuard(this.deps.runtimeDir)
    await this.reloadAll()
  }

  /** Rediscover everything (called when a board opens). */
  async reloadAll(): Promise<void> {
    // Let in-flight loads finish first so none of them leaves an orphaned adapter behind.
    await Promise.allSettled([...this.queues.values()])
    for (const name of [...this.records.keys()]) {
      this.attempts.set(name, (this.attempts.get(name) ?? 0) + 1)
      this.deps.approvals.cancelFor(name)
      await this.unload(name)
    }
    this.records.clear()
    const sources = await discoverPlugins(this.deps.sharedDir, this.deps.boards.boardPluginsDir())
    await Promise.all(sources.map((s) => this.enqueue(s.name, () => this.process(s))))
    this.publishInfos()
    await this.watch()
  }

  /** Folders plugins are discovered in: shared, and the open board's (if any). */
  pluginDirs(): { shared: string; board: string | null } {
    return { shared: this.deps.sharedDir, board: this.deps.boards.boardPluginsDir() }
  }

  /**
   * Re-run discovery, lint, test and load for one plugin now (after its files
   * were written) and return where it ended up. Also starts watching a plugin
   * folder that did not exist before.
   */
  async refresh(name: string): Promise<PluginInfo | undefined> {
    this.held.delete(name)
    await this.watch()
    await this.rediscover(name)
    await this.queues.get(name)
    return this.infos().find((p) => p.name === name)
  }

  /**
   * Stop reacting to file events for a plugin while its files are written and
   * its packages installed, so the watcher does not run a second install or
   * test a half-written folder. refresh() or the returned release ends it.
   */
  hold(name: string): () => void {
    this.held.add(name)
    const pending = this.timers.get(name)
    if (pending) clearTimeout(pending)
    this.timers.delete(name)
    return () => void this.held.delete(name)
  }

  /** Data in the board changed: re-check requirements of every plugin. */
  async recheckData(): Promise<void> {
    await Promise.all([...this.records.values()].map((r) => this.enqueue(r.src.name, () => this.process(r.src))))
  }

  async stop(): Promise<void> {
    await this.watcher?.close()
    for (const t of this.timers.values()) clearTimeout(t)
    for (const r of this.records.values()) await r.adapter?.stop()
  }

  private toolsOf(name: string): string[] {
    const t = this.deps.tools
    return [...t.ownedBy(name), ...t.ownedBy(`${name}#backend`), ...t.ownedBy(`${name}#stub`)]
  }

  private enqueue(name: string, job: () => Promise<void>): Promise<void> {
    const prev = this.queues.get(name) ?? Promise.resolve()
    const next = prev
      .then(job)
      .catch((error: unknown) => log.error(`plugin ${name}`, error))
      .finally(() => this.publishInfos())
    this.queues.set(name, next)
    return next
  }

  /** (Re)create the watcher. Serialised so overlapping calls never leak a watcher. */
  private watch(): Promise<void> {
    this.watching = this.watching.then(() => this.rewatch()).catch((error: unknown) => log.error('plugin watcher', error))
    return this.watching
  }

  private async rewatch(): Promise<void> {
    await this.watcher?.close()
    this.watcher = null
    const dirs = [this.deps.sharedDir, this.deps.boards.boardPluginsDir()].filter((d): d is string => !!d && existsSync(d))
    if (!dirs.length) return
    this.watcher = chokidar.watch(dirs, {
      ignoreInitial: true,
      // Recorded previews are media, not code: writing one must not reload the plugin.
      ignored: (p: string) =>
        /[\\/](node_modules|\.build|coverage|test-results)([\\/]|$)/i.test(p) || p.toLowerCase().endsWith('approved.json') || /[\\/](preview\.(webm|mp4|png)|\.preview-[^\\/]*\.tmp)$/i.test(p),
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    })
    this.watcher.on('all', (_event, path) => {
      const root = dirs.find((d) => path.startsWith(d + sep))
      if (!root) return
      const name = relative(root, path).split(sep)[0]
      if (!name || name.startsWith('.') || this.held.has(name)) return
      const pending = this.timers.get(name)
      if (pending) clearTimeout(pending)
      this.timers.set(
        name,
        setTimeout(() => {
          this.timers.delete(name)
          if (!this.held.has(name)) void this.rediscover(name)
        }, WATCH_DEBOUNCE_MS),
      )
    })
  }

  private async rediscover(name: string): Promise<void> {
    const sources = await discoverPlugins(this.deps.sharedDir, this.deps.boards.boardPluginsDir())
    const src = sources.find((s) => s.name === name)
    if (!src) {
      await this.enqueue(name, async () => {
        await this.unload(name)
        this.records.delete(name)
        this.deps.approvals.cancelFor(name)
      })
      return
    }
    log.info(`plugin ${name} changed; reloading`)
    await this.enqueue(name, () => this.process(src))
  }

  private record(src: PluginSource, hash: string): PluginRecord {
    const existing = this.records.get(src.name)
    const r: PluginRecord = existing ? { ...existing, src, hash } : { src, hash, state: 'pending' }
    this.records.set(src.name, r)
    return r
  }

  private setState(r: PluginRecord, state: PluginState, message?: string): void {
    r.state = state
    r.message = message
    this.publishInfos()
  }

  private pluginsDirOf(src: PluginSource): string {
    return dirname(src.dir)
  }

  private async process(src: PluginSource): Promise<void> {
    const hash = src.manifest ? await hashPluginDir(src.dir) : 'invalid'
    const previous = this.records.get(src.name)
    if (previous?.awaitingKeep && previous.hash === hash) return // its Keep card is already up
    const r = this.record(src, hash)
    if (previous?.awaitingKeep) {
      r.awaitingKeep = false
      this.deps.approvals.cancelFor(src.name)
    }
    const attempt = (this.attempts.get(src.name) ?? 0) + 1
    this.attempts.set(src.name, attempt)
    const manifest = src.manifest
    if (!manifest) {
      await this.unload(src.name)
      return this.setState(r, 'error', src.error)
    }
    try {
      for (const entry of [manifest.frontend, manifest.backend, manifest.test]) if (entry) insidePlugin(src.dir, entry)
    } catch (error) {
      await this.unload(src.name)
      return this.setState(r, 'error', errorMessage(error))
    }
    const enabled = this.deps.boards.enabledPlugins()
    if (enabled.length && !enabled.includes(manifest.name)) {
      await this.unload(src.name)
      return this.setState(r, 'disabled', 'not enabled on this board (board.json enabledPlugins)')
    }
    if (r.rejectedHash === hash) return this.setState(r, 'disabled', 'discarded; edit the plugin to try again')

    const board = this.deps.boards.open
    const reqs = await checkRequirements(manifest.requires, board?.data ?? null, board?.files ?? [])
    if (!reqs.met) {
      await this.unload(src.name)
      this.registerStubTools(manifest.name, manifest.adds.tools, reqs.message ?? 'required data is missing')
      return this.setState(r, 'disabled', reqs.message)
    }
    this.deps.tools.removeOwner(`${manifest.name}#stub`)

    const approved = this.deps.trustAll || (await this.approvedStore.isApproved(this.pluginsDirOf(src), manifest.name, hash))
    if (approved) {
      this.setState(r, 'pending', 'loading')
      try {
        await this.installIfMissing(r)
        await this.load(r, false)
      } catch (error) {
        await this.unload(src.name)
        return this.setState(r, 'error', errorMessage(error))
      }
      return this.setState(r, 'active')
    }

    // New or changed plugin: only static checks now. None of its code (UI, backend
    // or test) runs until the user clicks Keep.
    await this.unload(src.name)
    const exempt = [manifest.test, ...(manifest.backend ? [manifest.backend] : [])]
    const problems = await lintPlugin(src.dir, exempt)
    if (problems.length) return this.setState(r, 'error', `design lint failed:\n${formatProblems(problems)}`)
    r.awaitingKeep = true
    this.setState(r, 'pending', AWAITING_KEEP)
    // Not awaited: the queue stays free so an edit while waiting re-checks immediately.
    void this.askToKeep(r, hash, attempt).catch((error: unknown) => log.error(`approval for ${src.name}`, error))
  }

  /** Approved plugins get their npm dependencies installed (install scripts off) when missing. */
  private async installIfMissing(r: PluginRecord): Promise<void> {
    const deps = await dependenciesOf(r.src.dir)
    if (!deps.length || existsSync(join(r.src.dir, 'node_modules'))) return
    this.setState(r, 'pending', `installing ${deps.join(', ')}`)
    await npmInstall(r.src.dir)
  }

  private isCurrent(name: string, hash: string, attempt: number): PluginRecord | null {
    const current = this.records.get(name)
    return current && current.hash === hash && this.attempts.get(name) === attempt ? current : null
  }

  private async askToKeep(r: PluginRecord, hash: string, attempt: number): Promise<void> {
    const manifest = r.src.manifest
    if (!manifest) return
    const src = r.src
    const deps = await dependenciesOf(src.dir)
    const adds = [...manifest.adds.shapes.map((s) => `shape ${s}`), ...manifest.adds.panels.map((p) => `panel ${p}`), ...manifest.adds.tools.map((t) => `tool ${t}`), ...manifest.adds.dataSources.map((d) => `data source ${d}`)]
    const steps = [deps.length && !existsSync(join(src.dir, 'node_modules')) ? `installs ${deps.join(', ')} (install scripts off)` : '', 'runs its test', 'loads it only if the test passes'].filter(Boolean)
    const keep = await this.deps.approvals.request({
      kind: 'plugin',
      title: `Keep plugin "${manifest.name}"?`,
      detail: `${manifest.description}\nAdds: ${adds.join(', ') || 'nothing declared'}\nIt passed the design lint. None of its code has run yet. Keeping it ${steps.join(', ')}.`,
      plugin: manifest.name,
    })
    const current = this.isCurrent(manifest.name, hash, attempt)
    if (!current || !current.awaitingKeep) return // edited, reloaded or removed while the card was up
    current.awaitingKeep = false
    if (!keep) {
      current.rejectedHash = hash
      return this.setState(current, 'disabled', 'discarded; edit the plugin to try again')
    }
    await this.enqueue(manifest.name, async () => {
      const still = this.isCurrent(manifest.name, hash, attempt)
      if (!still) return
      try {
        await this.installIfMissing(still)
        this.setState(still, 'pending', 'running its test')
        const test = await runPluginTest(this.deps.rootDir, src.dir, manifest.test)
        if (!test.passed) return this.setState(still, 'error', `test failed (not kept):\n${test.output}`)
        if (!this.isCurrent(manifest.name, hash, attempt)) return
        await this.approvedStore.approve(this.pluginsDirOf(src), manifest.name, hash)
        await this.load(still, false)
        this.setState(still, 'active')
      } catch (error) {
        await this.unload(manifest.name)
        this.setState(still, 'error', errorMessage(error))
      }
    })
  }

  private async load(r: PluginRecord, preview: boolean): Promise<void> {
    const manifest = r.src.manifest
    if (!manifest) return
    for (const entry of [manifest.frontend, manifest.backend, manifest.test]) if (entry) insidePlugin(r.src.dir, entry)
    await r.adapter?.stop()
    r.adapter = undefined
    const code = existsSync(join(r.src.dir, manifest.frontend)) ? await bundleFrontend(r.src.dir, manifest.frontend) : ''
    r.bundle = code ? { name: manifest.name, hash: r.hash, code, source: r.src.source, preview } : undefined
    if (r.bundle) this.deps.hub.broadcast({ type: 'plugin_bundle', bundle: r.bundle })
    if (manifest.backend) await this.startAdapter(r)
  }

  private async startAdapter(r: PluginRecord): Promise<void> {
    const manifest = r.src.manifest
    const board = this.deps.boards.open
    if (!manifest?.backend || !board) return
    const bundle = await bundleAdapter(r.src.dir, manifest.backend, RUNTIME_ENTRY)
    const name = manifest.name
    const adapter = new AdapterProcess(
      {
        plugin: name,
        bundle,
        boardName: board.entry.file.name,
        dataDir: board.data.dataDir,
        config: this.deps.boards.pluginConfig(name),
        network: manifest.permissions.network,
        netGuard: this.netGuard,
      },
      {
        onPublish: (topic, data, t) => this.deps.onBusPublish(topic, data, t),
        onPublishBinary: (topic, payload, t, meta) => this.deps.onBusBinary(topic, payload, t, meta),
        onTools: (tools) => this.registerAdapterTools(name, tools, adapter),
        onExit: (reason) => {
          const current = this.records.get(name)
          if (current?.adapter === adapter) {
            current.adapter = undefined
            this.deps.tools.removeOwner(`${name}#backend`)
            if (current.state === 'active' || current.state === 'preview') this.setState(current, 'error', `data source ${reason}`)
          }
        },
      },
    )
    r.adapter = adapter
    await adapter.start()
  }

  private async unload(name: string): Promise<void> {
    const r = this.records.get(name)
    if (r?.adapter) {
      const a = r.adapter
      r.adapter = undefined
      await a.stop()
    }
    if (r) r.bundle = undefined
    this.deps.tools.removeOwner(name)
    this.deps.tools.removeOwner(`${name}#backend`)
    this.deps.hub.broadcast({ type: 'plugin_unload', name })
  }

  private registerFrontendTools(plugin: string, tools: ToolDescriptor[]): void {
    const r = this.records.get(plugin)
    if (!r || (r.state !== 'active' && r.state !== 'preview' && r.state !== 'pending')) return
    const registered: RegisteredTool[] = tools.map((t) => ({
      name: pluginToolName(plugin, t.name),
      description: t.description,
      inputSchema: t.inputSchema,
      requiresApproval: t.requiresApproval,
      owner: plugin,
      handler: async (args) => {
        const result = await this.deps.hub.rpc('plugin.tool', { plugin, tool: t.name, args }, FRONTEND_TOOL_TIMEOUT_MS)
        return toolResultFrom(t.name, result)
      },
    }))
    this.deps.tools.replaceOwner(plugin, registered)
    this.publishInfos()
  }

  private registerAdapterTools(plugin: string, tools: AdapterToolInfo[], adapter: AdapterProcess): void {
    const registered: RegisteredTool[] = tools.map((t) => ({
      name: pluginToolName(plugin, t.name),
      description: t.description,
      inputSchema: t.inputSchema,
      requiresApproval: t.requiresApproval,
      owner: `${plugin}#backend`,
      handler: async (args) => {
        const result = await adapter.callTool(t.name, args)
        return toolResultFrom(t.name, result)
      },
    }))
    this.deps.tools.replaceOwner(`${plugin}#backend`, registered)
    this.publishInfos()
  }

  /** Disabled plugins keep their tools visible; calling one explains what is missing. */
  private registerStubTools(plugin: string, names: string[], reason: string): void {
    this.deps.tools.removeOwner(plugin)
    this.deps.tools.removeOwner(`${plugin}#backend`)
    this.deps.tools.replaceOwner(
      `${plugin}#stub`,
      names.map((n) => ({
        name: pluginToolName(plugin, n),
        description: `(unavailable: ${reason})`,
        inputSchema: { type: 'object', properties: {}, additionalProperties: true },
        owner: `${plugin}#stub`,
        handler: () => ({ text: `Plugin ${plugin} is disabled: ${reason}. Tell the user what is missing; do not make data up.`, isError: true }),
      })),
    )
  }

  private publishInfos(): void {
    this.deps.store.patch('plugins', this.infos())
  }
}
