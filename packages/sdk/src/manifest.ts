import { z } from 'zod'

/** A plugin name doubles as its folder name and tool namespace. */
export const pluginNameSchema = z
  .string()
  .min(2)
  .max(48)
  .regex(/^[a-z][a-z0-9-]*$/, 'lowercase letters, digits and dashes, starting with a letter')

export const requirementSchema = z.object({
  type: z.enum(['mcap', 'glb', 'pointcloud', 'file']),
  /** For mcap: topics that must exist in at least one file. */
  topics: z.array(z.string().min(1)).optional(),
  /** Glob-ish pattern matched against file names in data/, e.g. "*.mcap". */
  pattern: z.string().min(1).optional(),
  /** Shown to the user when the requirement is not met. */
  hint: z.string().optional(),
})

/** A skill tree is a domain ("chemistry", "trees", "robotics", "video"); skills grow it by building on each other. */
export const treeNameSchema = z
  .string()
  .min(2)
  .max(48)
  .regex(/^[a-z][a-z0-9-]*$/, 'lowercase letters, digits and dashes, starting with a letter')

export const SKILL_PREVIEW_VIEWS = ['scene', 'canvas', 'none'] as const

/** Where a plugin sits in the skill trees, and how it is explained and previewed. */
export const skillMetaSchema = z.object({
  /** The tree (domain) this skill belongs to. */
  tree: treeNameSchema.default('general'),
  /** Skills this one builds on (their tools it calls or extends). Can be in other trees. */
  parents: z.array(pluginNameSchema).max(12).default([]),
  /** Plain-language explainer shown in the skill viewer: what it does and how to ask for it. */
  explainer: z.string().max(1200).default(''),
  /** Things the user could say to use it, e.g. "show me a carbon atom". */
  examples: z.array(z.string().min(1).max(160)).max(8).default([]),
  /** What the 5-second preview records: the 3D scene, the canvas, or nothing. */
  preview: z.enum(SKILL_PREVIEW_VIEWS).default('scene'),
})

export type SkillMeta = z.infer<typeof skillMetaSchema>

export const DEFAULT_SKILL_META: SkillMeta = { tree: 'general', parents: [], explainer: '', examples: [], preview: 'scene' }

export const manifestSchema = z.object({
  name: pluginNameSchema,
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'semver like 1.0.0'),
  description: z.string().min(1).max(280),
  adds: z
    .object({
      shapes: z.array(z.string()).default([]),
      panels: z.array(z.string()).default([]),
      tools: z.array(z.string()).default([]),
      dataSources: z.array(z.string()).default([]),
    })
    .default({ shapes: [], panels: [], tools: [], dataSources: [] }),
  requires: z.array(requirementSchema).default([]),
  frontend: z.string().default('index.tsx'),
  backend: z.string().optional(),
  test: z.string().default('plugin.test.ts'),
  /** Backend adapters have no network unless they declare it (e.g. a live ROS 2 bridge). */
  permissions: z.object({ network: z.boolean().default(false) }).default({ network: false }),
  skill: skillMetaSchema.default(DEFAULT_SKILL_META),
})

export type PluginManifest = z.infer<typeof manifestSchema>
export type PluginRequirement = z.infer<typeof requirementSchema>

export function parseManifest(raw: unknown): { ok: true; manifest: PluginManifest } | { ok: false; error: string } {
  const result = manifestSchema.safeParse(raw)
  if (result.success) return { ok: true, manifest: result.data }
  const error = result.error.issues.map((i) => `${i.path.join('.') || 'manifest'}: ${i.message}`).join('; ')
  return { ok: false, error }
}

/** Tool names Claude sees: plugin.<plugin>.<tool> becomes plugin_<plugin>_<tool> (MCP names avoid dots). */
export function pluginToolName(plugin: string, tool: string): string {
  return `plugin_${plugin.replace(/-/g, '_')}_${tool}`
}
