/**
 * Best-effort network block for child processes. Node 24's permission model
 * has no network flag, so we refuse the networking modules and globals at
 * load time. Combined with --permission (no child processes, no workers,
 * no addons) this closes the ordinary routes out.
 */
import { registerHooks } from 'node:module'

const NET_MODULES = new Set(['net', 'tls', 'http', 'https', 'http2', 'dgram', 'dns', 'inspector', 'undici'])

export class NetworkBlockedError extends Error {
  constructor(what: string) {
    super(`network access is not allowed here (${what})`)
  }
}

export function blockNetwork(): void {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const bare = specifier.startsWith('node:') ? specifier.slice(5) : specifier
      if (NET_MODULES.has(bare.split('/')[0] ?? bare)) throw new NetworkBlockedError(specifier)
      return nextResolve(specifier, context)
    },
  })
  // process.getBuiltinModule() skips resolve hooks, so wrap it too.
  const original = process.getBuiltinModule?.bind(process)
  if (original) {
    Object.defineProperty(process, 'getBuiltinModule', {
      value: (id: string) => {
        const bare = id.startsWith('node:') ? id.slice(5) : id
        if (NET_MODULES.has(bare.split('/')[0] ?? bare)) throw new NetworkBlockedError(id)
        return original(id)
      },
      configurable: false,
      writable: false,
    })
  }
  const refuse = (name: string) => () => {
    throw new NetworkBlockedError(name)
  }
  for (const name of ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest']) {
    Object.defineProperty(globalThis, name, { value: refuse(name), configurable: false, writable: false })
  }
}
