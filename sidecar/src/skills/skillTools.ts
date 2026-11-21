import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { parseManifest, pluginNameSchema, pluginToolName, type ApprovalRequest, type PluginInfo, type PluginManifest } from '@wb/sdk'
import { errorMessage } from '../log'
import { defineCoreTool, type RegisteredTool, type ToolResult } from '../tools/registry'
import { checkPluginFiles, checkPluginPath, dependenciesIn, readPluginFiles, writePluginFiles } from './pluginFiles'
import { DEFAULT_PREVIEW_SECONDS, MAX_PREVIEW_SECONDS, recordWhileRunning, type RecordingClient } from './previews'

const TOOL_WAIT_MS = 8000

/** What the skill tools need from the plugin manager. */
export interface SkillHost {
  pluginDirs(): { shared: string; board: string | null }
  /** Ignore file events for a plugin while it is written; refresh() ends the hold. */
  hold(name: string): () => void
  refresh(name: string): Promise<PluginInfo | undefined>
  infos(): PluginInfo[]
}

export interface SkillToolDeps {
  host: SkillHost
  approvals: { request(input: Omit<ApprovalRequest, 'id'>): Promise<boolean> }
  tools: { call(name: string, args: unknown): Promise<ToolResult>; onChange(listener: () => void): () => void }
  guidePath: string
  /** Installs npm dependencies in a plugin folder (scripts disabled). */
  install: (dir: string) => Promise<void>
  /** Records skill previews through the control window. Omit to never record. */
  previews?: { client: RecordingClient; dirOf(name: string): string | null; onSaved(name: string): void }
  toolWaitMs?: number
}

/** The plugin that owns an MCP tool name, from the live plugin list. */
function ownerOf(host: SkillHost, tool: string): PluginInfo | undefined {
  return host.infos().find((p) => p.tools.includes(tool))
}

/** Per-session recording state: one recording per skill at a time, and no automatic retry after a failure. */
interface PreviewState {
  recording: Set<string>
  failed: Set<string>
}

/**
 * Run a plugin tool, recording a preview of it in action when asked (or, in
 * auto mode, when the skill has none yet and no earlier attempt failed). The
 * tool result is returned either way.
 */
async function runWithPreview(deps: SkillToolDeps, state: PreviewState, tool: string, args: Record<string, unknown>, mode: 'auto' | 'always', seconds: number): Promise<ToolResult> {
  const run = () => deps.tools.call(tool, args)
  const owner = ownerOf(deps.host, tool)
  const view = owner?.skill?.preview ?? 'scene'
  const dir = owner && deps.previews?.dirOf(owner.name)
  if (!owner || !deps.previews || !dir || view === 'none') return run()
  const busy = state.recording.has(owner.name)
  const wanted = mode === 'always' || (!owner.previewUrl && !state.failed.has(owner.name))
  if (!wanted || busy) {
    const result = await run()
    return busy && mode === 'always' ? { ...result, text: `${result.text}\n(A preview of ${owner.name} is already being recorded.)` } : result
  }
  state.recording.add(owner.name)
  try {
    const recorded = await recordWhileRunning(deps.previews.client, dir, view, seconds, run)
    if (recorded.saved) {
      state.failed.delete(owner.name)
      deps.previews.onSaved(owner.name)
    } else {
      state.failed.add(owner.name)
    }
    const note = recorded.saved
      ? `Recorded a ${seconds}s preview of ${owner.name} for the skill viewer.`
      : `No preview recorded: ${recorded.problem ?? 'unknown reason'}. Retry with record_skill_preview once that is fixed.`
    return { ...recorded.result, text: `${recorded.result.text}\n(${note})` }
  } finally {
    state.recording.delete(owner.name)
  }
}

const filesSchema = z.record(z.string().min(1).max(200), z.string().max(200_000))
const manifestInput = z.record(z.string(), z.unknown())

function fail(text: string): ToolResult {
  return { text, isError: true }
}

/** Find an existing plugin folder; a board plugin overrides a shared one. */
function locate(host: SkillHost, name: string): { dir: string; scope: 'board' | 'shared' } | null {
  const { shared, board } = host.pluginDirs()
  if (board && existsSync(join(board, name, 'manifest.json'))) return { dir: join(board, name), scope: 'board' }
  if (existsSync(join(shared, name, 'manifest.json'))) return { dir: join(shared, name), scope: 'shared' }
  return null
}

function addsSummary(m: PluginManifest): string {
  const parts = [...m.adds.tools.map((t) => `tool ${t}`), ...m.adds.shapes.map((s) => `shape ${s}`), ...m.adds.panels.map((p) => `panel ${p}`), ...m.adds.dataSources.map((d) => `data source ${d}`)]
  return parts.join(', ') || 'nothing declared'
}

/** The manifest's entry files must be plain paths inside the plugin, and the test must exist. */
function checkEntries(m: PluginManifest, exists: (path: string) => boolean): string | null {
  const entries = [m.test, m.frontend, ...(m.backend ? [m.backend] : [])]
  for (const entry of entries) {
    const checked = checkPluginPath(entry)
    if (!checked.ok) return `Invalid manifest entry: ${checked.error}`
  }
  if (!exists(m.test)) return `Missing the test file ${m.test}; every plugin needs one.`
  if (!exists(m.frontend) && !(m.backend && exists(m.backend))) return `Missing the entry file ${m.frontend}${m.backend ? ` or ${m.backend}` : ''}.`
  return null
}

function notApproved(action: string, name: string): ToolResult {
  return fail(`${action} ${name} was not approved (declined, timed out, or cancelled because the plugin changed). Do not retry unless the user asks.`)
}

function approvalDetail(m: PluginManifest, files: [string, string][], deps: string[], where: string): string {
  const lines = [
    m.description,
    `Where: ${where}`,
    `Adds: ${addsSummary(m)}`,
    `Skill tree: ${m.skill.tree}${m.skill.parents.length ? `, builds on ${m.skill.parents.join(', ')}` : ''}`,
    `Runs: test ${m.test}, frontend ${m.frontend}${m.backend ? `, backend ${m.backend}` : ''}`,
    `Files: ${files.map(([p, c]) => `${p} (${Buffer.byteLength(c, 'utf8')} B)`).join(', ') || 'manifest only'}`,
  ]
  if (deps.length) lines.push(`Installs: ${deps.join(', ')} (install scripts disabled)`)
  if (m.backend) lines.push(`Backend adapter: ${m.backend}${m.permissions.network ? ' WITH network access' : ' (no network)'}`)
  lines.push('Its test runs on this computer. It is then design-linted and previewed, and you decide whether to keep it.')
  return lines.join('\n')
}

/** Resolve once every expected tool is registered (frontend tools arrive from the app window), or on timeout. */
function waitForTools(deps: SkillToolDeps, name: string, expected: string[]): Promise<string[]> {
  const current = () => deps.host.infos().find((p) => p.name === name)?.tools ?? []
  const done = () => expected.every((t) => current().includes(t))
  if (done()) return Promise.resolve(current())
  return new Promise((resolve) => {
    const stop = deps.tools.onChange(() => {
      if (!done()) return
      clearTimeout(timer)
      stop()
      resolve(current())
    })
    const timer = setTimeout(() => {
      stop()
      resolve(current())
    }, deps.toolWaitMs ?? TOOL_WAIT_MS)
  })
}

async function outcome(deps: SkillToolDeps, manifest: PluginManifest): Promise<ToolResult> {
  const info = await deps.host.refresh(manifest.name)
  if (!info) return fail(`${manifest.name} was written but the app did not pick it up. Check list_plugins.`)
  if (info.state === 'error') return fail(`${manifest.name} failed. Fix it with update_plugin (send only the changed files):\n${info.message ?? 'unknown error'}`)
  if (info.state === 'disabled') return { text: `${manifest.name} is written but disabled: ${info.message ?? 'unknown reason'}. Tell the user what is needed.`, data: info }
  if (info.state !== 'preview' && info.state !== 'active') return { text: `${manifest.name} is ${info.state}${info.message ? `: ${info.message}` : ''}. Check list_plugins shortly.`, data: info }

  const expected = manifest.adds.tools.map((t) => pluginToolName(manifest.name, t))
  const tools = await waitForTools(deps, manifest.name, expected)
  const missing = expected.filter((t) => !tools.includes(t))
  const lines = [
    info.state === 'preview'
      ? `${manifest.name} passed its design lint and test and is running in preview. The user must click Keep in the app to keep it.`
      : `${manifest.name} is active.`,
    tools.length ? `Tools: ${tools.join(', ')}. Call them now with call_plugin_tool to finish the request.` : 'It registered no tools.',
  ]
  if (missing.length) lines.push(`Not registered yet: ${missing.join(', ')} (is the app's control window open? Does setup register them?).`)
  return { text: lines.join('\n'), data: { ...info, tools } }
}

/**
 * Write the files and install packages while the watcher ignores the plugin,
 * then run the pipeline once. Returns the tool result.
 */
async function writeAndCheck(deps: SkillToolDeps, dir: string, manifest: PluginManifest, files: [string, string][], packages: string[]): Promise<ToolResult> {
  const release = deps.host.hold(manifest.name)
  try {
    await writePluginFiles(dir, manifest, files)
    if (packages.length) await deps.install(dir)
  } catch (error) {
    release()
    const what = packages.length ? `Writing or installing ${packages.join(', ')}` : 'Writing the files'
    return fail(`${what} failed: ${errorMessage(error)}. Fix it with update_plugin.`)
  }
  return outcome(deps, manifest)
}

function safeDependencies(packageJson: string | undefined): { ok: true; deps: string[] } | { ok: false; error: string } {
  try {
    return { ok: true, deps: dependenciesIn(packageJson) }
  } catch (error) {
    return { ok: false, error: `package.json is not valid JSON: ${errorMessage(error)}` }
  }
}

export function skillTools(deps: SkillToolDeps): RegisteredTool[] {
  const { host, approvals } = deps
  const previewState: PreviewState = { recording: new Set(), failed: new Set() }
  return [
    defineCoreTool({
      name: 'list_skill_trees',
      description:
        'The skill trees the whiteboard has grown: each tree (domain) with its skills, what each builds on, its tools and state. ' +
        'Check it before building, to extend the right tree or skill instead of duplicating one.',
      input: z.object({}),
      run: () => {
        const trees = new Map<string, PluginInfo[]>()
        for (const p of host.infos()) {
          const tree = p.skill?.tree ?? 'general'
          trees.set(tree, [...(trees.get(tree) ?? []), p])
        }
        if (!trees.size) return { text: 'No skills yet.' }
        const lines = [...trees.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .flatMap(([tree, skills]) => [
            `${tree} (${skills.length})`,
            ...skills.map((s) => `  ${s.name} [${s.state}]${s.skill?.parents.length ? ` builds on ${s.skill.parents.join(', ')}` : ''}: ${s.description}${s.tools.length ? ` | tools: ${s.tools.join(', ')}` : ''}`),
          ])
        return { text: lines.join('\n') }
      },
    }),
    defineCoreTool({
      name: 'get_plugin_guide',
      description: 'How to build a whiteboard skill (plugin): manifest, plugin API, design lint, test, recipes. Read it once before create_plugin.',
      input: z.object({}),
      run: async () => {
        if (!existsSync(deps.guidePath)) return fail(`The plugin guide is missing (${deps.guidePath}).`)
        return { text: await readFile(deps.guidePath, 'utf8') }
      },
    }),
    defineCoreTool({
      name: 'create_plugin',
      description:
        'Build a new skill (plugin) when no tool does what the user asked and it could be asked again. Pass the manifest (name is taken from `name`), ' +
        'the source files (path -> text; must include the test), and the scope. The user approves the write; the result reports the design lint and test. ' +
        'Call get_plugin_guide first.',
      input: z.object({
        name: pluginNameSchema,
        manifest: manifestInput,
        files: filesSchema,
        scope: z.enum(['shared', 'board']).default('shared'),
      }),
      run: async ({ name, manifest: rawManifest, files, scope }) => {
        const parsed = parseManifest({ ...rawManifest, name })
        if (!parsed.ok) return fail(`Invalid manifest: ${parsed.error}`)
        const manifest = parsed.manifest
        const checked = checkPluginFiles(files)
        if (!checked.ok) return fail(`Invalid files:\n${checked.errors.join('\n')}`)
        const paths = new Set(checked.files.map(([p]) => p))
        const entryProblem = checkEntries(manifest, (p) => paths.has(p))
        if (entryProblem) return fail(entryProblem)
        const target = (): { dir: string } | { error: string } => {
          const existing = locate(host, name)
          if (existing) return { error: `A plugin named ${name} already exists (${existing.scope}). Use read_plugin and update_plugin, or pick another name.` }
          const { shared, board } = host.pluginDirs()
          if (scope === 'board' && !board) return { error: 'No board is open; use scope "shared" or open a board first.' }
          return { dir: join(scope === 'board' && board ? board : shared, name) }
        }
        const before = target()
        if ('error' in before) return fail(before.error)
        const depList = safeDependencies(files['package.json'])
        if (!depList.ok) return fail(depList.error)

        const approved = await approvals.request({
          kind: 'plugin',
          title: `Build skill "${name}"?`,
          detail: approvalDetail(manifest, checked.files, depList.deps, scope === 'board' ? 'this board only' : 'all boards'),
          plugin: name,
        })
        if (!approved) return notApproved('Building', name)
        // The wait can be minutes: the name may be taken or the board switched since.
        const after = target()
        if ('error' in after) return fail(after.error)
        if (after.dir !== before.dir) return fail('The open board changed while waiting for approval; ask again.')
        return writeAndCheck(deps, after.dir, manifest, checked.files, depList.deps)
      },
    }),
    defineCoreTool({
      name: 'update_plugin',
      description:
        'Change an existing skill (plugin): send only the files that change, and optionally manifest fields to change (bump version). ' +
        'The user approves the write; the plugin is linted, tested and offered for keeping again. Use read_plugin first.',
      input: z.object({
        name: pluginNameSchema,
        files: filesSchema.default({}),
        manifest: manifestInput.optional(),
      }),
      run: async ({ name, files, manifest: changes }) => {
        const found = locate(host, name)
        if (!found) return fail(`No plugin named ${name}. Use create_plugin, or list_plugins to see names.`)
        if (!Object.keys(files).length && !changes) return fail('Nothing to change: pass files and/or manifest.')
        let current: Record<string, unknown>
        try {
          current = JSON.parse(await readFile(join(found.dir, 'manifest.json'), 'utf8')) as Record<string, unknown>
        } catch (error) {
          current = {}
          if (!changes) return fail(`manifest.json of ${name} is unreadable (${errorMessage(error)}); pass a full manifest.`)
        }
        const parsed = parseManifest({ ...current, ...(changes ?? {}), name })
        if (!parsed.ok) return fail(`Invalid manifest: ${parsed.error}`)
        const checked = checkPluginFiles(files)
        if (!checked.ok) return fail(`Invalid files:\n${checked.errors.join('\n')}`)
        const written = new Set(checked.files.map(([p]) => p))
        const entryProblem = checkEntries(parsed.manifest, (p) => written.has(p) || existsSync(join(found.dir, ...p.split('/'))))
        if (entryProblem) return fail(entryProblem)
        const depList = safeDependencies(files['package.json'])
        if (!depList.ok) return fail(depList.error)

        const approved = await approvals.request({
          kind: 'plugin',
          title: `Update skill "${name}"?`,
          detail: approvalDetail(parsed.manifest, checked.files, depList.deps, found.scope === 'board' ? 'this board only' : 'all boards'),
          plugin: name,
        })
        if (!approved) return notApproved('Updating', name)
        const still = locate(host, name)
        if (!still || still.dir !== found.dir) return fail(`${name} moved or was removed while waiting for approval; read_plugin and try again.`)
        return writeAndCheck(deps, found.dir, parsed.manifest, checked.files, depList.deps)
      },
    }),
    defineCoreTool({
      name: 'read_plugin',
      description: "Read a skill's (plugin's) manifest and source files, e.g. before update_plugin or to learn from an existing one like mermaid.",
      input: z.object({ name: pluginNameSchema }),
      run: async ({ name }) => {
        const found = locate(host, name)
        if (!found) return fail(`No plugin named ${name}.`)
        const files = await readPluginFiles(found.dir)
        const body = files.map((f) => (f.content === undefined ? `--- ${f.path} (${f.bytes} B, too large to show)` : `--- ${f.path}\n${f.content}`)).join('\n')
        return { text: `${name} (${found.scope})\n${body}` }
      },
    }),
    defineCoreTool({
      name: 'call_plugin_tool',
      description:
        'Call a plugin tool by its full name (plugin_<plugin>_<tool>). Use it right after create_plugin or update_plugin, before your tool list refreshes. ' +
        "The first call of a skill that has no preview also records its 5-second preview for the skill viewer, so make that call a good showcase.",
      input: z.object({
        tool: z.string().regex(/^plugin_[a-z0-9_]+$/, 'a plugin tool name like plugin_latex_show_equation'),
        args: z.record(z.string(), z.unknown()).default({}),
      }),
      run: ({ tool, args }) => runWithPreview(deps, previewState, tool, args, 'auto', DEFAULT_PREVIEW_SECONDS),
    }),
    defineCoreTool({
      name: 'record_skill_preview',
      description:
        "Re-record a skill's preview clip (shown when hovering it in the skill viewer): runs one of its tools with showcase arguments while the app records the scene or canvas.",
      input: z.object({
        tool: z.string().regex(/^plugin_[a-z0-9_]+$/, 'a plugin tool name like plugin_atom_show_atom'),
        args: z.record(z.string(), z.unknown()).default({}),
        seconds: z.number().min(1).max(MAX_PREVIEW_SECONDS).default(DEFAULT_PREVIEW_SECONDS),
      }),
      run: async ({ tool, args, seconds }) => {
        if (!ownerOf(host, tool)) return fail(`No loaded plugin has the tool ${tool}. Check list_plugins.`)
        return runWithPreview(deps, previewState, tool, args, 'always', seconds)
      },
    }),
  ]
}
