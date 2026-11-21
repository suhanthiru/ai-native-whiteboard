import { useEffect, useState } from 'react'
import { z } from 'zod'
import { definePlugin, pluginToolName, type PanelProps, type PluginApi } from '@wb/sdk'
import { rollPitch, rosPointsToScene, ticksToAngle, tiltQuaternion, type Quat } from './frames'

type Three = typeof import('three')

const MAX_POINTS = 4096
const POINT_SIZE = 0.03
const DEFAULT_TICKS = 2048
const DEFAULT_TILT_GAIN = 3

interface BinaryData {
  meta: Record<string, unknown>
  values: Float32Array | Uint8Array
}

interface Config {
  prefix: string
  lidarPart: string
  wheels: Record<string, string>
  ticksPerRev: number
  tiltGain: number
}

function readConfig(api: PluginApi): Config {
  const c = api.board.config()
  return {
    prefix: typeof c.topicPrefix === 'string' ? c.topicPrefix : 'titan',
    lidarPart: typeof c.lidarPart === 'string' ? c.lidarPart : 'lidar',
    wheels: (c.wheels as Record<string, string> | undefined) ?? { left_encoder: 'left_wheel', right_encoder: 'right_wheel' },
    ticksPerRev: typeof c.ticksPerRev === 'number' ? c.ticksPerRev : DEFAULT_TICKS,
    tiltGain: typeof c.tiltGain === 'number' ? c.tiltGain : DEFAULT_TILT_GAIN,
  }
}

function CameraPanel({ api }: PanelProps) {
  const useBusLatest = api.ui.useBusLatest as <T>(topic: string) => { data: T; t: number } | undefined
  const frame = useBusLatest<BinaryData>(`${readConfig(api).prefix}/camera`)
  const [url, setUrl] = useState('')
  useEffect(() => {
    if (!frame?.data?.values) return undefined
    const format = String(frame.data.meta.format ?? 'jpeg')
    const next = URL.createObjectURL(new Blob([frame.data.values.slice()], { type: `image/${format}` }))
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [frame])
  if (!url) return <div className="wb-panel-body wb-text-sm wb-muted">No camera frames yet. Start playback.</div>
  return (
    <div style={{ position: 'relative', height: '100%' }}>
      <img src={url} alt="Robot camera" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
      <span className="wb-label" style={{ position: 'absolute', left: api.design.space[3], bottom: api.design.space[3] }}>
        camera · {frame?.t.toFixed(1)}s
      </span>
    </div>
  )
}

function setupLidar(api: PluginApi, three: Three, cfg: Config): () => void {
  const positions = new Float32Array(MAX_POINTS * 3)
  const geometry = new three.BufferGeometry()
  geometry.setAttribute('position', new three.BufferAttribute(positions, 3))
  geometry.setDrawRange(0, 0)
  const material = new three.PointsMaterial({ color: new three.Color(api.design.dataColor('lidar')), size: POINT_SIZE, sizeAttenuation: true, transparent: true, opacity: 0.9, depthWrite: false })
  const points = new three.Points(geometry, material)
  points.frustumCulled = false
  points.renderOrder = 5
  api.scene.addObject('lidar-points', points, { attachTo: cfg.lidarPart })
  const off = api.subscribe<BinaryData>(`${cfg.prefix}/lidar`, (m) => {
    if (!(m.data.values instanceof Float32Array)) return
    const n = rosPointsToScene(m.data.values, positions, MAX_POINTS)
    geometry.setDrawRange(0, n)
    const attr = geometry.getAttribute('position')
    attr.needsUpdate = true
    api.scene.invalidate()
  })
  return () => {
    off()
    api.scene.removeObject('lidar-points')
    geometry.dispose()
    material.dispose()
  }
}

function setupMotion(api: PluginApi, cfg: Config): void {
  const wheels = Object.entries(cfg.wheels).map(([encoder, part]) => ({ encoder, part, target: 0, current: 0, velocity: 0, seen: false }))
  for (const w of wheels) {
    api.subscribe<{ ticks: number }>(`${cfg.prefix}/${w.encoder}`, (m) => {
      w.target = ticksToAngle(m.data.ticks, cfg.ticksPerRev)
      if (!w.seen) {
        w.current = w.target
        w.seen = true
      }
    })
  }
  const tilt = { roll: 0, pitch: 0, vr: 0, vp: 0, targetRoll: 0, targetPitch: 0, seen: false }
  api.subscribe<{ orientation: Quat }>(`${cfg.prefix}/imu`, (m) => {
    const { roll, pitch } = rollPitch(m.data.orientation)
    tilt.targetRoll = roll * cfg.tiltGain
    tilt.targetPitch = pitch * cfg.tiltGain
    tilt.seen = true
  })
  const step = api.motion.stepSpring
  api.scene.onFrame((dt) => {
    for (const w of wheels) {
      if (!w.seen) continue
      ;[w.current, w.velocity] = step(w.current, w.velocity, w.target, dt, 'snappy')
      // Rolling forward (+x) turns the wheel clockwise seen from +z.
      api.scene.part(w.part)?.setRotation('z', -w.current)
    }
    if (tilt.seen) {
      ;[tilt.roll, tilt.vr] = step(tilt.roll, tilt.vr, tilt.targetRoll, dt, 'standard')
      ;[tilt.pitch, tilt.vp] = step(tilt.pitch, tilt.vp, tilt.targetPitch, dt, 'standard')
      api.scene.root()?.setQuaternion(tiltQuaternion(tilt.roll, tilt.pitch))
    }
  })
}

export async function showSensors(api: PluginApi): Promise<string> {
  const notes: string[] = []
  try {
    notes.push(await api.callTool(pluginToolName('mcap-playback', 'play')))
  } catch (error) {
    notes.push(`Playback did not start: ${error instanceof Error ? error.message : String(error)}`)
  }
  await api.panels.open('camera', {}, { anchorPart: 'camera' })
  notes.push('Lidar points are drawn around the lidar, the wheels turn with the encoders, the chassis tilts with the IMU (tilt exaggerated), and the camera feed is next to the camera.')
  return notes.join(' ')
}

export default definePlugin({
  setup(api) {
    const cfg = readConfig(api)
    const three = api.scene.three as Three
    api.registerPanel({ id: 'camera', title: 'Camera', component: CameraPanel, width: 320, height: 240 })
    let disposeLidar: (() => void) | null = three ? setupLidar(api, three, cfg) : null
    if (three) setupMotion(api, cfg)

    api.registerTool({ name: 'show_sensors', description: 'Show the robot sensors in action: start log playback, draw lidar points, turn the wheels from the encoders, tilt from the IMU, and open the camera feed.', input: z.object({}), run: () => showSensors(api) })
    api.registerTool({
      name: 'show_camera',
      description: 'Open the camera feed next to the camera part.',
      input: z.object({}),
      run: async () => `Camera panel open (${await api.panels.open('camera', {}, { anchorPart: 'camera' })}).`,
    })
    api.registerTool({
      name: 'hide_sensors',
      description: 'Stop drawing lidar points (playback keeps running).',
      input: z.object({}),
      run: () => {
        disposeLidar?.()
        disposeLidar = null
        return 'Lidar points hidden.'
      },
    })
    return () => disposeLidar?.()
  },
})
