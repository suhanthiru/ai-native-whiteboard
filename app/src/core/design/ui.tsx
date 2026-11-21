import type { CSSProperties, ReactNode } from 'react'
import { motion } from 'motion/react'
import { presets, toFramer } from '@wb/sdk'

interface GlassPanelProps {
  title?: ReactNode
  actions?: ReactNode
  children?: ReactNode
  strong?: boolean
  className?: string
  /** Layout only (position, size). Colors and timings come from the theme. */
  layout?: Pick<CSSProperties, 'position' | 'top' | 'left' | 'right' | 'bottom' | 'width' | 'height' | 'maxHeight' | 'zIndex' | 'transform'>
  testId?: string
}

/** The one panel style. Translucent glass on monitors, solid black on the projector. */
export function GlassPanel({ title, actions, children, strong, className, layout, testId }: GlassPanelProps) {
  const e = presets.enter
  return (
    <motion.div
      className={`wb-glass ${strong ? 'wb-glass--strong' : ''} ${className ?? ''}`}
      style={{ ...layout, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
      initial={{ opacity: e.fromOpacity, y: e.fromY, scale: e.fromScale }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: presets.exit.toOpacity, y: presets.exit.toY }}
      transition={toFramer(e.spring)}
      data-testid={testId}
    >
      {title !== undefined && (
        <div className="wb-panel-header">
          <span>{title}</span>
          {actions && <span style={{ display: 'flex', gap: 6 }}>{actions}</span>}
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>{children}</div>
    </motion.div>
  )
}

type TextSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'display'

interface TextProps {
  size?: TextSize
  tone?: 'primary' | 'muted' | 'faint'
  mono?: boolean
  children?: ReactNode
}

export function Text({ size = 'md', tone = 'primary', mono, children }: TextProps) {
  const toneClass = tone === 'muted' ? 'wb-muted' : tone === 'faint' ? 'wb-faint' : ''
  return <span className={`wb-text-${size} ${toneClass} ${mono ? 'wb-mono' : ''}`}>{children}</span>
}

interface ButtonProps {
  children?: ReactNode
  onClick?: () => void
  variant?: 'default' | 'primary' | 'danger'
  icon?: boolean
  pressed?: boolean
  title?: string
  testId?: string
}

export function Button({ children, onClick, variant = 'default', icon, pressed, title, testId }: ButtonProps) {
  const cls = ['wb-button', variant !== 'default' ? `wb-button--${variant}` : '', icon ? 'wb-button--icon' : ''].join(' ')
  return (
    <button type="button" className={cls} onClick={onClick} aria-pressed={pressed} title={title} aria-label={title} data-testid={testId}>
      {children}
    </button>
  )
}

interface SegmentedProps<T extends string> {
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
}

export function Segmented<T extends string>({ value, options, onChange }: SegmentedProps<T>) {
  return (
    <div className="wb-segmented wb-glass wb-glass--pill" role="group">
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}
