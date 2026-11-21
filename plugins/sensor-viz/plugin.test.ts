import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { setupForTest } from '@wb/sdk/testing'
import plugin from './index'
import { rollPitch, rosPointsToScene, ticksToAngle, tiltQuaternion } from './frames'

describe('sensor-viz frames', () => {
  it('converts ROS points (x fwd, y left, z up) to scene points (x fwd, y up, z right)', () => {
    const out = new Float32Array(6)
    const n = rosPointsToScene(new Float32Array([1, 2, 3, 4, 5, 6]), out, 10)
    expect(n).toBe(2)
    expect([...out]).toEqual([1, 3, -2, 4, 6, -5])
  })

  it('caps the number of points', () => {
    const out = new Float32Array(3)
    expect(rosPointsToScene(new Float32Array([1, 2, 3, 4, 5, 6]), out, 1)).toBe(1)
  })

  it('reads roll and pitch from a quaternion', () => {
    const half = 0.1 / 2
    const { roll, pitch } = rollPitch({ x: Math.sin(half), y: 0, z: 0, w: Math.cos(half) })
    expect(roll).toBeCloseTo(0.1)
    expect(pitch).toBeCloseTo(0)
  })

  it('builds a unit tilt quaternion matching three.js', () => {
    const [x, y, z, w] = tiltQuaternion(0.2, 0.1)
    expect(Math.hypot(x, y, z, w)).toBeCloseTo(1)
    const expected = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.2).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -0.1))
    expect(x).toBeCloseTo(expected.x)
    expect(y).toBeCloseTo(expected.y)
    expect(z).toBeCloseTo(expected.z)
    expect(w).toBeCloseTo(expected.w)
  })

  it('turns ticks into radians', () => {
    expect(ticksToAngle(2048, 2048)).toBeCloseTo(Math.PI * 2)
  })
})

describe('sensor-viz plugin', () => {
  it('adds lidar points to the scene and draws incoming scans', async () => {
    const api = await setupForTest(plugin, { name: 'sensor-viz', three: THREE })
    const points = api.recorded.sceneObjects.get('lidar-points') as THREE.Points
    expect(points).toBeInstanceOf(THREE.Points)
    api.publish('titan/lidar', { meta: {}, values: new Float32Array([1, 0, 0, 2, 0, 0]) })
    expect(points.geometry.drawRange.count).toBe(2)
  })

  it('show_sensors starts playback and opens the camera next to the camera part', async () => {
    const api = await setupForTest(plugin, { name: 'sensor-viz', three: THREE })
    await api.runTool('show_sensors', {})
    expect(api.recorded.toolCalls[0]?.name).toBe('plugin_mcap_playback_play')
    expect(api.recorded.openedPanels[0]).toMatchObject({ panel: 'camera', anchorPart: 'camera' })
  })
})
