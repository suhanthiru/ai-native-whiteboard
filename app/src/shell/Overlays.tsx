import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { presets, toFramer, type ApprovalRequest, type PluginInfo } from '@wb/sdk'
import { onError } from '../core/errors'
import { sidecar } from '../core/rpc/client'
import { Button, GlassPanel } from '../core/design/ui'

const TOAST_MS = 6000
const MAX_TOASTS = 4

interface Toast {
  id: number
  level: 'info' | 'warn' | 'error'
  text: string
}

const enterAnim = { initial: { opacity: 0, y: -presets.enter.fromY, scale: presets.enter.fromScale }, animate: { opacity: 1, y: 0, scale: 1 }, exit: { opacity: 0, scale: presets.enter.fromScale } }

/** Approvals first (they block work), then toasts. Top right. */
export function Notices({ approvals }: { approvals: ApprovalRequest[] }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  useEffect(() => {
    let id = 1
    const push = (level: Toast['level'], text: string) => {
      const toast = { id: id++, level, text }
      setToasts((t) => [...t.slice(-(MAX_TOASTS - 1)), toast])
      window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== toast.id)), TOAST_MS) // dismissal timer, not animation
    }
    const offToast = sidecar.on('toast', (m) => push(m.level, m.text))
    const offErr = onError((e) => push('error', `${e.source}: ${e.message}`))
    return () => {
      offToast()
      offErr()
    }
  }, [])

  return (
    <div style={{ position: 'absolute', top: 64, right: 16, width: 360, display: 'flex', flexDirection: 'column', gap: 10, zIndex: 50 }}>
      <AnimatePresence>
        {approvals.map((a) => (
          <motion.div key={a.id} {...enterAnim} transition={toFramer('standard')} className="wb-glass wb-glass--strong" style={{ padding: 16 }} data-testid="approval">
            <div className="wb-text-md" style={{ fontWeight: 600 }}>{a.title}</div>
            <div className="wb-text-sm wb-muted" style={{ whiteSpace: 'pre-wrap', marginTop: 6, maxHeight: 180, overflow: 'auto', userSelect: 'text' }}>
              {a.detail}
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
              <Button onClick={() => sidecar.send({ type: 'approval', id: a.id, approve: false })} testId="approval-no">
                {a.kind === 'plugin' ? 'Discard' : 'Decline'}
              </Button>
              <Button variant="primary" onClick={() => sidecar.send({ type: 'approval', id: a.id, approve: true })} testId="approval-yes">
                {a.kind === 'plugin' ? 'Keep' : a.kind === 'install' ? 'Install' : 'Allow'}
              </Button>
            </div>
          </motion.div>
        ))}
        {toasts.map((t) => (
          <motion.div
            key={`t${t.id}`}
            {...enterAnim}
            transition={toFramer('standard')}
            className="wb-glass"
            style={{ padding: '10px 14px', borderColor: t.level === 'error' ? 'var(--wb-danger)' : undefined, userSelect: 'text' }}
            data-testid="toast"
          >
            <div className="wb-text-sm" style={{ whiteSpace: 'pre-wrap', maxHeight: 120, overflow: 'auto' }}>{t.text}</div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}

const STATE_DOT: Record<PluginInfo['state'], string> = {
  active: 'wb-dot--ok',
  preview: 'wb-dot--warn',
  pending: 'wb-dot--warn',
  disabled: '',
  error: 'wb-dot--bad',
}

export function PluginTray({ plugins, onClose }: { plugins: PluginInfo[]; onClose: () => void }) {
  return (
    <GlassPanel
      title="Plugins"
      actions={<Button icon title="Close" onClick={onClose}>×</Button>}
      layout={{ position: 'absolute', top: 64, left: 16, width: 340, maxHeight: 'calc(100% - 180px)', zIndex: 45 }}
      testId="plugin-tray"
    >
      <ul className="wb-list wb-panel-body" style={{ paddingTop: 4, paddingBottom: 4 }}>
        {plugins.length === 0 && <li className="wb-text-sm wb-muted">No plugins yet.</li>}
        {plugins.map((p) => (
          <li key={p.name} data-testid={`plugin-${p.name}`} data-state={p.state}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className={`wb-dot ${STATE_DOT[p.state]}`} />
              <span className="wb-text-sm" style={{ fontWeight: 600 }}>{p.name}</span>
              <span className="wb-text-xs wb-faint">{p.state}{p.source === 'board' ? ' · board' : ''}</span>
            </div>
            {p.message && <div className="wb-text-xs wb-muted" style={{ marginTop: 4, whiteSpace: 'pre-wrap', userSelect: 'text' }}>{p.message}</div>}
            {p.tools.length > 0 && <div className="wb-text-xs wb-faint wb-mono" style={{ marginTop: 4 }}>{p.tools.join(' ')}</div>}
          </li>
        ))}
      </ul>
    </GlassPanel>
  )
}
