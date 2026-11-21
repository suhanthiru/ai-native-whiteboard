import { useEffect, useMemo } from 'react'
import { themes, type Role } from '@wb/sdk'
import { PluginRuntime } from '../core/plugins/runtime'
import { sidecar } from '../core/rpc/client'

/** One plugin runtime per window, fed by bundles from the sidecar. */
export function usePluginRuntime(role: Role): PluginRuntime {
  const runtime = useMemo(() => new PluginRuntime(role, () => themes[role === 'output' ? 'projector' : 'glass']), [role])
  useEffect(() => {
    const offBundle = sidecar.on('plugin_bundle', (m) => void runtime.load(m.bundle))
    const offUnload = sidecar.on('plugin_unload', (m) => runtime.unload(m.name))
    const offTool = role === 'control' ? sidecar.handleRpc('plugin.tool', (p) => {
      const { plugin, tool, args } = p as { plugin: string; tool: string; args: unknown }
      return runtime.callTool(plugin, tool, args)
    }) : () => undefined
    return () => {
      offBundle()
      offUnload()
      offTool()
    }
  }, [runtime, role])
  return runtime
}
