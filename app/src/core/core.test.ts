import { describe, expect, it } from 'vitest'
import { planExplode, clampExplode } from './scene/explode'
import { isMeaningfulName } from './scene/registry'
import { applyHomography, homography, IDENTITY_CORNERS, toMatrix3d, warpTransform } from '../shell/keystone'
import { themeToCssVars } from './design/theme'
import { themes } from '@wb/sdk'

describe('explode plan', () => {
  it('moves parts away from the centre, farthest first, in staggered groups', () => {
    const plan = planExplode([0, 0, 0], 1, [
      { name: 'near', center: [0.1, 0, 0] },
      { name: 'far', center: [0, 0, 0.9] },
      { name: 'mid', center: [0, 0.5, 0] },
      { name: 'core', center: [0, 0, 0] },
    ])
    expect(plan.map((p) => p.name)).toEqual(['far', 'mid', 'near', 'core'])
    expect(plan[0]?.offset[2]).toBeGreaterThan(0.9)
    expect(plan[3]?.delayMs).toBeGreaterThan(0)
    // A part at the centre still lifts a little so nothing overlaps.
    expect(plan[3]?.offset[1]).toBeGreaterThan(0)
  })

  it('clamps the amount', () => {
    expect(clampExplode(2)).toBe(1)
    expect(clampExplode(-1)).toBe(0)
    expect(clampExplode(Number.NaN)).toBe(0)
  })
})

describe('part names', () => {
  it('ignores generic exporter names', () => {
    expect(isMeaningfulName('left_encoder')).toBe(true)
    expect(isMeaningfulName('Mesh001')).toBe(false)
    expect(isMeaningfulName('Scene')).toBe(false)
    expect(isMeaningfulName('')).toBe(false)
  })
})

describe('keystone warp', () => {
  it('maps the unit square onto the given corners', () => {
    const dst = [
      { x: 10, y: 20 },
      { x: 110, y: 10 },
      { x: 120, y: 90 },
      { x: 0, y: 100 },
    ]
    const h = homography(
      [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
      ],
      dst,
    )
    expect(h).not.toBeNull()
    if (!h) return
    const corners = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ].map((p) => applyHomography(h, p))
    corners.forEach((c, i) => {
      expect(c.x).toBeCloseTo(dst[i]?.x ?? 0)
      expect(c.y).toBeCloseTo(dst[i]?.y ?? 0)
    })
    expect(toMatrix3d(h)).toMatch(/^matrix3d\(/)
  })

  it('is the identity for untouched corners and none without calibration', () => {
    expect(warpTransform(IDENTITY_CORNERS, 800, 600)).toBe('matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)')
    expect(warpTransform(null, 800, 600)).toBeUndefined()
  })

  it('refuses a degenerate quad', () => {
    const p = { x: 0, y: 0 }
    expect(homography([p, p, p, p], [p, p, p, p])).toBeNull()
  })
})

describe('theme CSS variables', () => {
  it('derives every variable from tokens', () => {
    const vars = themeToCssVars(themes.projector)
    expect(vars['--wb-bg']).toBe('#000000')
    expect(vars['--wb-blur']).toBe('none')
    expect(vars['--wb-fs-md']).toBe('19px')
  })
})
