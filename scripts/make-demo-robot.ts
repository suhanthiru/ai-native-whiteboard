/**
 * Builds boards/titan-demo/data/titan.glb: a procedural stand-in for the Titan
 * robot with named parts (what a CAD export with names kept would give us).
 * Units are metres; the robot drives along +X.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as THREE from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'

// GLTFExporter uses FileReader, which Node does not have.
class NodeFileReader {
  result: ArrayBuffer | string | null = null
  onload: ((e: { target: NodeFileReader }) => void) | null = null
  onloadend: ((e: { target: NodeFileReader }) => void) | null = null
  readAsArrayBuffer(blob: Blob): void {
    void blob.arrayBuffer().then((buf) => this.done(buf))
  }
  readAsDataURL(blob: Blob): void {
    void blob.arrayBuffer().then((buf) => this.done(`data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(buf).toString('base64')}`))
  }
  private done(result: ArrayBuffer | string): void {
    this.result = result
    this.onload?.({ target: this })
    this.onloadend?.({ target: this })
  }
}
;(globalThis as unknown as { FileReader: unknown }).FileReader = NodeFileReader

const mat = {
  aluminium: new THREE.MeshStandardMaterial({ color: 0xc9cdd2, metalness: 1, roughness: 0.32 }),
  anodised: new THREE.MeshStandardMaterial({ color: 0x2b2e33, metalness: 0.7, roughness: 0.42 }),
  carbon: new THREE.MeshStandardMaterial({ color: 0x1a1b1e, metalness: 0.2, roughness: 0.55 }),
  rubber: new THREE.MeshStandardMaterial({ color: 0x141414, metalness: 0, roughness: 0.92 }),
  pcb: new THREE.MeshStandardMaterial({ color: 0x1f5e3b, metalness: 0.15, roughness: 0.6 }),
  copper: new THREE.MeshStandardMaterial({ color: 0xc78b4a, metalness: 1, roughness: 0.35 }),
  plastic: new THREE.MeshStandardMaterial({ color: 0x0e0e10, metalness: 0, roughness: 0.38 }),
  battery: new THREE.MeshStandardMaterial({ color: 0x3a6fd8, metalness: 0.1, roughness: 0.5 }),
  lens: new THREE.MeshStandardMaterial({ color: 0x0a0a12, metalness: 0.9, roughness: 0.05 }),
  white: new THREE.MeshStandardMaterial({ color: 0xe8e8ea, metalness: 0.05, roughness: 0.45 }),
}

const CYL_SEGMENTS = 48

function mesh(geometry: THREE.BufferGeometry, material: THREE.Material, position: [number, number, number] = [0, 0, 0], rotation: [number, number, number] = [0, 0, 0]): THREE.Mesh {
  const m = new THREE.Mesh(geometry, material)
  m.position.set(...position)
  m.rotation.set(...rotation)
  return m
}

function part(name: string, position: [number, number, number], ...children: THREE.Object3D[]): THREE.Group {
  const g = new THREE.Group()
  g.name = name
  g.position.set(...position)
  g.add(...children)
  return g
}

/** Cylinder lying along Z (wheel axles point sideways). */
function axleCylinder(radius: number, length: number, material: THREE.Material, z = 0): THREE.Mesh {
  return mesh(new THREE.CylinderGeometry(radius, radius, length, CYL_SEGMENTS), material, [0, 0, z], [Math.PI / 2, 0, 0])
}

function wheel(name: string, side: 1 | -1): THREE.Group {
  const tire = mesh(new THREE.TorusGeometry(0.068, 0.018, 24, 64), mat.rubber)
  const hub = axleCylinder(0.056, 0.04, mat.aluminium)
  const cap = axleCylinder(0.018, 0.046, mat.anodised)
  const spokes = [0, 1, 2, 3, 4].map((i) => mesh(new THREE.BoxGeometry(0.008, 0.1, 0.012), mat.anodised, [0, 0, side * 0.021], [0, 0, (i * Math.PI * 2) / 5]))
  return part(name, [0.02, 0.086, side * 0.215], tire, hub, cap, ...spokes)
}

function motor(name: string, side: 1 | -1): THREE.Group {
  const body = axleCylinder(0.03, 0.085, mat.anodised)
  const shaft = axleCylinder(0.006, 0.03, mat.aluminium, side * 0.055)
  return part(name, [0.02, 0.086, side * 0.145], body, shaft)
}

function encoder(name: string, side: 1 | -1): THREE.Group {
  const board = axleCylinder(0.026, 0.004, mat.pcb)
  const disc = axleCylinder(0.02, 0.003, mat.copper, -side * 0.004)
  const chip = mesh(new THREE.BoxGeometry(0.008, 0.008, 0.003), mat.plastic, [0.01, 0.008, side * 0.003])
  return part(name, [0.02, 0.086, side * 0.098], board, disc, chip)
}

function build(): THREE.Group {
  const root = new THREE.Group()
  root.name = 'titan'

  const chassis = part('chassis', [0, 0.11, 0], mesh(new THREE.BoxGeometry(0.5, 0.09, 0.17), mat.anodised), mesh(new THREE.BoxGeometry(0.46, 0.012, 0.3), mat.aluminium, [0, -0.04, 0]))
  const topPlate = part('top_plate', [0, 0.17, 0], mesh(new THREE.BoxGeometry(0.48, 0.012, 0.34), mat.carbon))
  const battery = part('battery', [-0.06, 0.11, 0], mesh(new THREE.BoxGeometry(0.2, 0.055, 0.1), mat.battery), mesh(new THREE.BoxGeometry(0.02, 0.03, 0.04), mat.white, [0.11, 0, 0]))
  const compute = part(
    'compute',
    [-0.13, 0.195, 0],
    mesh(new THREE.BoxGeometry(0.11, 0.022, 0.09), mat.pcb),
    mesh(new THREE.BoxGeometry(0.07, 0.014, 0.07), mat.aluminium, [0, 0.018, 0]),
  )
  const lidar = part(
    'lidar',
    [0.13, 0.205, 0],
    mesh(new THREE.CylinderGeometry(0.042, 0.046, 0.045, CYL_SEGMENTS), mat.plastic),
    mesh(new THREE.CylinderGeometry(0.036, 0.036, 0.018, CYL_SEGMENTS), mat.lens, [0, 0.03, 0]),
    mesh(new THREE.CylinderGeometry(0.038, 0.038, 0.006, CYL_SEGMENTS), mat.plastic, [0, 0.042, 0]),
  )
  const imu = part('imu', [-0.02, 0.182, 0.08], mesh(new THREE.BoxGeometry(0.03, 0.008, 0.03), mat.pcb), mesh(new THREE.BoxGeometry(0.012, 0.004, 0.012), mat.plastic, [0, 0.006, 0]))
  const camera = part(
    'camera',
    [0.262, 0.135, 0],
    mesh(new THREE.BoxGeometry(0.026, 0.03, 0.09), mat.plastic),
    mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.008, 32), mat.lens, [0.016, 0, 0.022], [0, 0, Math.PI / 2]),
    mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.008, 32), mat.lens, [0.016, 0, -0.022], [0, 0, Math.PI / 2]),
  )
  const caster = part('caster', [-0.2, 0.03, 0], mesh(new THREE.SphereGeometry(0.03, 32, 16), mat.aluminium), mesh(new THREE.CylinderGeometry(0.02, 0.026, 0.03, 32), mat.anodised, [0, 0.035, 0]))
  const bumper = part('front_bumper', [0.255, 0.07, 0], mesh(new THREE.BoxGeometry(0.02, 0.05, 0.3), mat.rubber))

  root.add(
    chassis,
    topPlate,
    battery,
    compute,
    lidar,
    imu,
    camera,
    caster,
    bumper,
    wheel('left_wheel', 1),
    wheel('right_wheel', -1),
    motor('left_motor', 1),
    motor('right_motor', -1),
    encoder('left_encoder', 1),
    encoder('right_encoder', -1),
  )
  return root
}

async function main(): Promise<void> {
  const outDir = join(process.cwd(), 'boards', 'titan-demo', 'data')
  mkdirSync(outDir, { recursive: true })
  const scene = new THREE.Scene()
  scene.add(build())
  const exporter = new GLTFExporter()
  const glb = (await exporter.parseAsync(scene, { binary: true })) as ArrayBuffer
  const file = join(outDir, 'titan.glb')
  writeFileSync(file, Buffer.from(glb))
  process.stdout.write(`wrote ${file} (${glb.byteLength} bytes)\n`)
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
  process.exit(1)
})
