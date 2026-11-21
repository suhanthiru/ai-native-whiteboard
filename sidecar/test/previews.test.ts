import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_PREVIEW_BYTES, previewFileIn, recordWhileRunning, savePreview, sniffPreview, type RecordingClient } from '../src/skills/previews'
import { hashPluginDir } from '../src/plugins/discover'

const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4])
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])
const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73])

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wb-previews-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function client(opts: { control?: boolean; clip?: Uint8Array; error?: string } = {}): RecordingClient & { calls: unknown[] } {
  const calls: unknown[] = []
  return {
    calls,
    hasRole: () => opts.control ?? true,
    rpc: async (method, params) => {
      calls.push({ method, params })
      if (opts.error) throw new Error(opts.error)
      return { mime: 'video/webm', data: Buffer.from(opts.clip ?? WEBM).toString('base64') }
    },
  }
}

describe('preview files', () => {
  it('identifies clips by their bytes', () => {
    expect(sniffPreview(WEBM)).toBe('webm')
    expect(sniffPreview(PNG)).toBe('png')
    expect(sniffPreview(MP4)).toBe('mp4')
    expect(sniffPreview(new TextEncoder().encode('<script>alert(1)</script>'))).toBeNull()
  })

  it('saves one preview, replacing a previous one of another kind', async () => {
    expect(await savePreview(dir, PNG)).toBe('preview.png')
    expect(previewFileIn(dir)?.kind).toBe('png')
    expect(await savePreview(dir, WEBM)).toBe('preview.webm')
    expect(existsSync(join(dir, 'preview.png'))).toBe(false)
    const file = previewFileIn(dir)
    expect(file).toMatchObject({ kind: 'webm', type: 'video/webm' })
    expect(new Uint8Array(await readFile(file?.path ?? ''))).toEqual(WEBM)
  })

  it('rejects empty, oversized and unknown recordings', async () => {
    await expect(savePreview(dir, new Uint8Array())).rejects.toThrow(/empty/)
    const big = new Uint8Array(MAX_PREVIEW_BYTES + 1)
    big.set(WEBM)
    await expect(savePreview(dir, big)).rejects.toThrow(/limit/)
    await expect(savePreview(dir, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).rejects.toThrow(/not a WebM/)
    expect(previewFileIn(dir)).toBeNull()
  })

  it('does not change the plugin hash, so recording never asks for approval again', async () => {
    await writeFile(join(dir, 'index.ts'), 'export {}')
    const before = await hashPluginDir(dir)
    await savePreview(dir, WEBM)
    await writeFile(join(dir, '.preview-1234.tmp'), 'half-written clip')
    expect(await hashPluginDir(dir)).toBe(before)
  })

  it('leaves no temp file behind', async () => {
    await savePreview(dir, WEBM)
    const { readdir } = await import('node:fs/promises')
    expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })
})

describe('recordWhileRunning', () => {
  it('records while the tool runs and saves the clip', async () => {
    const c = client()
    let ran = false
    const out = await recordWhileRunning(c, dir, 'scene', 5, async () => {
      ran = true
      return { text: 'Carbon shown.' }
    })
    expect(ran).toBe(true)
    expect(out.result.text).toBe('Carbon shown.')
    expect(out.saved).toBe('preview.webm')
    expect(c.calls).toEqual([{ method: 'preview.record', params: { view: 'scene', seconds: 5 } }])
  })

  it('clamps the length and still returns the tool result when recording fails', async () => {
    const c = client({ error: 'the 3D view is hidden' })
    const out = await recordWhileRunning(c, dir, 'scene', 60, async () => ({ text: 'ok' }))
    expect(out.result.text).toBe('ok')
    expect(out.saved).toBeUndefined()
    expect(out.problem).toMatch(/hidden/)
    expect((c.calls[0] as { params: { seconds: number } }).params.seconds).toBe(10)
  })

  it('does not keep a recording of a failed tool call', async () => {
    const out = await recordWhileRunning(client(), dir, 'canvas', 2, async () => ({ text: 'boom', isError: true }))
    expect(out.saved).toBeUndefined()
    expect(previewFileIn(dir)).toBeNull()
  })

  it('just runs the tool when no control window is open', async () => {
    const c = client({ control: false })
    const out = await recordWhileRunning(c, dir, 'scene', 5, async () => ({ text: 'ok' }))
    expect(out.problem).toMatch(/control window/)
    expect(c.calls).toEqual([])
  })

  it('refuses a clip that is not media', async () => {
    const out = await recordWhileRunning(client({ clip: new TextEncoder().encode('not a video at all') }), dir, 'scene', 1, async () => ({ text: 'ok' }))
    expect(out.problem).toMatch(/not a WebM/)
  })
})
