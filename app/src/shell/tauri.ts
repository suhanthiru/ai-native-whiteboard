/** Thin wrappers over the Tauri shell; everything still works in a plain browser. */
import { reportError } from '../core/errors'

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export async function windowRole(): Promise<'control' | 'output'> {
  const fromQuery = new URLSearchParams(window.location.search).get('role')
  if (fromQuery === 'output' || fromQuery === 'control') return fromQuery
  if (isTauri()) {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    return getCurrentWindow().label === 'output' ? 'output' : 'control'
  }
  return 'control'
}

export async function openOutputWindow(): Promise<void> {
  try {
    if (isTauri()) {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('open_output')
    } else {
      window.open(`${window.location.origin}/?role=output`, 'wb-output', 'width=1280,height=720')
    }
  } catch (error) {
    reportError('opening the output window', error)
  }
}

/** Forward the global push-to-talk shortcut from Rust to the command bar. */
export async function listenGlobalPtt(): Promise<() => void> {
  if (!isTauri()) return () => undefined
  const { listen } = await import('@tauri-apps/api/event')
  return listen<string>('ptt', (e) => window.dispatchEvent(new CustomEvent('wb-ptt', { detail: e.payload })))
}
