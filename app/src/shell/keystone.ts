/**
 * Keystone warp: a projective transform (homography) that maps the output
 * window's rectangle onto four corner points, applied as a CSS matrix3d on
 * the output root. It warps the DOM and the 3D canvas together, last.
 */
import type { Corner, WarpCorners } from '@wb/sdk'

export type Mat3 = [number, number, number, number, number, number, number, number, number]

export const IDENTITY_CORNERS: WarpCorners = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
]

/** Solve A x = b with Gaussian elimination and partial pivoting. */
function solve(a: number[][], b: number[]): number[] | null {
  const n = b.length
  const m = a.map((row, i) => [...row, b[i] ?? 0])
  for (let col = 0; col < n; col += 1) {
    let pivot = col
    for (let r = col + 1; r < n; r += 1) if (Math.abs(m[r]?.[col] ?? 0) > Math.abs(m[pivot]?.[col] ?? 0)) pivot = r
    if (Math.abs(m[pivot]?.[col] ?? 0) < 1e-12) return null
    const tmp = m[col]
    m[col] = m[pivot] as number[]
    m[pivot] = tmp as number[]
    const pivotRow = m[col] as number[]
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue
      const row = m[r] as number[]
      const f = (row[col] ?? 0) / (pivotRow[col] ?? 1)
      for (let c = col; c <= n; c += 1) row[c] = (row[c] ?? 0) - f * (pivotRow[c] ?? 0)
    }
  }
  return m.map((row, i) => (row[n] ?? 0) / (row[i] ?? 1))
}

/** Homography H with H * src[i] ~ dst[i]. Returns null for degenerate quads. */
export function homography(src: Corner[], dst: Corner[]): Mat3 | null {
  if (src.length !== 4 || dst.length !== 4) return null
  const a: number[][] = []
  const b: number[] = []
  for (let i = 0; i < 4; i += 1) {
    const { x, y } = src[i] as Corner
    const { x: u, y: v } = dst[i] as Corner
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y])
    b.push(u)
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y])
    b.push(v)
  }
  const h = solve(a, b)
  if (!h) return null
  return [h[0] ?? 0, h[1] ?? 0, h[2] ?? 0, h[3] ?? 0, h[4] ?? 0, h[5] ?? 0, h[6] ?? 0, h[7] ?? 0, 1]
}

export function applyHomography(h: Mat3, p: Corner): Corner {
  const w = h[6] * p.x + h[7] * p.y + h[8]
  return { x: (h[0] * p.x + h[1] * p.y + h[2]) / w, y: (h[3] * p.x + h[4] * p.y + h[5]) / w }
}

/** CSS matrix3d (column-major 4x4) for a 2D homography, with transform-origin 0 0. */
export function toMatrix3d(h: Mat3): string {
  const m = [h[0], h[3], 0, h[6], h[1], h[4], 0, h[7], 0, 0, 1, 0, h[2], h[5], 0, h[8]]
  return `matrix3d(${m.map((v) => (Math.abs(v) < 1e-12 ? 0 : v)).join(',')})`
}

export function warpTransform(corners: WarpCorners | null, width: number, height: number): string | undefined {
  if (!corners) return undefined
  const src: Corner[] = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ]
  const dst = corners.map((c) => ({ x: c.x * width, y: c.y * height }))
  const h = homography(src, dst)
  return h ? toMatrix3d(h) : undefined
}
