import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { errorMessage, logger } from '../log'

const log = logger('brain')
/** Long enough to build a new skill: approval, npm install, test, one or two fixes. */
const BRAIN_TIMEOUT_MS = 10 * 60_000

/** The thing that turns an utterance into tool calls and a spoken reply. Claude Code today; Javi later. */
export interface Brain {
  readonly name: string
  available(): Promise<boolean>
  ask(text: string, onActivity: (line: string) => void): Promise<string>
  cancel(): void
}

export const VOICE_PERSONA = [
  'You are the voice of an AI-native whiteboard and 3D viewer. The user is speaking to you, and your reply is read aloud.',
  'Act through the whiteboard MCP tools (mcp__whiteboard__*). Never describe clicking anything.',
  'Reply in one to three short spoken sentences: no markdown, no lists, no code, no file paths.',
  'When asked to explain a part: focus it, add one to three short annotate labels, then explain plainly.',
  'If a plugin is disabled because data is missing, say exactly what is missing. Never invent sensor data.',
  'Anything that moves hardware needs the user to approve it in the app; say so instead of working around it.',
  // Constants only: this text is passed on the command line (quoted for the Windows shell), so no double quotes or percent signs.
  'You teach yourself. The user says goals, never build a skill: treat every goal as yours to make possible.',
  'Check list_skill_trees first. Use a skill that fits, extend a close one with update_plugin, or write a new one with create_plugin,',
  'filed in the right skill tree with an explainer and examples. Split big goals into small skills that build on each other.',
  'Fix failing tests with update_plugin, then do the goal right away with call_plugin_tool, which also records its preview.',
  'Tell the user to approve the build in the app and to click Keep. Next time it is just a tool call. Save lasting preferences with remember.',
].join(' ')

/** With shell:true on Windows, child.kill() ends only cmd.exe; end the whole tree. */
function killTree(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => child.kill())
    return
  }
  child.kill()
}

interface StreamEvent {
  type?: string
  subtype?: string
  result?: string
  is_error?: boolean
  message?: { content?: { type: string; name?: string; text?: string; input?: unknown }[] }
}

function describeToolUse(name: string, input: unknown): string {
  const short = name.replace(/^mcp__whiteboard__/, '')
  const args = input && typeof input === 'object' ? Object.values(input as Record<string, unknown>).filter((v) => typeof v === 'string' || typeof v === 'number') : []
  return args.length ? `${short} ${args.slice(0, 2).join(' ')}` : short
}

/**
 * Runs `claude -p` against this project's .mcp.json. The prompt goes over
 * stdin (never the command line), and the brain keeps its own session id so it
 * never continues an unrelated Claude Code conversation in this folder.
 */
export class ClaudeCodeBrain implements Brain {
  readonly name = 'Claude Code'
  private child: ChildProcess | null = null
  private readonly sessionFile: string

  constructor(
    private readonly rootDir: string,
    runtimeDir: string,
    private readonly command = process.env.WB_CLAUDE_BIN ?? 'claude',
  ) {
    this.sessionFile = join(runtimeDir, 'brain-session')
  }

  async available(): Promise<boolean> {
    return new Promise((resolve) => {
      const child = process.platform === 'win32' ? spawn(`${this.command} --version`, { shell: true, stdio: 'ignore' }) : spawn(this.command, ['--version'], { stdio: 'ignore' })
      child.on('error', () => resolve(false))
      child.on('close', (code) => resolve(code === 0))
    })
  }

  private sessionArgs(): string[] {
    if (existsSync(this.sessionFile)) {
      const id = readFileSync(this.sessionFile, 'utf8').trim()
      if (/^[0-9a-f-]{36}$/.test(id)) return ['--resume', id]
    }
    const id = randomUUID()
    writeFileSync(this.sessionFile, id, 'utf8')
    return ['--session-id', id]
  }

  ask(text: string, onActivity: (line: string) => void): Promise<string> {
    this.cancel()
    const args = [
      '-p',
      ...this.sessionArgs(),
      '--mcp-config',
      join(this.rootDir, '.mcp.json'),
      '--allowedTools',
      'mcp__whiteboard',
      '--output-format',
      'stream-json',
      '--verbose',
      '--append-system-prompt',
      VOICE_PERSONA,
    ]
    // On Windows the npm shim needs a shell; quote every (constant) argument for it.
    const shell = process.platform === 'win32'
    const finalArgs = shell ? args.map((a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)) : args
    const options = { cwd: this.rootDir, stdio: ['pipe', 'pipe', 'pipe'] as ('pipe')[], env: process.env }
    const child = shell ? spawn([this.command, ...finalArgs].join(' '), { ...options, shell: true }) : spawn(this.command, finalArgs, options)
    this.child = child
    child.stdin?.end(text, 'utf8')

    return new Promise((resolve, reject) => {
      let buffer = ''
      let result: string | null = null
      let stderr = ''
      const timer = setTimeout(() => {
        killTree(child)
        if (this.child === child) this.child = null
        reject(new Error('the brain took too long'))
      }, BRAIN_TIMEOUT_MS)
      child.stdout?.on('data', (d: Buffer) => {
        buffer += d.toString('utf8')
        let nl = buffer.indexOf('\n')
        while (nl >= 0) {
          const line = buffer.slice(0, nl).trim()
          buffer = buffer.slice(nl + 1)
          nl = buffer.indexOf('\n')
          if (!line) continue
          try {
            const event = JSON.parse(line) as StreamEvent
            if (event.type === 'assistant') {
              for (const c of event.message?.content ?? []) if (c.type === 'tool_use' && c.name) onActivity(describeToolUse(c.name, c.input))
            } else if (event.type === 'result') {
              result = event.result ?? ''
              if (event.is_error) stderr += result
            }
          } catch {
            log.debug('non-JSON line from claude', line.slice(0, 200))
          }
        }
      })
      child.stderr?.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4000)))
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(new Error(`could not start ${this.command}: ${errorMessage(error)}`))
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (this.child === child) this.child = null
        if (result !== null && code === 0) resolve(result.trim())
        else if (code === null) reject(new Error('cancelled'))
        else reject(new Error(stderr.trim().slice(-500) || `claude exited with code ${code}`))
      })
    })
  }

  cancel(): void {
    if (this.child) {
      killTree(this.child)
      this.child = null
    }
  }
}
