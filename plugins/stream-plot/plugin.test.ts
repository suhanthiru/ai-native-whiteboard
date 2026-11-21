import { describe, expect, it } from 'vitest'
import { setupForTest } from '@wb/sdk/testing'
import type { PartHandle } from '@wb/sdk'
import plugin from './index'
import { pickField, polyline, resolveTopic, toSeries } from './series'

describe('stream-plot series', () => {
  it('prefers velocity, then any number, including nested fields', () => {
    expect(pickField({ ticks: 4, velocity: 2 })).toBe('velocity')
    expect(pickField({ foo: 'x', count: 3 })).toBe('count')
    expect(pickField({ angular_velocity: { z: 0.4 } })).toBe('angular_velocity.z')
    expect(pickField({ a: 1, b: { c: 2 } }, 'b.c')).toBe('b.c')
    expect(pickField({ text: 'none' })).toBeNull()
    expect(pickField(5)).toBe('')
  })

  it('keeps only the time window', () => {
    const samples = [0, 1, 2, 12, 13].map((t) => ({ t, data: { v: t } }))
    expect(toSeries(samples, 'v', 10).map((s) => s.t)).toEqual([12, 13])
  })

  it('builds a polyline that spans the box', () => {
    const { points, min, max } = polyline(
      [
        { t: 0, v: 0 },
        { t: 1, v: 10 },
      ],
      100,
      50,
    )
    expect(points.split(' ')).toHaveLength(2)
    expect(points.startsWith('0.0,')).toBe(true)
    expect(min).toBe(0)
    expect(max).toBe(10)
  })

  it('resolves loose topic names', () => {
    const topics = ['titan/imu', 'titan/left_encoder', 'titan/right_encoder']
    expect(resolveTopic('left encoder', topics)).toBe('titan/left_encoder')
    expect(resolveTopic('titan/imu', topics)).toBe('titan/imu')
    expect(resolveTopic('gps', topics)).toBeNull()
  })
})

describe('stream-plot plugin', () => {
  it('explains when nothing is publishing', async () => {
    const api = await setupForTest(plugin, { name: 'stream-plot' })
    expect(await api.runTool('show_stream_plot', { topic: 'left encoder' })).toMatch(/Nothing is publishing/)
  })

  it('opens a plot next to the matching part', async () => {
    const part = { name: 'left_encoder' } as PartHandle
    const api = await setupForTest(plugin, { name: 'stream-plot', parts: { left_encoder: part } })
    api.publish('titan/left_encoder', { ticks: 10, velocity: 3 }, 1)
    const text = await api.runTool('show_stream_plot', { topic: 'left encoder' })
    expect(text).toMatch(/next to left_encoder/)
    expect(api.recorded.openedPanels[0]).toMatchObject({ panel: 'plot', props: { topic: 'titan/left_encoder' }, anchorPart: 'left_encoder' })
  })
})
