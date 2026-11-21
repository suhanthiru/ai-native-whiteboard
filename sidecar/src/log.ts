/** Minimal leveled logger to stderr (stdout is reserved for structured output). */
type Level = 'debug' | 'info' | 'warn' | 'error'

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }
const threshold = order[(process.env.WB_LOG_LEVEL as Level | undefined) ?? 'info'] ?? order.info

function format(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function write(level: Level, scope: string, message: string, rest: unknown[]): void {
  if (order[level] < threshold) return
  const time = new Date().toISOString().slice(11, 23)
  const extra = rest.length ? ' ' + rest.map(format).join(' ') : ''
  process.stderr.write(`${time} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}${extra}\n`)
}

export interface Logger {
  debug(message: string, ...rest: unknown[]): void
  info(message: string, ...rest: unknown[]): void
  warn(message: string, ...rest: unknown[]): void
  error(message: string, ...rest: unknown[]): void
}

export function logger(scope: string): Logger {
  return {
    debug: (m, ...r) => write('debug', scope, m, r),
    info: (m, ...r) => write('info', scope, m, r),
    warn: (m, ...r) => write('warn', scope, m, r),
    error: (m, ...r) => write('error', scope, m, r),
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
