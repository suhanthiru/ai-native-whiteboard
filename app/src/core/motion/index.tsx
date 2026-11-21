/**
 * Motion components built on the shared presets in @wb/sdk. Plugins use these
 * (via api.ui) instead of writing their own timings.
 */
import type { ReactNode } from 'react'
import { motion } from 'motion/react'
import { easingCurves, presets, staggerDelay, toFramer } from '@wb/sdk'

interface EnterProps {
  children?: ReactNode
  /** Position in a list; items enter in small staggered groups. */
  index?: number
  className?: string
}

export function Enter({ children, index = 0, className }: EnterProps) {
  const e = presets.enter
  return (
    <motion.div
      className={className}
      initial={{ opacity: e.fromOpacity, y: e.fromY, scale: e.fromScale }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={toFramer(e.spring, staggerDelay(index))}
    >
      {children}
    </motion.div>
  )
}

interface RevealProps {
  children?: ReactNode
  /** Draw a leader line first, then fade the label up (annotation style). */
  line?: { x1: number; y1: number; x2: number; y2: number; color?: string; width?: number }
  className?: string
}

/** Annotate preset: the leader line draws in, then the label fades up. */
export function Reveal({ children, line, className }: RevealProps) {
  const r = presets.reveal
  return (
    <div className={className} style={{ position: 'relative' }}>
      {line && (
        <svg style={{ position: 'absolute', overflow: 'visible', left: 0, top: 0, pointerEvents: 'none' }} width={1} height={1}>
          <motion.line
            x1={line.x1}
            y1={line.y1}
            x2={line.x2}
            y2={line.y2}
            stroke={line.color ?? 'var(--wb-hairline-strong)'}
            strokeWidth={line.width ?? 1}
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: r.lineMs / 1000, ease: easingCurves.standard }}
          />
        </svg>
      )}
      <motion.div
        initial={{ opacity: 0, y: presets.enter.fromY }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ ...toFramer('standard'), delay: (line ? r.labelDelayMs : 0) / 1000 }}
      >
        {children}
      </motion.div>
    </div>
  )
}
