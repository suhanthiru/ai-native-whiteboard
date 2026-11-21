/**
 * Writes boards/titan-demo/data/run_01.mcap: SYNTHETIC sensor data for the
 * demo robot (not a recording). The robot drives a slow S-curve through a
 * room with pillars. Topics use ROS conventions (x forward, y left, z up):
 *   /lidar          10 Hz  { frame, points: [x,y,z,...] }        metres
 *   /left_encoder   50 Hz  { ticks, velocity }                    rad/s
 *   /right_encoder  50 Hz  { ticks, velocity }
 *   /imu            50 Hz  { orientation{x,y,z,w}, angular_velocity, linear_acceleration }
 *   /camera          5 Hz  { format: "jpeg", width, height, data: base64 }
 * Also refreshes data.lock.json for the demo board.
 */
import { createHash } from 'node:crypto'
import { closeSync, openSync, readdirSync, readFileSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { McapWriter, type IWritable } from '@mcap/core'
import jpeg from 'jpeg-js'

const BOARD = join(process.cwd(), 'boards', 'titan-demo')
const DATA = join(BOARD, 'data')
const DURATION_S = 20
const WHEEL_RADIUS = 0.086
const TRACK = 0.43
const TICKS_PER_REV = 2048
const LIDAR_BEAMS = 360
const LIDAR_RANGE = 8
const LIDAR_OFFSET_X = 0.13
const CAM_W = 160
const CAM_H = 120
const CAM_FOV = Math.PI / 3

const ROOM = { minX: -4, maxX: 6, minY: -3, maxY: 3 }
const PILLARS = [
  { x: 2, y: 1.2, r: 0.25 },
  { x: -1, y: -1.5, r: 0.3 },
  { x: 4, y: -1, r: 0.2 },
  { x: 0.5, y: 2.2, r: 0.18 },
]

class FileWritable implements IWritable {
  private offset = 0n
  constructor(private readonly fd: number) {}
  async write(buffer: Uint8Array): Promise<void> {
    writeSync(this.fd, buffer)
    this.offset += BigInt(buffer.byteLength)
  }
  position(): bigint {
    return this.offset
  }
}

/** Deterministic noise so the file is reproducible. */
let seed = 42
function rand(): number {
  seed = (seed * 1664525 + 1013904223) % 4294967296
  return seed / 4294967296
}
const noise = (scale: number) => (rand() - 0.5) * 2 * scale

interface Pose {
  x: number
  y: number
  yaw: number
}

function commands(t: number): { v: number; omega: number } {
  return { v: 0.32, omega: 0.45 * Math.sin((t / DURATION_S) * Math.PI * 2) }
}

function raycast(ox: number, oy: number, angle: number): number {
  const dx = Math.cos(angle)
  const dy = Math.sin(angle)
  let best = LIDAR_RANGE
  const walls: [number, number][] = []
  if (dx > 0) walls.push([(ROOM.maxX - ox) / dx, 0])
  if (dx < 0) walls.push([(ROOM.minX - ox) / dx, 0])
  if (dy > 0) walls.push([(ROOM.maxY - oy) / dy, 0])
  if (dy < 0) walls.push([(ROOM.minY - oy) / dy, 0])
  for (const [d] of walls) if (d > 0 && d < best) best = d
  for (const p of PILLARS) {
    const fx = ox - p.x
    const fy = oy - p.y
    const b = fx * dx + fy * dy
    const c = fx * fx + fy * fy - p.r * p.r
    const disc = b * b - c
    if (disc >= 0) {
      const d = -b - Math.sqrt(disc)
      if (d > 0 && d < best) best = d
    }
  }
  return best
}

function lidarScan(pose: Pose): number[] {
  const ox = pose.x + Math.cos(pose.yaw) * LIDAR_OFFSET_X
  const oy = pose.y + Math.sin(pose.yaw) * LIDAR_OFFSET_X
  const points: number[] = []
  for (let i = 0; i < LIDAR_BEAMS; i += 1) {
    const local = (i / LIDAR_BEAMS) * Math.PI * 2 - Math.PI
    const d = raycast(ox, oy, pose.yaw + local) + noise(0.01)
    if (d >= LIDAR_RANGE - 0.01) continue
    points.push(+(Math.cos(local) * d).toFixed(4), +(Math.sin(local) * d).toFixed(4), 0)
  }
  return points
}

function quatFromEuler(roll: number, pitch: number, yaw: number): { x: number; y: number; z: number; w: number } {
  const cr = Math.cos(roll / 2)
  const sr = Math.sin(roll / 2)
  const cp = Math.cos(pitch / 2)
  const sp = Math.sin(pitch / 2)
  const cy = Math.cos(yaw / 2)
  const sy = Math.sin(yaw / 2)
  return { w: cr * cp * cy + sr * sp * sy, x: sr * cp * cy - cr * sp * sy, y: cr * sp * cy + sr * cp * sy, z: cr * cp * sy - sr * sp * cy }
}

/** A tiny synthetic camera view: sky, floor and pillars in perspective. */
function cameraFrame(pose: Pose): string {
  const rgba = Buffer.alloc(CAM_W * CAM_H * 4)
  const horizon = CAM_H * 0.45
  for (let y = 0; y < CAM_H; y += 1) {
    for (let x = 0; x < CAM_W; x += 1) {
      const i = (y * CAM_W + x) * 4
      const sky = y < horizon
      const t = sky ? y / horizon : (y - horizon) / (CAM_H - horizon)
      rgba[i] = sky ? 40 + 30 * t : 52 - 20 * t
      rgba[i + 1] = sky ? 48 + 34 * t : 50 - 18 * t
      rgba[i + 2] = sky ? 70 + 40 * t : 54 - 18 * t
      rgba[i + 3] = 255
    }
  }
  for (const p of PILLARS) {
    const dx = p.x - pose.x
    const dy = p.y - pose.y
    const dist = Math.hypot(dx, dy)
    let bearing = Math.atan2(dy, dx) - pose.yaw
    bearing = Math.atan2(Math.sin(bearing), Math.cos(bearing))
    if (Math.abs(bearing) > CAM_FOV / 2 + 0.2) continue
    const cx = CAM_W / 2 - (bearing / (CAM_FOV / 2)) * (CAM_W / 2)
    const half = Math.max(1, (p.r / dist) * CAM_W * 0.9)
    const height = Math.min(CAM_H, (CAM_H * 0.9) / Math.max(dist, 0.3))
    const shade = Math.max(60, 230 - dist * 28)
    for (let x = Math.floor(cx - half); x <= Math.ceil(cx + half); x += 1) {
      if (x < 0 || x >= CAM_W) continue
      for (let y = Math.floor(horizon - height * 0.6); y < Math.min(CAM_H, horizon + height * 0.4); y += 1) {
        if (y < 0) continue
        const i = (y * CAM_W + x) * 4
        rgba[i] = shade
        rgba[i + 1] = shade * 0.92
        rgba[i + 2] = shade * 0.8
      }
    }
  }
  return Buffer.from(jpeg.encode({ data: rgba, width: CAM_W, height: CAM_H }, 72).data).toString('base64')
}

const schemas: Record<string, object> = {
  '/lidar': { type: 'object', properties: { frame: { type: 'string' }, points: { type: 'array', items: { type: 'number' } } } },
  '/left_encoder': { type: 'object', properties: { ticks: { type: 'integer' }, velocity: { type: 'number' } } },
  '/right_encoder': { type: 'object', properties: { ticks: { type: 'integer' }, velocity: { type: 'number' } } },
  '/imu': { type: 'object', properties: { orientation: { type: 'object' }, angular_velocity: { type: 'object' }, linear_acceleration: { type: 'object' } } },
  '/camera': { type: 'object', properties: { format: { type: 'string' }, width: { type: 'integer' }, height: { type: 'integer' }, data: { type: 'string' } } },
}

const RATES: Record<string, number> = { '/lidar': 10, '/left_encoder': 50, '/right_encoder': 50, '/imu': 50, '/camera': 5 }

function writeLock(): void {
  const files = readdirSync(DATA)
    .filter((f) => !f.startsWith('.'))
    .sort()
    .map((f) => {
      const buf = readFileSync(join(DATA, f))
      return { path: f, size: statSync(join(DATA, f)).size, sha256: createHash('sha256').update(buf).digest('hex') }
    })
  writeFileSync(join(BOARD, 'data.lock.json'), JSON.stringify({ version: 1, files }, null, 2) + '\n', 'utf8')
  process.stdout.write(`wrote data.lock.json (${files.length} files)\n`)
}

async function main(): Promise<void> {
  const file = join(DATA, 'run_01.mcap')
  const fd = openSync(file, 'w')
  const writer = new McapWriter({ writable: new FileWritable(fd), useChunks: true, chunkSize: 512 * 1024 })
  await writer.start({ profile: '', library: 'whiteboard make-demo-mcap' })
  const channel: Record<string, number> = {}
  const enc = new TextEncoder()
  for (const topic of Object.keys(schemas)) {
    const schemaId = await writer.registerSchema({ name: `titan${topic}`, encoding: 'jsonschema', data: enc.encode(JSON.stringify(schemas[topic])) })
    channel[topic] = await writer.registerChannel({ topic, schemaId, messageEncoding: 'json', metadata: new Map([['synthetic', 'true']]) })
  }
  await writer.addMetadata({ name: 'synthetic', metadata: new Map([['note', 'SYNTHETIC demo data generated by scripts/make-demo-mcap.ts; not a real recording']]) })

  const pose: Pose = { x: -2.5, y: 0, yaw: 0 }
  const ticks = { left: 0, right: 0 }
  const dt = 1 / 50
  let seq = 0
  const startNs = 1_700_000_000_000_000_000n
  for (let step = 0; step <= DURATION_S * 50; step += 1) {
    const t = step * dt
    const { v, omega } = commands(t)
    const wl = (v - (omega * TRACK) / 2) / WHEEL_RADIUS
    const wr = (v + (omega * TRACK) / 2) / WHEEL_RADIUS
    ticks.left += (wl * dt * TICKS_PER_REV) / (Math.PI * 2)
    ticks.right += (wr * dt * TICKS_PER_REV) / (Math.PI * 2)
    pose.x += Math.cos(pose.yaw) * v * dt
    pose.y += Math.sin(pose.yaw) * v * dt
    pose.yaw += omega * dt
    const logTime = startNs + BigInt(Math.round(t * 1e9))
    const emit = async (topic: string, payload: unknown) => {
      seq += 1
      await writer.addMessage({ channelId: channel[topic] ?? 0, sequence: seq, logTime, publishTime: logTime, data: enc.encode(JSON.stringify(payload)) })
    }
    const due = (topic: string) => step % Math.round(50 / (RATES[topic] ?? 50)) === 0
    if (due('/left_encoder')) await emit('/left_encoder', { ticks: Math.round(ticks.left), velocity: +(wl + noise(0.05)).toFixed(4) })
    if (due('/right_encoder')) await emit('/right_encoder', { ticks: Math.round(ticks.right), velocity: +(wr + noise(0.05)).toFixed(4) })
    if (due('/imu')) {
      const roll = 0.02 * Math.sin(t * 7.1) + noise(0.003)
      const pitch = 0.025 * Math.sin(t * 5.3 + 1) + noise(0.003)
      await emit('/imu', {
        orientation: quatFromEuler(roll, pitch, pose.yaw),
        angular_velocity: { x: noise(0.02), y: noise(0.02), z: +(omega + noise(0.01)).toFixed(4) },
        linear_acceleration: { x: noise(0.08), y: +(v * omega + noise(0.05)).toFixed(4), z: 9.81 + noise(0.05) },
      })
    }
    if (due('/lidar')) await emit('/lidar', { frame: 'lidar', points: lidarScan(pose) })
    if (due('/camera')) await emit('/camera', { format: 'jpeg', width: CAM_W, height: CAM_H, data: cameraFrame(pose) })
  }
  await writer.end()
  closeSync(fd)
  process.stdout.write(`wrote ${file} (${statSync(file).size} bytes, ${seq} messages, SYNTHETIC)\n`)
  writeLock()
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
  process.exit(1)
})
