/** Message decoding and topic mapping, shared by the adapter and its test. */
import { parse as parseRosMsg } from '@foxglove/rosmsg'
import { MessageReader } from '@foxglove/rosmsg2-serialization'

export interface ChannelInfo {
  topic: string
  messageEncoding: string
  schemaName: string
  schemaEncoding: string
  schemaData: Uint8Array
}

export type Decoder = (data: Uint8Array) => unknown

const text = new TextDecoder()

export function makeDecoder(channel: ChannelInfo): Decoder {
  if (channel.messageEncoding === 'json') return (data) => JSON.parse(text.decode(data)) as unknown
  if (channel.messageEncoding === 'cdr' && channel.schemaEncoding === 'ros2msg') {
    const reader = new MessageReader(parseRosMsg(text.decode(channel.schemaData), { ros2: true }))
    return (data) => reader.readMessage(data)
  }
  throw new Error(`${channel.topic}: ${channel.messageEncoding}/${channel.schemaEncoding} is not supported yet (JSON and ROS 2 CDR are)`)
}

/** "/left_encoder" with prefix "titan" becomes "titan/left_encoder". */
export function mapTopic(prefix: string, topic: string): string {
  const clean = topic.replace(/^\/+/, '')
  return prefix ? `${prefix.replace(/\/+$/, '')}/${clean}` : clean
}

export type Outgoing =
  | { kind: 'json'; data: unknown }
  | { kind: 'binary'; payload: Uint8Array; meta: Record<string, unknown> }

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && (value.length === 0 || typeof value[0] === 'number')
}

/**
 * Big payloads go over the bus as binary: point clouds as float32 xyz,
 * compressed images as their bytes. Everything else stays JSON.
 */
export function toOutgoing(message: unknown): Outgoing {
  if (message && typeof message === 'object') {
    const m = message as Record<string, unknown>
    if (isNumberArray(m.points)) {
      return { kind: 'binary', payload: new Uint8Array(new Float32Array(m.points).buffer), meta: { dtype: 'f32', stride: 3, frame: m.frame ?? null } }
    }
    if (typeof m.format === 'string' && typeof m.data === 'string') {
      const bytes = Uint8Array.from(Buffer.from(m.data, 'base64'))
      return { kind: 'binary', payload: bytes, meta: { dtype: 'u8', format: m.format, width: m.width ?? null, height: m.height ?? null } }
    }
    if (typeof m.format === 'string' && m.data instanceof Uint8Array) {
      return { kind: 'binary', payload: m.data, meta: { dtype: 'u8', format: m.format } }
    }
  }
  return { kind: 'json', data: message }
}
