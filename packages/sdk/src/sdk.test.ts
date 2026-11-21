import { describe, expect, it, vi } from 'vitest'
import { DataBus } from './bus'
import { dataColor, kindForTopic, themes, typeSize } from './design'
import { parseManifest, pluginToolName } from './manifest'
import { critical, cssTransition, springs, staggerDelay, stepSpring, toFramer, toReactSpring } from './motion'
import { matchesPattern, normaliseBoardPath } from './paths'
import { BinaryKind, decodeBinaryFrame, encodeBinaryFrame, initialAppState } from './protocol'

describe('DataBus', () => {
  it('delivers to topic and wildcard subscribers and keeps the latest', () => {
    const bus = new DataBus()
    const seen: number[] = []
    const all: string[] = []
    bus.subscribe<number>('a', (m) => seen.push(m.data))
    bus.subscribe('*', (m) => all.push(m.topic))
    bus.publish('a', 1, 1)
    bus.publish('b', 2, 2)
    expect(seen).toEqual([1])
    expect(all).toEqual(['a', 'b'])
    expect(bus.latest('b')?.data).toBe(2)
    expect(bus.topics()).toEqual(['a', 'b'])
  })

  it('bounds history and returns it oldest first', () => {
    const bus = new DataBus({ historySize: 3 })
    for (let i = 0; i < 5; i += 1) bus.publish('x', i, i)
    expect(bus.history<number>('x').map((m) => m.data)).toEqual([2, 3, 4])
    expect(bus.history<number>('x', 2).map((m) => m.data)).toEqual([3, 4])
  })

  it('isolates a throwing subscriber', () => {
    const onListenerError = vi.fn()
    const bus = new DataBus({ onListenerError })
    const good = vi.fn()
    bus.subscribe('t', () => {
      throw new Error('boom')
    })
    bus.subscribe('t', good)
    bus.publish('t', 1)
    expect(good).toHaveBeenCalledOnce()
    expect(onListenerError).toHaveBeenCalledWith('t', expect.any(Error))
  })

  it('unsubscribes, clears, and reports topic changes', () => {
    const bus = new DataBus()
    const fn = vi.fn()
    const topics = vi.fn()
    bus.onTopics(topics)
    const off = bus.subscribe('t', fn)
    off()
    bus.publish('t', 1)
    expect(fn).not.toHaveBeenCalled()
    bus.clear('t')
    expect(bus.latest('t')).toBeUndefined()
    bus.publish('u', 1)
    bus.clear()
    expect(bus.topics()).toEqual([])
    expect(topics).toHaveBeenCalled()
    expect(() => bus.publish('', 1)).toThrow()
  })
})

describe('design tokens', () => {
  it('gives every data kind a fixed color and a neutral fallback', () => {
    expect(dataColor('lidar')).toBe('#64D2FF')
    expect(dataColor('unknown-kind')).toBe(dataColor('neutral'))
  })

  it('guesses kinds from topic names', () => {
    expect(kindForTopic('titan/lidar')).toBe('lidar')
    expect(kindForTopic('titan/left_encoder')).toBe('encoder')
    expect(kindForTopic('titan/imu')).toBe('imu')
    expect(kindForTopic('titan/camera')).toBe('camera')
    expect(kindForTopic('titan/odom')).toBe('odometry')
    expect(kindForTopic('titan/battery')).toBe('power')
    expect(kindForTopic('titan/other')).toBe('neutral')
  })

  it('makes projector type larger and removes blur', () => {
    expect(typeSize(themes.projector, 'md')).toBeGreaterThan(typeSize(themes.glass, 'md'))
    expect(themes.projector.blur).toBe('none')
    expect(themes.projector.colors.background).toBe('#000000')
  })
})

describe('motion presets', () => {
  it('uses critically damped springs (no bounce)', () => {
    for (const s of Object.values(springs)) expect(s.damping).toBeCloseTo(2 * Math.sqrt(s.stiffness * s.mass))
    expect(critical(100).damping).toBe(20)
  })

  it('staggers in small groups', () => {
    expect([0, 1, 2, 3, 6].map((i) => staggerDelay(i))).toEqual([0, 0, 0, 60, 120])
    expect(staggerDelay(-1)).toBe(0)
  })

  it('converts to framework configs', () => {
    expect(toReactSpring('standard').tension).toBe(springs.standard.stiffness)
    expect(toFramer('snappy', 100)).toMatchObject({ type: 'spring', delay: 0.1 })
    expect(cssTransition('opacity', 'fast')).toMatch(/^opacity 200ms cubic-bezier/)
  })

  it('settles a spring on its target without overshoot', () => {
    let x = 0
    let v = 0
    let max = 0
    for (let i = 0; i < 120; i += 1) {
      ;[x, v] = stepSpring(x, v, 1, 1 / 60, 'standard')
      max = Math.max(max, x)
    }
    expect(x).toBeCloseTo(1, 2)
    expect(max).toBeLessThan(1.01)
  })
})

describe('manifest', () => {
  it('fills defaults and validates names', () => {
    const ok = parseManifest({ name: 'my-plugin', version: '1.0.0', description: 'x' })
    expect(ok.ok).toBe(true)
    if (ok.ok) {
      expect(ok.manifest.frontend).toBe('index.tsx')
      expect(ok.manifest.permissions.network).toBe(false)
    }
    const bad = parseManifest({ name: 'Bad Name', version: '1', description: '' })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toMatch(/name/)
  })

  it('namespaces tool names for MCP', () => {
    expect(pluginToolName('mcap-playback', 'play')).toBe('plugin_mcap_playback_play')
  })
})

describe('board paths', () => {
  it('accepts relative paths inside data/', () => {
    expect(normaliseBoardPath('data/run.mcap')).toBe('run.mcap')
    expect(normaliseBoardPath('logs\\a.mcap')).toBe('logs/a.mcap')
    expect(normaliseBoardPath('./a/./b.glb')).toBe('a/b.glb')
  })

  it.each(['../secret', 'a/../../b', '/etc/passwd', 'C:/Windows/x', '//server/share', '', 'a\0b'])('rejects %j', (p) => {
    expect(normaliseBoardPath(p)).toBeNull()
  })

  it('matches simple globs', () => {
    expect(matchesPattern('run_01.mcap', '*.mcap')).toBe(true)
    expect(matchesPattern('logs/run.mcap', '*.mcap')).toBe(false)
    expect(matchesPattern('logs/run.mcap', '**.mcap')).toBe(true)
    expect(matchesPattern('a.MCAP', '*.mcap')).toBe(true)
  })
})

describe('binary frames', () => {
  it('round-trips header and payload', () => {
    const payload = new Uint8Array([1, 2, 3])
    const frame = encodeBinaryFrame(BinaryKind.bus, { topic: 't', t: 1 }, payload)
    const out = decodeBinaryFrame(frame)
    expect(out.kind).toBe(BinaryKind.bus)
    expect(out.header).toEqual({ topic: 't', t: 1 })
    expect([...out.payload]).toEqual([1, 2, 3])
  })

  it('rejects truncated frames', () => {
    expect(() => decodeBinaryFrame(new Uint8Array([1]))).toThrow()
    expect(() => decodeBinaryFrame(new Uint8Array([1, 0, 50, 1]))).toThrow()
  })

  it('starts from an empty state', () => {
    expect(initialAppState().scene.explode).toBe(0)
  })
})
