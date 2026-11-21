/**
 * Design tokens. The single source of truth for every color, size, radius and
 * shadow in the app. Plugins read these through `api.design`; they never write
 * their own color or size literals (the design lint rejects them).
 */

export const font = {
  sans: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Inter", "Segoe UI Variable", system-ui, sans-serif',
  mono: '"SF Mono", "JetBrains Mono", ui-monospace, "Cascadia Mono", Consolas, monospace',
  size: { xs: 11, sm: 13, md: 15, lg: 20, xl: 28, display: 44 },
  weight: { regular: 400, medium: 500, semibold: 600 },
  lineHeight: { tight: 1.15, normal: 1.4 },
  tracking: { tight: '-0.01em', normal: '0em', wide: '0.02em' },
} as const

export const space = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 24, 6: 32, 7: 48 } as const
export const radius = { sm: 10, md: 16, lg: 20, pill: 999 } as const

export interface ThemeColors {
  background: string
  /** Behind the 3D scene. */
  stage: string
  surface: string
  surfaceStrong: string
  hairline: string
  hairlineStrong: string
  textPrimary: string
  textSecondary: string
  textTertiary: string
  accent: string
  accentSoft: string
  danger: string
  success: string
}

export type ThemeName = 'glass' | 'projector'

export interface Theme {
  name: ThemeName
  colors: ThemeColors
  blur: string
  shadow: string
  shadowSoft: string
  typeScale: number
  hairlineWidth: number
}

/** Control window and monitors: translucent glass over native Mica/vibrancy. */
const glass: Theme = {
  name: 'glass',
  colors: {
    background: 'rgba(14, 14, 18, 0.35)',
    stage: '#0F0F13',
    surface: 'rgba(30, 30, 36, 0.52)',
    surfaceStrong: 'rgba(36, 36, 42, 0.78)',
    hairline: 'rgba(255, 255, 255, 0.10)',
    hairlineStrong: 'rgba(255, 255, 255, 0.18)',
    textPrimary: 'rgba(255, 255, 255, 0.94)',
    textSecondary: 'rgba(235, 235, 245, 0.62)',
    textTertiary: 'rgba(235, 235, 245, 0.36)',
    accent: '#0A84FF',
    accentSoft: 'rgba(10, 132, 255, 0.22)',
    danger: '#FF453A',
    success: '#30D158',
  },
  blur: 'blur(24px) saturate(180%)',
  shadow: '0 24px 64px rgba(0, 0, 0, 0.38), 0 2px 8px rgba(0, 0, 0, 0.22)',
  shadowSoft: '0 8px 28px rgba(0, 0, 0, 0.28)',
  typeScale: 1,
  hairlineWidth: 1,
}

/** Output window on a wall: solid black, bright hairlines, larger type, no blur. */
const projector: Theme = {
  name: 'projector',
  colors: {
    background: '#000000',
    stage: '#000000',
    surface: '#000000',
    surfaceStrong: '#0A0A0C',
    hairline: 'rgba(255, 255, 255, 0.55)',
    hairlineStrong: 'rgba(255, 255, 255, 0.85)',
    textPrimary: '#FFFFFF',
    textSecondary: 'rgba(255, 255, 255, 0.82)',
    textTertiary: 'rgba(255, 255, 255, 0.6)',
    accent: '#2997FF',
    accentSoft: 'rgba(41, 151, 255, 0.35)',
    danger: '#FF6961',
    success: '#4CE07A',
  },
  blur: 'none',
  shadow: 'none',
  shadowSoft: 'none',
  typeScale: 1.25,
  hairlineWidth: 1.5,
}

export const themes: Record<ThemeName, Theme> = { glass, projector }

/**
 * Fixed meaning colors. A kind of data keeps its color everywhere: in the 3D
 * scene, in plots, in diagrams and in explainers. Never reuse one for
 * something else.
 */
export const dataColors = {
  // Robot sensors and signals
  lidar: '#64D2FF',
  encoder: '#FFD60A',
  imu: '#BF5AF2',
  camera: '#FF9F0A',
  odometry: '#30D158',
  power: '#FF6961',
  // Explainer concepts
  state: '#7D7AFF',
  observation: '#66D4CF',
  belief: '#DA8FFF',
  action: '#FF6482',
  reward: '#FFD426',
  transition: '#98989D',
  // Neutral fallback for anything without a meaning yet
  neutral: '#AEAEB2',
} as const

export type DataKind = keyof typeof dataColors

export function dataColor(kind: string): string {
  return (dataColors as Record<string, string>)[kind] ?? dataColors.neutral
}

/** Guess a data kind from a topic name like `titan/left_encoder`. */
export function kindForTopic(topic: string): DataKind {
  const t = topic.toLowerCase()
  if (t.includes('lidar') || t.includes('scan') || t.includes('points')) return 'lidar'
  if (t.includes('encoder') || t.includes('ticks')) return 'encoder'
  if (t.includes('imu')) return 'imu'
  if (t.includes('camera') || t.includes('image')) return 'camera'
  if (t.includes('odom')) return 'odometry'
  if (t.includes('battery') || t.includes('power')) return 'power'
  return 'neutral'
}

/** Font size in px for the given step, scaled for the active theme. */
export function typeSize(theme: Theme, step: keyof typeof font.size): number {
  return Math.round(font.size[step] * theme.typeScale)
}

export const design = { font, space, radius, themes, dataColors, dataColor, kindForTopic, typeSize } as const
export type Design = typeof design
