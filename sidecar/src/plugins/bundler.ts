import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { build, type Plugin } from 'esbuild'

/**
 * Modules the app provides at runtime. Plugins import them normally; the
 * bundle reads them from globalThis.__WB_CORE__ so there is exactly one React,
 * one three.js and one tldraw in the page.
 */
export const CORE_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'three',
  '@react-three/fiber',
  '@react-three/drei',
  'tldraw',
  '@wb/sdk',
  'zod',
  'motion/react',
] as const

const slash = (p: string) => p.split('\\').join('/')
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
const CORE_FILTER = new RegExp(`^(${CORE_MODULES.map(escapeRe).join('|')})$`)

const coreExternals: Plugin = {
  name: 'wb-core-externals',
  setup(b) {
    b.onResolve({ filter: CORE_FILTER }, (args) => ({ path: args.path, namespace: 'wb-core' }))
    b.onLoad({ filter: /.*/, namespace: 'wb-core' }, (args) => ({
      contents: `const m = globalThis.__WB_CORE__ && globalThis.__WB_CORE__[${JSON.stringify(args.path)}];
if (!m) throw new Error('core module ${args.path} is not available');
module.exports = m;`,
      loader: 'js',
    }))
  },
}

const blockNode: Plugin = {
  name: 'wb-no-node-in-frontend',
  setup(b) {
    b.onResolve({ filter: /^(node:|fs$|path$|child_process$|net$|http$|https$|os$)/ }, (args) => ({
      errors: [{ text: `"${args.path}" is not available in plugin frontends. Use a backend adapter for file or system access.` }],
    }))
  },
}

export async function bundleFrontend(pluginDir: string, entry: string): Promise<string> {
  const result = await build({
    entryPoints: [join(pluginDir, entry)],
    absWorkingDir: pluginDir,
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    sourcemap: 'inline',
    logLevel: 'silent',
    plugins: [coreExternals, blockNode],
    loader: { '.svg': 'text', '.json': 'json' },
  })
  const out = result.outputFiles[0]
  if (!out) throw new Error('esbuild produced no output')
  return out.text
}

/**
 * Bundle a backend adapter together with the adapter runtime into one file.
 * The child process then needs read access to that file and the board's data only.
 */
export async function bundleAdapter(pluginDir: string, entry: string, runtimeEntry: string): Promise<string> {
  const buildDir = join(pluginDir, '.build')
  await mkdir(buildDir, { recursive: true })
  const wrapper = join(buildDir, 'adapter-entry.mjs')
  await writeFile(
    wrapper,
    `import adapter from ${JSON.stringify(slash(join(pluginDir, entry)))}
import { runAdapter } from ${JSON.stringify(slash(runtimeEntry))}
runAdapter(adapter)
`,
    'utf8',
  )
  const outfile = join(buildDir, 'adapter.mjs')
  await build({
    entryPoints: [wrapper],
    bundle: true,
    outfile,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    logLevel: 'silent',
    banner: { js: "import { createRequire as __wbCreateRequire } from 'node:module'; const require = __wbCreateRequire(import.meta.url);" },
  })
  return outfile
}
