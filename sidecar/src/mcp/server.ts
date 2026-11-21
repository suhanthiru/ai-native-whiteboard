import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, isInitializeRequest, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { ToolRegistry } from '../tools/registry'
import { errorMessage, logger } from '../log'

const log = logger('mcp')
const MAX_BODY_BYTES = 4 * 1024 * 1024

export const BASE_INSTRUCTIONS = `You control an AI-native whiteboard and 3D viewer through these tools. Never try to click the UI.
- Boards: list_boards, open_board. Models: list_parts, explode, focus, annotate, reset_view.
- To explain a part: focus it, add 1-3 short annotate labels, then explain in plain language.
- Plugin tools are named plugin_<plugin>_<tool>. If a plugin is disabled because data is missing, say exactly what is missing; never invent data.

The whiteboard teaches itself. It has no fixed feature list: it grows skills (plugins) organised in skill trees, one tree per domain (chemistry, botany, robotics, video, math...), and can learn to do essentially anything that code in a browser or a sandboxed Node process can do.

The user states goals, not instructions. Never wait for them to say "build a skill". For every goal ("animate the atoms", "pull an electron off", "strip the leaves off this tree", "build a moving car", "pull up the SO-101 files", "play this video"):
1. Look first: list_skill_trees and your tool list. If a skill does it, use it.
2. If a skill does something close, extend it with read_plugin then update_plugin (add a tool or a parameter: the atom skill learns ionize_atom; the tree skill learns remove_leaves). Bump its version.
3. If nothing is close, build a new skill (get_plugin_guide once per session, then create_plugin). Put it in the right tree with manifest.skill: tree (reuse an existing tree name when it fits, start a new one for a new domain), parents (the skills it builds on and calls), explainer (two or three plain sentences: what it does and how to ask), examples (what the user might say), preview (scene, canvas or none).
4. A big goal becomes a small tree, not one huge plugin: base skills first (car-body, wheels), then the skills that combine them (drive-car calls the others with api.callTool). Each skill does one thing well and is reusable on its own.
5. Make tools general (the element, the equation, the file, the speed as parameters) so the next request like it is one call.
6. create_plugin and update_plugin report the design lint and test. On failure, fix and retry, at most 3 times, then say plainly what blocks you.
7. When it passes, finish the user's goal at once with call_plugin_tool: that first call also records the skill's 5-second preview for the skill viewer, so make it a good showcase. Tell the user to approve the build and click Keep.
- Need packages (physics, video, file formats)? Declare them in the plugin's package.json. Need files from the internet (models, datasets)? Use a backend adapter with network permission; the user sees and approves that.
- run_code is only for one-off calculations nobody will ask for again.
- When the user states a lasting preference or convention, save it with remember.`

/** Instructions for a new MCP session: the base rules plus the user's saved notes. */
export function buildInstructions(notes: string): string {
  return notes ? `${BASE_INSTRUCTIONS}\n\n${notes}` : BASE_INSTRUCTIONS
}

interface Session {
  server: Server
  transport: StreamableHTTPServerTransport
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(buf)
  }
  if (size === 0) return undefined
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** Streamable HTTP MCP endpoint. One MCP Server per client session; all share the tool registry. */
export class McpBridge {
  private readonly sessions = new Map<string, Session>()

  constructor(
    private readonly tools: ToolRegistry,
    /** Extra context for each new session (the user's saved notes). */
    private readonly notes: () => string = () => '',
  ) {
    tools.onChange(() => this.notifyToolsChanged())
  }

  private createServer(): Server {
    const server = new Server({ name: 'whiteboard', version: '0.1.0' }, { capabilities: { tools: { listChanged: true } }, instructions: buildInstructions(this.notes()) })
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.tools.list().map((t) => ({
        name: t.name,
        description: t.requiresApproval ? `${t.description} (The user must approve each call.)` : t.description,
        inputSchema: { type: 'object' as const, ...t.inputSchema },
      })),
    }))
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const result = await this.tools.call(request.params.name, request.params.arguments ?? {})
      const content: { type: 'text'; text: string }[] = [{ type: 'text', text: result.text }]
      if (result.data !== undefined) content.push({ type: 'text', text: JSON.stringify(result.data) })
      return { content, isError: result.isError ?? false }
    })
    return server
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const sessionId = req.headers['mcp-session-id']
    const id = Array.isArray(sessionId) ? sessionId[0] : sessionId
    let body: unknown
    if (req.method === 'POST') {
      try {
        body = await readJsonBody(req)
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: errorMessage(error) }, id: null }))
        return
      }
    }

    if (id && this.sessions.has(id)) {
      await this.sessions.get(id)?.transport.handleRequest(req, res, body)
      return
    }
    if (!id && req.method === 'POST' && isInitializeRequest(body)) {
      const server = this.createServer()
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          this.sessions.set(sid, { server, transport })
          log.info(`client connected (${this.sessions.size} session(s))`)
        },
      })
      transport.onclose = () => {
        if (transport.sessionId) this.sessions.delete(transport.sessionId)
      }
      await server.connect(transport)
      await transport.handleRequest(req, res, body)
      return
    }
    res.writeHead(id ? 404 : 400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: id ? 'unknown session' : 'missing session; send initialize first' }, id: null }))
  }

  notifyToolsChanged(): void {
    for (const { server } of this.sessions.values()) {
      server.sendToolListChanged().catch((error: unknown) => log.debug('list_changed failed', errorMessage(error)))
    }
  }

  async close(): Promise<void> {
    for (const { transport } of this.sessions.values()) await transport.close().catch(() => undefined)
    this.sessions.clear()
  }
}
