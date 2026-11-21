import { existsSync, readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { WarpCorners } from '@wb/sdk'

const corner = z.object({ x: z.number().min(-1).max(2), y: z.number().min(-1).max(2) })
const fileSchema = z.object({ warp: z.tuple([corner, corner, corner, corner]).nullable() })
const FILE = 'output.json'

/** Keystone calibration for the projector, kept in .wb/output.json (per machine, not in git). */
export function loadWarp(runtimeDir: string): WarpCorners | null {
  const file = join(runtimeDir, FILE)
  if (!existsSync(file)) return null
  try {
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')))
    return parsed.success ? parsed.data.warp : null
  } catch {
    return null
  }
}

export function parseWarp(value: unknown): WarpCorners | null | undefined {
  const parsed = fileSchema.shape.warp.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

export async function saveWarp(runtimeDir: string, warp: WarpCorners | null): Promise<void> {
  await writeFile(join(runtimeDir, FILE), JSON.stringify({ warp }, null, 2) + '\n', 'utf8')
}
