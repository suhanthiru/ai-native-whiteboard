/**
 * Design lint. Plugin UI code must take every color from api.design and every
 * timing from api.motion, so AI-written plugins cannot drift from the look.
 * Inline eslint-disable comments are ignored on purpose.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { Linter, type Rule } from 'eslint'
import tsParser from '@typescript-eslint/parser'

export interface LintProblem {
  file: string
  line: number
  column: number
  message: string
}

const COLOR_PATTERN = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb)\s*\(/i
const DURATION_PATTERN = /^\s*-?\d+(?:\.\d+)?\s*m?s\s*$/i
const CSS_TRANSITION_PATTERN = /\b\d+(?:\.\d+)?m?s\b.*\b(?:ease|linear|cubic-bezier)|\b(?:ease|linear|cubic-bezier)\b.*\b\d+(?:\.\d+)?m?s\b/i
const TIMING_KEYS = new Set(['duration', 'delay', 'transitionDuration', 'transitionDelay', 'animationDuration', 'animationDelay', 'stiffness', 'damping', 'mass', 'tension', 'friction', 'ease', 'easing', 'bounce', 'restDelta', 'smoothTime'])
const COLOR_KEYS = new Set(['color', 'background', 'backgroundColor', 'borderColor', 'border', 'fill', 'stroke', 'boxShadow', 'outline', 'outlineColor', 'textShadow', 'caretColor', 'accentColor'])
const CSS_KEYWORDS = new Set(['inherit', 'initial', 'unset', 'currentcolor', 'transparent', 'none', ''])
const TIMER_ALLOW_COMMENT = 'wb-allow-timer'

type Node = Rule.Node & Record<string, unknown>

function keyName(prop: Node): string | null {
  const key = prop.key as (Node & { name?: string; value?: unknown }) | undefined
  if (!key) return null
  if (key.type === 'Identifier') return String(key.name)
  if (key.type === 'Literal' && typeof key.value === 'string') return key.value
  return null
}

const designRule: Rule.RuleModule = {
  meta: { type: 'problem', schema: [] },
  create(context) {
    const source = context.sourceCode
    const checkString = (node: Rule.Node, value: string) => {
      if (COLOR_PATTERN.test(value)) context.report({ node, message: `Color literal "${value.slice(0, 40)}". Use api.design (theme colors or dataColor(kind)).` })
      else if (DURATION_PATTERN.test(value) || CSS_TRANSITION_PATTERN.test(value)) context.report({ node, message: `Timing literal "${value.slice(0, 40)}". Use api.motion presets.` })
    }
    return {
      Literal(node) {
        const v = (node as unknown as { value: unknown }).value
        if (typeof v === 'string') checkString(node, v)
      },
      TemplateElement(node) {
        const raw = (node as unknown as { value: { raw: string } }).value.raw
        if (COLOR_PATTERN.test(raw)) context.report({ node, message: 'Color in a template string. Use api.design.' })
      },
      Property(node) {
        const prop = node as unknown as Node
        const name = keyName(prop)
        if (!name) return
        const value = prop.value as Node & { value?: unknown }
        if (TIMING_KEYS.has(name) && value?.type === 'Literal' && typeof value.value === 'number') {
          context.report({ node, message: `"${name}: ${String(value.value)}" hardcodes motion. Use api.motion (springs, presets, durations).` })
        }
        if ((name === 'transition' || name === 'animation') && value?.type === 'Literal') {
          context.report({ node, message: `"${name}" literal. Use api.motion.cssTransition() or the Motion components.` })
        }
        if (COLOR_KEYS.has(name) && value?.type === 'Literal' && typeof value.value === 'string' && !CSS_KEYWORDS.has(value.value.toLowerCase()) && !value.value.startsWith('var(')) {
          context.report({ node, message: `"${name}: ${value.value}" hardcodes a color. Use api.design.` })
        }
      },
      CallExpression(node) {
        const callee = (node as unknown as { callee: Node & { name?: string; property?: { name?: string } } }).callee
        const name = callee.type === 'Identifier' ? callee.name : callee.type === 'MemberExpression' ? callee.property?.name : undefined
        if (name !== 'setTimeout' && name !== 'setInterval') return
        const comments = source.getCommentsBefore(node).concat(source.getCommentsInside(node))
        const line = source.lines[(node.loc?.start.line ?? 1) - 1] ?? ''
        if (comments.some((c) => c.value.includes(TIMER_ALLOW_COMMENT)) || line.includes(TIMER_ALLOW_COMMENT)) return
        context.report({ node, message: `${name} in UI code. Animate with api.motion; for data use api.subscribe. If this timer is not animation, add a // ${TIMER_ALLOW_COMMENT}: <reason> comment.` })
      },
    }
  },
}

const linter = new Linter({ configType: 'flat' })

const config: Linter.Config[] = [
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.mjs'],
    languageOptions: {
      parser: tsParser as unknown as Linter.Parser,
      parserOptions: { ecmaFeatures: { jsx: true }, sourceType: 'module' },
    },
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'off' },
    plugins: { wb: { rules: { design: designRule } } },
    rules: { 'wb/design': 'error' },
  },
]

export function lintSource(code: string, filename: string): LintProblem[] {
  return linter.verify(code, config, { filename }).map((m) => ({ file: filename, line: m.line, column: m.column, message: m.message }))
}

const SOURCE_EXT = /\.(tsx?|jsx?|mjs)$/
const SKIP_DIRS = new Set(['node_modules', '.build', 'backend', 'coverage', 'fixtures'])

/** Lint a plugin's UI files. The backend adapter and tests are exempt (no UI). */
export async function lintPlugin(dir: string, exempt: string[]): Promise<LintProblem[]> {
  const problems: LintProblem[] = []
  const exemptSet = new Set(exempt.map((e) => e.replace(/\\/g, '/')))
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (SKIP_DIRS.has(e.name)) continue
      const full = join(d, e.name)
      if (e.isDirectory()) {
        await walk(full)
        continue
      }
      const rel = relative(dir, full).split(sep).join('/')
      if (!SOURCE_EXT.test(e.name) || exemptSet.has(rel) || /\.test\.[tj]sx?$/.test(e.name)) continue
      problems.push(...lintSource(await readFile(full, 'utf8'), rel))
    }
  }
  await walk(dir)
  return problems
}

export function formatProblems(problems: LintProblem[], max = 8): string {
  const shown = problems.slice(0, max).map((p) => `${p.file}:${p.line}:${p.column} ${p.message}`)
  if (problems.length > max) shown.push(`...and ${problems.length - max} more`)
  return shown.join('\n')
}
