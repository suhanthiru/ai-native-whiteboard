import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { spawnRestricted } from '../adapters/host'
import type { BoardService } from '../boards/service'
import type { Hub } from '../hub'
import { defineCoreTool, type RegisteredTool } from '../tools/registry'

const TIMEOUT_MS = 10_000
const MEMORY_MB = 256
const MAX_OUTPUT = 20_000
const MAX_ARTIFACT = 500_000

export interface RunResult {
  ok: boolean
  stdout: string
  stderr: string
  svg?: string
  html?: string
  timedOut: boolean
}

/**
 * Runs a JavaScript (ESM) snippet in a child under `node --permission`:
 * read-only access to the open board's data/, write access to its own scratch
 * folder only, no child processes, no workers, networking modules refused,
 * 10 s and 256 MB limits. The code can write output.svg or output.html into
 * its working directory to put a result on the canvas.
 */
export async function runSandboxed(code: string, opts: { runtimeDir: string; dataDir: string | null; netGuard: string }): Promise<RunResult> {
  const dir = join(opts.runtimeDir, 'sandbox', randomUUID())
  await mkdir(dir, { recursive: true })
  const entry = join(dir, 'main.mjs')
  const prelude = `const DATA_DIR = ${JSON.stringify(opts.dataDir ?? '')};\nconst OUT_DIR = ${JSON.stringify(dir)};\n`
  await writeFile(entry, prelude + code, 'utf8')
  try {
    const child = spawnRestricted({
      entry,
      readPaths: [dir, ...(opts.dataDir ? [opts.dataDir] : [])],
      writePaths: [dir],
      network: false,
      netGuard: opts.netGuard,
      maxOldSpaceMb: MEMORY_MB,
      cwd: dir,
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d: Buffer) => (stdout = (stdout + d.toString()).slice(-MAX_OUTPUT)))
    child.stderr?.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-MAX_OUTPUT)))
    let timedOut = false
    const code_ = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, TIMEOUT_MS)
      child.on('exit', (c) => {
        clearTimeout(timer)
        resolve(c)
      })
      child.on('error', () => resolve(-1))
    })
    const artifact = async (name: string) => {
      const file = join(dir, name)
      if (!existsSync(file)) return undefined
      const text = await readFile(file, 'utf8')
      return text.length > MAX_ARTIFACT ? undefined : text
    }
    return { ok: code_ === 0 && !timedOut, stdout: stdout.trim(), stderr: stderr.trim(), svg: await artifact('output.svg'), html: await artifact('output.html'), timedOut }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export function runCodeTool(deps: { runtimeDir: () => string; netGuard: () => string; boards: BoardService; hub: Hub }): RegisteredTool {
  return defineCoreTool({
    name: 'run_code',
    description:
      'Fallback for tasks no other tool covers. Runs a JavaScript ESM snippet in a sandbox (Node, no network, no child processes, 10s/256MB). ' +
      'Globals: DATA_DIR (read-only board data folder) and OUT_DIR. Print results with console.log. Write OUT_DIR/output.svg or output.html to show the result on the canvas. ' +
      'If this solves something that will be asked again, build a skill with create_plugin instead.',
    input: z.object({ code: z.string().min(1).max(100_000), show: z.boolean().default(true) }),
    run: async ({ code, show }) => {
      const result = await runSandboxed(code, { runtimeDir: deps.runtimeDir(), dataDir: deps.boards.open?.data.dataDir ?? null, netGuard: deps.netGuard() })
      let placed = false
      if (show && (result.svg || result.html)) {
        await deps.hub.rpc('canvas.card', { svg: result.svg, html: result.html })
        placed = true
      }
      const parts = [result.timedOut ? 'Timed out after 10s.' : result.ok ? 'Ran successfully.' : 'Failed.']
      if (result.stdout) parts.push(`stdout:\n${result.stdout}`)
      if (result.stderr) parts.push(`stderr:\n${result.stderr}`)
      if (placed) parts.push('The output is on the canvas.')
      return { text: parts.join('\n'), isError: !result.ok }
    },
  })
}
