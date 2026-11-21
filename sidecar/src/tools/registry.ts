import { z } from 'zod'
import type { Approvals } from '../approvals'
import { errorMessage, logger } from '../log'

const log = logger('tools')

export interface ToolResult {
  /** What Claude reads. Keep it short and factual. */
  text: string
  /** Optional structured data, appended as JSON. */
  data?: unknown
  isError?: boolean
}

export interface RegisteredTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  requiresApproval?: boolean
  /** 'core' or the plugin name. */
  owner: string
  /** Core tools validate with zod before running. */
  schema?: z.ZodType
  handler: (args: Record<string, unknown>) => Promise<ToolResult> | ToolResult
}

export interface CoreToolSpec<S extends z.ZodObject> {
  name: string
  description: string
  input: S
  requiresApproval?: boolean
  run: (args: z.infer<S>) => Promise<ToolResult> | ToolResult
}

export function defineCoreTool<S extends z.ZodObject>(spec: CoreToolSpec<S>): RegisteredTool {
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: z.toJSONSchema(spec.input, { target: 'draft-7' }) as Record<string, unknown>,
    requiresApproval: spec.requiresApproval,
    owner: 'core',
    schema: spec.input,
    handler: (args) => spec.run(spec.input.parse(args)),
  }
}

/** Minimal check for plugin tools: required keys present and object-shaped input. */
export function checkRequired(schema: Record<string, unknown>, args: Record<string, unknown>): string | null {
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : []
  const missing = required.filter((k) => args[k] === undefined)
  return missing.length ? `missing required argument(s): ${missing.join(', ')}` : null
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>()
  private readonly changeListeners = new Set<() => void>()

  constructor(private readonly approvals: Approvals) {}

  register(tool: RegisteredTool): void {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(tool.name)) throw new Error(`invalid tool name: ${tool.name}`)
    const existing = this.tools.get(tool.name)
    if (existing && existing.owner !== tool.owner) throw new Error(`tool ${tool.name} is already registered by ${existing.owner}`)
    this.tools.set(tool.name, tool)
    this.emitChange()
  }

  /** Replace every tool an owner has with a new set (used on plugin hot reload). */
  replaceOwner(owner: string, tools: RegisteredTool[]): void {
    for (const [name, t] of this.tools) if (t.owner === owner) this.tools.delete(name)
    for (const t of tools) {
      const existing = this.tools.get(t.name)
      if (existing && existing.owner !== owner) {
        log.warn(`tool ${t.name} from ${owner} conflicts with ${existing.owner}; skipped`)
        continue
      }
      this.tools.set(t.name, { ...t, owner })
    }
    this.emitChange()
  }

  removeOwner(owner: string): void {
    this.replaceOwner(owner, [])
  }

  list(): RegisteredTool[] {
    return [...this.tools.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name)
  }

  ownedBy(owner: string): string[] {
    return this.list()
      .filter((t) => t.owner === owner)
      .map((t) => t.name)
  }

  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener)
    return () => this.changeListeners.delete(listener)
  }

  async call(name: string, rawArgs: unknown): Promise<ToolResult> {
    const tool = this.tools.get(name)
    if (!tool) return { text: `Unknown tool "${name}". Call list_plugins or check the tool list.`, isError: true }
    const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>
    if (!tool.schema) {
      const problem = checkRequired(tool.inputSchema, args)
      if (problem) return { text: `${name}: ${problem}`, isError: true }
    }
    if (tool.requiresApproval) {
      const approved = await this.approvals.request({
        kind: 'tool',
        title: `Allow ${name}?`,
        detail: `${tool.description}\n\nArguments: ${JSON.stringify(args)}`,
        plugin: tool.owner === 'core' ? undefined : tool.owner,
      })
      if (!approved) return { text: `The user declined ${name}. Do not retry unless they ask.`, isError: true }
    }
    try {
      return await tool.handler(args)
    } catch (error) {
      if (error instanceof z.ZodError) {
        return { text: `${name}: invalid arguments: ${error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, isError: true }
      }
      log.warn(`tool ${name} failed`, errorMessage(error))
      return { text: `${name} failed: ${errorMessage(error)}`, isError: true }
    }
  }

  private emitChange(): void {
    for (const l of [...this.changeListeners]) l()
  }
}
