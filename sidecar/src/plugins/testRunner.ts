import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const TEST_TIMEOUT_MS = 120_000
const OUTPUT_TAIL = 2400

export interface TestOutcome {
  passed: boolean
  output: string
}

function stripAnsi(text: string): string {
  // eslint-free ANSI escape removal
  return text.replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g'), '')
}

/** Only what node and vitest need: no API keys or tokens from the parent environment. */
export function scrubbedEnv(): NodeJS.ProcessEnv {
  const keep = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'COMSPEC', 'PATHEXT']
  const env: NodeJS.ProcessEnv = { CI: '1', FORCE_COLOR: '0', NODE_ENV: 'test' }
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k]
  return env
}

/** Run a plugin's test file with vitest. A plugin is only kept when this passes. */
export function runPluginTest(rootDir: string, pluginDir: string, testFile: string): Promise<TestOutcome> {
  const test = join(pluginDir, testFile)
  if (!existsSync(test)) return Promise.resolve({ passed: false, output: `${testFile} is missing; every plugin needs a test.` })
  const vitest = join(rootDir, 'node_modules', 'vitest', 'vitest.mjs')
  const config = join(rootDir, 'vitest.plugins.config.ts')
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [vitest, 'run', '--config', config, '--root', pluginDir, '--reporter=default', testFile], {
      cwd: pluginDir,
      env: scrubbedEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    const collect = (d: Buffer) => {
      output += d.toString()
      if (output.length > OUTPUT_TAIL * 4) output = output.slice(-OUTPUT_TAIL * 2)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    const timer = setTimeout(() => {
      child.kill()
      output += '\n(test timed out)'
    }, TEST_TIMEOUT_MS)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ passed: code === 0, output: stripAnsi(output).slice(-OUTPUT_TAIL).trim() })
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ passed: false, output: `could not start vitest: ${error.message}` })
    })
  })
}
