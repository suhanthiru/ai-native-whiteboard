/**
 * ROS uses x forward, y left, z up. The 3D scene uses x forward, y up, z right.
 * These helpers convert between them (pure functions, tested).
 */
export type Quat = { x: number; y: number; z: number; w: number }

export function rosPointsToScene(src: Float32Array, out: Float32Array, max: number): number {
  const n = Math.min(Math.floor(src.length / 3), max)
  for (let i = 0; i < n; i += 1) {
    out[i * 3] = src[i * 3] ?? 0
    out[i * 3 + 1] = src[i * 3 + 2] ?? 0
    out[i * 3 + 2] = -(src[i * 3 + 1] ?? 0)
  }
  return n
}

/** Roll and pitch (radians) from a ROS orientation quaternion. Yaw is ignored on purpose. */
export function rollPitch(q: Quat): { roll: number; pitch: number } {
  const roll = Math.atan2(2 * (q.w * q.x + q.y * q.z), 1 - 2 * (q.x * q.x + q.y * q.y))
  const s = 2 * (q.w * q.y - q.z * q.x)
  const pitch = Math.abs(s) >= 1 ? Math.sign(s) * (Math.PI / 2) : Math.asin(s)
  return { roll, pitch }
}

/** Scene-frame quaternion [x,y,z,w] for a tilt: roll about scene x, ROS pitch about scene -z. */
export function tiltQuaternion(roll: number, pitch: number): [number, number, number, number] {
  // Compose q = qRoll(x) * qPitch(-z).
  const hr = roll / 2
  const hp = -pitch / 2
  const cr = Math.cos(hr)
  const sr = Math.sin(hr)
  const cp = Math.cos(hp)
  const sp = Math.sin(hp)
  return [sr * cp, -sr * sp, cr * sp, cr * cp]
}

export function ticksToAngle(ticks: number, ticksPerRev: number): number {
  return (ticks / Math.max(1, ticksPerRev)) * Math.PI * 2
}
