import { describe, expect, it } from 'vitest'
import { createTestApi, setupForTest } from '@wb/sdk/testing'
import { dataColors, themes } from '@wb/sdk'
import plugin from './index'
import { mermaidTheme } from './theme'

describe('mermaid plugin', () => {
  it('registers the mermaid shape and its tools', async () => {
    const api = await setupForTest(plugin)
    expect(api.recorded.shapes).toHaveLength(1)
    expect((api.recorded.shapes[0] as { type: string }).type).toBe('mermaid')
    expect(api.recorded.tools.map((t) => t.name).sort()).toEqual(['create_mermaid', 'update_mermaid'])
  })

  it('create_mermaid puts a mermaid shape with the code on the canvas', async () => {
    const api = await setupForTest(plugin)
    const result = (await api.runTool('create_mermaid', { code: 'flowchart LR\n  Boot --> Ready' })) as { id: string }
    expect(api.recorded.canvasShapes).toHaveLength(1)
    const shape = api.recorded.canvasShapes[0]
    expect(shape?.type).toBe('mermaid')
    expect(shape?.props?.code).toContain('Boot --> Ready')
    expect(result.id).toBe(shape?.id)
  })

  it('rejects empty diagrams', async () => {
    const api = await setupForTest(plugin)
    await expect(api.runTool('create_mermaid', { code: '' })).rejects.toThrow()
  })

  it('update_mermaid replaces the code', async () => {
    const api = await setupForTest(plugin)
    const { id } = (await api.runTool('create_mermaid', { code: 'flowchart LR\n  A --> B' })) as { id: string }
    await api.runTool('update_mermaid', { id, code: 'flowchart LR\n  A --> C' })
    expect(api.recorded.canvasShapes[0]?.props?.code).toContain('A --> C')
  })

  it('themes only from design tokens', () => {
    const theme = mermaidTheme(createTestApi())
    const allowed = new Set<string>([...Object.values(themes.glass.colors), ...Object.values(dataColors), 'transparent', 'true'])
    for (const [key, value] of Object.entries(theme)) {
      if (key === 'fontFamily' || key === 'fontSize') continue
      expect(allowed.has(value), `${key}=${value}`).toBe(true)
    }
  })
})
