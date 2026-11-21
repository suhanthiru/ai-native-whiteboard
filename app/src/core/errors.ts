/**
 * Frontend error reporting. Errors from plugins, bus subscribers and RPC
 * handlers are collected here and surfaced as toasts instead of disappearing.
 */
export interface ReportedError {
  id: number
  source: string
  message: string
  at: number
}

type Listener = (error: ReportedError) => void

const listeners = new Set<Listener>()
let nextId = 1

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

export function reportError(source: string, error: unknown): void {
  const reported: ReportedError = { id: nextId++, source, message: errorText(error), at: Date.now() }
  for (const l of listeners) l(reported)
}

export function onError(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const DEV_LOG_SIZE = 200
const devEntries: { at: number; source: string; message: string }[] = []

/** Plugin log lines. Kept in memory (window.__WB_LOG__) rather than printed. */
export function devLog(source: string, message: string): void {
  devEntries.push({ at: Date.now(), source, message })
  if (devEntries.length > DEV_LOG_SIZE) devEntries.shift()
  ;(globalThis as { __WB_LOG__?: unknown }).__WB_LOG__ = devEntries
}
