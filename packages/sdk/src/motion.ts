/**
 * Motion presets. Every animation in the app uses one of these. Springs are
 * critically damped (no overshoot, nothing bouncy) and settle in 200-400ms.
 */

export interface SpringConfig {
  stiffness: number
  damping: number
  mass: number
}

/** damping = 2 * sqrt(stiffness * mass) gives a critically damped spring. */
export function critical(stiffness: number, mass = 1): SpringConfig {
  return { stiffness, damping: 2 * Math.sqrt(stiffness * mass), mass }
}

export const springs = {
  /** ~200ms. Small UI changes: hover, toggles. */
  snappy: critical(420),
  /** ~300ms. Panels and shapes entering. */
  standard: critical(260),
  /** ~400ms. Larger moves: explode, focus dimming. */
  gentle: critical(160),
} as const

export type SpringName = keyof typeof springs

export const durations = { fast: 200, base: 300, slow: 400 } as const

/** Apple-style ease for anything that is not a spring (CSS, SVG strokes). */
export const easingCurves = {
  standard: [0.25, 0.1, 0.25, 1] as [number, number, number, number],
  out: [0.2, 0.8, 0.2, 1] as [number, number, number, number],
}

export const easing = {
  standard: `cubic-bezier(${easingCurves.standard.join(', ')})`,
  out: `cubic-bezier(${easingCurves.out.join(', ')})`,
} as const

export const presets = {
  enter: { spring: 'standard' as SpringName, fromOpacity: 0, fromY: 4, fromScale: 0.985 },
  exit: { spring: 'snappy' as SpringName, toOpacity: 0, toY: 4 },
  focus: { spring: 'gentle' as SpringName, dimOpacity: 0.16 },
  reveal: { lineMs: durations.base, labelDelayMs: 240, labelMs: durations.fast },
  stagger: { groupSize: 3, gapMs: 60 },
  /** Seconds for camera-controls smoothTime. Roughly a 0.6s flight. */
  cameraFlight: { smoothTime: 0.32 },
} as const

/** Delay in ms for item `index` when staggering a list in small groups. */
export function staggerDelay(index: number, groupSize: number = presets.stagger.groupSize, gapMs: number = presets.stagger.gapMs): number {
  if (index < 0 || groupSize < 1) return 0
  return Math.floor(index / groupSize) * gapMs
}

/** react-spring uses tension/friction; same physics, different names. */
export function toReactSpring(name: SpringName): { tension: number; friction: number; mass: number } {
  const s = springs[name]
  return { tension: s.stiffness, friction: s.damping, mass: s.mass }
}

/** Framer Motion transition object for a named spring. */
export function toFramer(name: SpringName, delayMs = 0): { type: 'spring'; stiffness: number; damping: number; mass: number; delay: number } {
  const s = springs[name]
  return { type: 'spring', stiffness: s.stiffness, damping: s.damping, mass: s.mass, delay: delayMs / 1000 }
}

/** CSS transition string for a property, using a named duration and the standard ease. */
export function cssTransition(property: string, duration: keyof typeof durations = 'base'): string {
  return `${property} ${durations[duration]}ms ${easing.standard}`
}

/**
 * Advance a critically damped spring by dt seconds. Used by the 3D scene for
 * per-frame smoothing (encoder wheel, IMU tilt) so 3D and DOM share physics.
 */
export function stepSpring(current: number, velocity: number, target: number, dt: number, name: SpringName = 'standard'): [number, number] {
  const { stiffness, damping, mass } = springs[name]
  const h = Math.min(dt, 1 / 30)
  const force = -stiffness * (current - target) - damping * velocity
  const v = velocity + (force / mass) * h
  return [current + v * h, v]
}

export const motionTokens = { springs, durations, easing, easingCurves, presets, staggerDelay, toReactSpring, toFramer, cssTransition, stepSpring } as const
export type MotionTokens = typeof motionTokens
