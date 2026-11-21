import { describe, expect, it } from 'vitest'
import { setupForTest } from '@wb/sdk/testing'
import plugin from './index'
import { makeDecoder, mapTopic, toOutgoing } from './decode'

const enc = new TextEncoder()

describe('mcap-playback', () => {
  it('maps topics under the board prefix', () => {
    expect(mapTopic('titan', '/left_encoder')).toBe('titan/left_encoder')
    expect(mapTopic('titan/', 'imu')).toBe('titan/imu')
    expect(mapTopic('', '/camera')).toBe('camera')
  })

  it('decodes JSON messages', () => {
    const decode = makeDecoder({ topic: '/x', messageEncoding: 'json', schemaName: '', schemaEncoding: 'jsonschema', schemaData: new Uint8Array() })
    expect(decode(enc.encode('{"ticks":12}'))).toEqual({ ticks: 12 })
  })

  it('refuses encodings it cannot decode, with a clear message', () => {
    expect(() => makeDecoder({ topic: '/p', messageEncoding: 'protobuf', schemaName: 'x', schemaEncoding: 'protobuf', schemaData: new Uint8Array() })).toThrow(/not supported/)
  })

  it('sends point clouds and images as binary, everything else as JSON', () => {
    const points = toOutgoing({ frame: 'lidar', points: [1, 2, 0, 3, 4, 0] })
    expect(points.kind).toBe('binary')
    if (points.kind === 'binary') {
      expect(new Float32Array(points.payload.buffer)).toEqual(new Float32Array([1, 2, 0, 3, 4, 0]))
      expect(points.meta.dtype).toBe('f32')
    }
    const image = toOutgoing({ format: 'jpeg', width: 2, height: 2, data: Buffer.from([1, 2, 3]).toString('base64') })
    expect(image.kind).toBe('binary')
    expect(toOutgoing({ ticks: 5 })).toEqual({ kind: 'json', data: { ticks: 5 } })
  })

  it('registers the playback panel and show_playback tool', async () => {
    const api = await setupForTest(plugin, { name: 'mcap-playback' })
    expect(api.recorded.panels.map((p) => p.id)).toEqual(['playback'])
    await api.runTool('show_playback', {})
    expect(api.recorded.openedPanels[0]?.panel).toBe('playback')
  })
})
