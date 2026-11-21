/**
 * Copies plugins/ and the demo board into .wb/e2e so the E2E run has its own
 * approvals and canvas. node_modules folders are linked (junctions), not copied.
 * Runs before the E2E sidecar starts (see playwright.config.ts).
 */
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const OUT = join(ROOT, '.wb', 'e2e')

/** Remove links before deleting the tree, so deletion can never follow them into the real plugins. */
function unlinkJunctions(dir: string): void {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    const link = join(dir, name, 'node_modules')
    try {
      if (lstatSync(link).isSymbolicLink()) unlinkSync(link)
    } catch {
      // no node_modules link in this plugin
    }
  }
}

export function prepareE2e(): void {
  unlinkJunctions(join(OUT, 'plugins'))
  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(join(OUT, 'plugins'), { recursive: true })
  for (const name of readdirSync(join(ROOT, 'plugins'))) {
    const src = join(ROOT, 'plugins', name)
    if (!existsSync(join(src, 'manifest.json'))) continue
    const dest = join(OUT, 'plugins', name)
    cpSync(src, dest, { recursive: true, filter: (p) => !/[\\/](node_modules|\.build)([\\/]|$)/.test(p.slice(src.length)) })
    if (existsSync(join(src, 'node_modules'))) symlinkSync(join(src, 'node_modules'), join(dest, 'node_modules'), 'junction')
  }
  cpSync(join(ROOT, 'boards', 'titan-demo'), join(OUT, 'boards', 'titan-demo'), { recursive: true, filter: (p) => !p.endsWith('canvas.json') })
  if (!existsSync(join(OUT, 'boards', 'titan-demo', 'data', 'titan.glb'))) {
    throw new Error('Demo data missing: run `npm run make:demo` first.')
  }
}

prepareE2e()
