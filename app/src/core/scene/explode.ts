/**
 * Explode math, kept free of three.js so it is easy to test.
 * Each part moves along the vector from the model centre to its own centre.
 */
import { staggerDelay } from '@wb/sdk'

export type V3 = [number, number, number]

export interface PartLayout {
  name: string
  center: V3
}

export interface ExplodePlan {
  name: string
  /** Offset at explode = 1, in world units. */
  offset: V3
  /** Start delay in ms, so parts move a few at a time. */
  delayMs: number
}

const EXPLODE_SCALE = 1.1
/** Parts sitting on the centre still move a little, upwards, so nothing overlaps. */
const MIN_PUSH = 0.15

function length(v: V3): number {
  return Math.hypot(v[0], v[1], v[2])
}

export function planExplode(modelCenter: V3, modelRadius: number, parts: PartLayout[]): ExplodePlan[] {
  const radius = Math.max(modelRadius, 1e-6)
  const withDir = parts.map((p) => {
    const d: V3 = [p.center[0] - modelCenter[0], p.center[1] - modelCenter[1], p.center[2] - modelCenter[2]]
    return { name: p.name, d, dist: length(d) }
  })
  const ordered = [...withDir].sort((a, b) => b.dist - a.dist)
  return ordered.map((p, index) => {
    let offset: V3
    if (p.dist < radius * 0.05) {
      offset = [0, radius * MIN_PUSH, 0]
    } else {
      offset = [p.d[0] * EXPLODE_SCALE, p.d[1] * EXPLODE_SCALE, p.d[2] * EXPLODE_SCALE]
    }
    return { name: p.name, offset, delayMs: staggerDelay(index) }
  })
}

export function clampExplode(amount: number): number {
  if (!Number.isFinite(amount)) return 0
  return Math.min(1, Math.max(0, amount))
}
