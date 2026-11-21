import { useEffect, useState } from 'react'
import { BinaryKind, DataBus, type BusMessage } from '@wb/sdk'
import { sidecar } from '../rpc/client'
import { reportError } from '../errors'

/** The window's bus. Fed by the sidecar (data sources) and by local plugins. */
export const bus = new DataBus({
  onListenerError: (topic, error) => reportError(`bus subscriber on ${topic}`, error),
})

export interface BinaryBusData {
  meta: Record<string, unknown>
  /** Float32Array for dtype f32, Uint8Array otherwise. */
  values: Float32Array | Uint8Array
}

/** Copy into an aligned buffer; payloads arrive at arbitrary byte offsets. */
function toTyped(payload: Uint8Array, dtype: unknown): Float32Array | Uint8Array {
  const copy = payload.slice()
  if (dtype === 'f32') return new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4))
  return copy
}

export function connectBusToSidecar(): () => void {
  const offJson = sidecar.on('bus', (m) => bus.publish(m.topic, m.data, m.t))
  const offBinary = sidecar.onBinary(BinaryKind.bus, (header, payload) => {
    const topic = String(header.topic ?? '')
    if (!topic) return
    const data: BinaryBusData = { meta: (header.meta as Record<string, unknown>) ?? {}, values: toTyped(payload, header.dtype) }
    bus.publish(topic, data, Number(header.t ?? Date.now() / 1000))
  })
  return () => {
    offJson()
    offBinary()
  }
}

/** Latest message on a topic, re-rendering at most once per animation frame. */
export function useBusLatest<T = unknown>(topic: string | null | undefined): BusMessage<T> | undefined {
  const [latest, setLatest] = useState<BusMessage<T> | undefined>(() => (topic ? bus.latest<T>(topic) : undefined))
  useEffect(() => {
    if (!topic) return undefined
    let frame = 0
    let next: BusMessage<T> | undefined
    const off = bus.subscribe<T>(topic, (m) => {
      next = m
      if (frame === 0) {
        frame = requestAnimationFrame(() => {
          frame = 0
          setLatest(next)
        })
      }
    })
    return () => {
      off()
      if (frame) cancelAnimationFrame(frame)
    }
  }, [topic])
  return latest
}
