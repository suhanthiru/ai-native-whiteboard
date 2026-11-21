import { initialAppState, type AppState } from '@wb/sdk'

type Listener = (state: AppState) => void

/**
 * Authoritative app state. Updates are pure functions that return a new
 * state; listeners (the WebSocket hub) broadcast it to both windows.
 */
export class StateStore {
  private state: AppState
  private readonly listeners = new Set<Listener>()

  constructor(initial: AppState = initialAppState()) {
    this.state = initial
  }

  get(): AppState {
    return this.state
  }

  update(fn: (state: AppState) => AppState): AppState {
    const next = fn(this.state)
    if (next === this.state) return next
    this.state = next
    for (const l of [...this.listeners]) l(next)
    return next
  }

  /** Shallow-merge one slice. */
  patch<K extends keyof AppState>(key: K, value: Partial<AppState[K]> | AppState[K]): AppState {
    return this.update((s) => {
      const current = s[key]
      const merged = Array.isArray(value) || typeof current !== 'object' || current === null ? value : { ...current, ...value }
      return { ...s, [key]: merged as AppState[K] }
    })
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
