import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { presets, toFramer, type VoiceState } from '@wb/sdk'
import { sidecar } from '../core/rpc/client'
import { reportError } from '../core/errors'
import { Microphone } from './audio'

const PHASE_LABEL: Record<VoiceState['phase'], string> = {
  idle: '',
  listening: 'Listening',
  transcribing: 'Transcribing',
  thinking: 'Thinking',
  speaking: 'Speaking',
  error: '',
}

interface CommandBarProps {
  voice: VoiceState
}

function MicIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  )
}

/** Text commands ("/explode 0.6" or plain language) and push-to-talk. */
export function CommandBar({ voice }: CommandBarProps) {
  const [text, setText] = useState('')
  const mic = useRef(new Microphone())
  const talking = useRef(false)

  const startTalk = useCallback(async () => {
    if (talking.current) return
    talking.current = true
    sidecar.send({ type: 'ptt', state: 'start' })
    try {
      await mic.current.start()
    } catch (error) {
      talking.current = false
      sidecar.send({ type: 'ptt', state: 'cancel' })
      reportError('microphone', error)
    }
  }, [])

  const stopTalk = useCallback(async () => {
    if (!talking.current) return
    talking.current = false
    await mic.current.stop()
    sidecar.send({ type: 'ptt', state: 'stop' })
  }, [])

  // Hold Ctrl+Space anywhere in the window, or the global shortcut from the Tauri shell.
  useEffect(() => {
    const down = (e: globalThis.KeyboardEvent) => {
      if (e.code === 'Space' && e.ctrlKey && !e.repeat) {
        e.preventDefault()
        void startTalk()
      }
    }
    const up = (e: globalThis.KeyboardEvent) => {
      if (e.code === 'Space' || e.key === 'Control') void stopTalk()
    }
    const onPtt = (e: Event) => {
      const state = (e as CustomEvent<string>).detail
      if (state === 'pressed') void startTalk()
      else void stopTalk()
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('wb-ptt', onPtt)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('wb-ptt', onPtt)
    }
  }, [startTalk, stopTalk])

  const submit = () => {
    const value = text.trim()
    if (!value) return
    sidecar.send({ type: 'command', text: value })
    setText('')
  }

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') submit()
    e.stopPropagation() // keep tldraw shortcuts out of the text box
  }

  const status = voice.phase === 'error' ? voice.reply : PHASE_LABEL[voice.phase]
  const showReply = voice.phase === 'speaking' || (voice.phase === 'idle' && voice.reply)

  return (
    <div style={{ position: 'absolute', left: '50%', bottom: 20, transform: 'translateX(-50%)', width: 'min(680px, calc(100% - 32px))', zIndex: 40 }}>
      <AnimatePresence>
        {(status || showReply || voice.activity.length > 0) && (
          <motion.div
            key="status"
            className="wb-glass"
            style={{ padding: '10px 16px', marginBottom: 10, borderRadius: 16 }}
            initial={{ opacity: 0, y: presets.enter.fromY }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: presets.exit.toY }}
            transition={toFramer('standard')}
            data-testid="voice-status"
          >
            {voice.transcript && <div className="wb-text-sm wb-muted">“{voice.transcript}”</div>}
            {status && <div className="wb-text-sm" style={{ marginTop: 2 }}>{status}</div>}
            {voice.activity.length > 0 && voice.phase === 'thinking' && (
              <div className="wb-text-xs wb-faint wb-mono" style={{ marginTop: 4 }}>
                {voice.activity.slice(-3).join('  ·  ')}
              </div>
            )}
            {showReply && <div className="wb-text-md" style={{ marginTop: 4 }}>{voice.reply}</div>}
          </motion.div>
        )}
      </AnimatePresence>
      <div className="wb-glass wb-glass--pill" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 6px 6px 18px' }}>
        <input
          className="wb-input"
          placeholder={voice.available.brain ? 'Ask anything, or /explode 0.6 · hold Ctrl+Space to talk' : '/open titan · /explode 0.6 · /focus left encoder'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          onKeyUp={(e) => e.stopPropagation()}
          data-testid="command-input"
          aria-label="Command"
        />
        <button
          type="button"
          className={`wb-button wb-button--icon ${voice.phase === 'listening' ? 'wb-button--primary' : ''}`}
          title={voice.available.stt ? 'Hold to talk (Ctrl+Space)' : 'Speech-to-text is not installed (see README)'}
          aria-label="Hold to talk"
          onPointerDown={() => void startTalk()}
          onPointerUp={() => void stopTalk()}
          onPointerLeave={() => void stopTalk()}
        >
          <MicIcon />
        </button>
      </div>
    </div>
  )
}
