/**
 * Direct text commands for the command bar, so tools can be driven without
 * the brain: "/explode 0.6", "/focus left encoder", "/open titan",
 * "/annotate left_encoder | Counts wheel ticks".
 */
export interface ParsedCommand {
  tool: string
  args: Record<string, unknown>
}

const ALIASES: Record<string, string> = {
  open: 'open_board',
  board: 'open_board',
  boards: 'list_boards',
  parts: 'list_parts',
  reset: 'reset_view',
  home: 'reset_view',
  assemble: 'reset_view',
  label: 'annotate',
  note: 'add_note',
  output: 'set_output',
  plugins: 'list_plugins',
  topics: 'list_topics',
  status: 'board_status',
}

/** Which argument a bare value fills, per tool. */
const POSITIONAL: Record<string, string> = {
  open_board: 'name',
  load_model: 'file',
  explode: 'amount',
  focus: 'part',
  clear_annotations: 'part',
  set_output: 'view',
  add_note: 'text',
}

function coerce(value: string): unknown {
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value)
  if (value === 'true') return true
  if (value === 'false') return false
  return value
}

export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null
  const body = trimmed.slice(1).trim()
  if (!body) return null
  const space = body.search(/\s/)
  const head = (space === -1 ? body : body.slice(0, space)).toLowerCase()
  const rest = space === -1 ? '' : body.slice(space + 1).trim()
  const tool = ALIASES[head] ?? head

  if (tool === 'annotate') {
    const [part, ...label] = rest.split('|')
    return { tool, args: { part: (part ?? '').trim(), text: label.join('|').trim() } }
  }
  if (rest.startsWith('{')) {
    try {
      return { tool, args: JSON.parse(rest) as Record<string, unknown> }
    } catch {
      return { tool, args: {} }
    }
  }
  const args: Record<string, unknown> = {}
  const positional: string[] = []
  for (const token of rest.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []) {
    const eq = token.indexOf('=')
    if (eq > 0) args[token.slice(0, eq)] = coerce(token.slice(eq + 1).replace(/^"|"$/g, ''))
    else positional.push(token.replace(/^"|"$/g, ''))
  }
  const slot = POSITIONAL[tool]
  if (slot && positional.length && args[slot] === undefined) {
    const joined = positional.join(' ')
    args[slot] = slot === 'amount' ? coerce(joined) : joined
  }
  return { tool, args }
}
