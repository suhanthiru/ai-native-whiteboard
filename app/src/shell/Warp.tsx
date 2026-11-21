import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { WarpCorners } from '@wb/sdk'
import { sidecar } from '../core/rpc/client'
import { IDENTITY_CORNERS, warpTransform } from './keystone'

const HANDLE = 28
const NUDGE = 0.002

interface WarpProps {
  corners: WarpCorners | null
  calibrating: boolean
  children: ReactNode
}

function useSize(): { w: number; h: number } {
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight })
  useEffect(() => {
    const on = () => setSize({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  return size
}

/**
 * Output window keystone. K toggles calibration, drag the corners (or select
 * one with 1-4 and nudge with arrow keys), R resets. Saved by the sidecar.
 */
export function Warp({ corners, calibrating, children }: WarpProps) {
  const { w, h } = useSize()
  const [draft, setDraft] = useState<WarpCorners | null>(null)
  const [selected, setSelected] = useState(0)
  const dragging = useRef<number | null>(null)
  const current = draft ?? corners ?? IDENTITY_CORNERS
  const commit = (next: WarpCorners) => {
    setDraft(null)
    sidecar.send({ type: 'warp', corners: next })
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase()
      if (key === 'k') sidecar.send({ type: 'calibrate', on: !calibrating })
      if (!calibrating) return
      if (key === 'r') commit(IDENTITY_CORNERS)
      if (['1', '2', '3', '4'].includes(key)) setSelected(Number(key) - 1)
      const d = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] }[key]
      if (d) {
        e.preventDefault()
        const step = e.shiftKey ? NUDGE * 10 : NUDGE
        const next = current.map((c, i) => (i === selected ? { x: c.x + (d[0] ?? 0) * step, y: c.y + (d[1] ?? 0) * step } : c)) as WarpCorners
        commit(next)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const onPointerMove = (e: React.PointerEvent) => {
    const i = dragging.current
    if (i === null) return
    const next = current.map((c, j) => (j === i ? { x: e.clientX / w, y: e.clientY / h } : c)) as WarpCorners
    setDraft(next)
  }
  const onPointerUp = () => {
    if (dragging.current !== null && draft) commit(draft)
    dragging.current = null
  }

  const transform = warpTransform(draft ?? corners, w, h)
  return (
    <div style={{ position: 'fixed', inset: 0, overflow: 'hidden', background: 'var(--wb-bg)' }} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
      <div style={{ position: 'absolute', left: 0, top: 0, width: w, height: h, transformOrigin: '0 0', transform }} data-testid="warp-root">
        {children}
      </div>
      {calibrating && (
        <>
          <svg style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} width={w} height={h}>
            <polygon points={current.map((c) => `${c.x * w},${c.y * h}`).join(' ')} fill="none" stroke="var(--wb-accent)" strokeWidth={2} />
          </svg>
          {current.map((c, i) => (
            <div
              key={i}
              onPointerDown={(e) => {
                ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
                dragging.current = i
                setSelected(i)
              }}
              style={{
                position: 'absolute',
                left: c.x * w - HANDLE / 2,
                top: c.y * h - HANDLE / 2,
                width: HANDLE,
                height: HANDLE,
                borderRadius: '50%',
                border: '2px solid var(--wb-accent)',
                background: i === selected ? 'var(--wb-accent)' : 'var(--wb-bg)',
                cursor: 'grab',
              }}
              data-testid={`warp-handle-${i}`}
            />
          ))}
          <div className="wb-text-md" style={{ position: 'absolute', left: '50%', top: 24, transform: 'translateX(-50%)', color: 'var(--wb-text)' }}>
            Keystone: drag corners or 1-4 + arrows · R reset · K done
          </div>
        </>
      )}
    </div>
  )
}
