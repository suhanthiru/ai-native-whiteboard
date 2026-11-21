/** Installs npm dependencies of every shared plugin (install scripts disabled). */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const root = join(process.cwd(), 'plugins')
for (const name of existsSync(root) ? readdirSync(root) : []) {
  const dir = join(root, name)
  if (!existsSync(join(dir, 'package.json'))) continue
  process.stdout.write(`installing ${name}\n`)
  const r = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--omit=dev'], { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' })
  if (r.status !== 0) process.exit(r.status ?? 1)
}
