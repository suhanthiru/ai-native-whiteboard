import { z } from 'zod'
import { normaliseBoardPath, pluginNameSchema } from '@wb/sdk'

const relativeDataPath = z.string().refine((p) => normaliseBoardPath(p) !== null, 'must be a relative path inside data/')

export const boardSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase folder-style name'),
  title: z.string().min(1).optional(),
  aliases: z.array(z.string().min(1)).default([]),
  description: z.string().optional(),
  /** Model shown when the board opens, e.g. "data/titan.glb". */
  model: relativeDataPath.optional(),
  /** Empty means every available shared plugin. */
  enabledPlugins: z.array(pluginNameSchema).default([]),
  pluginConfig: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
})

export type BoardFile = z.infer<typeof boardSchema>

export const lockSchema = z.object({
  version: z.literal(1),
  files: z.array(
    z.object({
      path: z.string(),
      size: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  ),
})

export type LockFile = z.infer<typeof lockSchema>
