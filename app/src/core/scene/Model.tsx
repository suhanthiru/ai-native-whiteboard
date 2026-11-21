import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import { presets, stepSpring } from '@wb/sdk'
import { collectParts, sceneRegistry } from './registry'
import { clampExplode, planExplode, type V3 } from './explode'

/** The model is scaled so its largest side is this many units. */
export const MODEL_SIZE = 2
const SHELL_SCALE = 1.02
const SHELL_OPACITY = 0.45

interface MeshState {
  mesh: THREE.Mesh
  materials: THREE.Material[]
  baseOpacity: number[]
  baseTransparent: boolean[]
  dim: number
  dimVelocity: number
}

interface PartAnim {
  object: THREE.Object3D
  rest: THREE.Vector3
  offset: THREE.Vector3
  delayMs: number
  progress: number
  velocity: number
}

interface ModelProps {
  url: string
  explode: number
  focus: string | null
  onLoaded: (root: THREE.Object3D, parts: string[]) => void
  onFocusMeshes: (meshes: THREE.Mesh[]) => void
  /** Theme accent, used for the focus glass shell. */
  accent: string
}

function cloneForScene(source: THREE.Object3D): THREE.Object3D {
  const root = source.clone(true)
  root.traverse((node) => {
    if (node instanceof THREE.Mesh) {
      node.material = Array.isArray(node.material) ? node.material.map((m) => m.clone()) : (node.material as THREE.Material).clone()
      node.castShadow = true
      node.receiveShadow = true
    }
  })
  return root
}

/** Scale and centre so the model sits on the floor at the origin. */
function fitTransform(root: THREE.Object3D): { scale: number; offset: THREE.Vector3 } {
  const box = new THREE.Box3().setFromObject(root)
  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())
  const scale = MODEL_SIZE / Math.max(size.x, size.y, size.z, 1e-6)
  return { scale, offset: new THREE.Vector3(-center.x * scale, -box.min.y * scale, -center.z * scale) }
}

function collectMeshes(object: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = []
  object.traverse((n) => {
    if (n instanceof THREE.Mesh) out.push(n)
  })
  return out
}

export function Model({ url, explode, focus, onLoaded, onFocusMeshes, accent }: ModelProps) {
  const gltf = useGLTF(url)
  const root = useMemo(() => cloneForScene(gltf.scene), [gltf])
  const fit = useMemo(() => fitTransform(root), [root])
  const explodeStartedAt = useRef(0)
  const lastExplode = useRef(0)

  const meshStates = useMemo<MeshState[]>(
    () =>
      collectMeshes(root).map((mesh) => {
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        return {
          mesh,
          materials,
          baseOpacity: materials.map((m) => m.opacity),
          baseTransparent: materials.map((m) => m.transparent),
          dim: 1,
          dimVelocity: 0,
        }
      }),
    [root],
  )

  const parts = useMemo(() => collectParts(root), [root])

  const anims = useMemo<PartAnim[]>(() => {
    const top = [...parts.values()].filter((p) => p.topLevel)
    const modelBox = new THREE.Box3().setFromObject(root)
    const c = modelBox.getCenter(new THREE.Vector3())
    const radius = modelBox.getSize(new THREE.Vector3()).length() / 2
    const layouts = top.map((p) => {
      const pc = new THREE.Box3().setFromObject(p.object).getCenter(new THREE.Vector3())
      return { name: p.name, center: [pc.x, pc.y, pc.z] as V3 }
    })
    const plan = planExplode([c.x, c.y, c.z], radius, layouts)
    return plan.flatMap((step) => {
      const record = parts.get(step.name)
      if (!record) return []
      return [{ object: record.object, rest: record.restPosition.clone(), offset: new THREE.Vector3(...step.offset), delayMs: step.delayMs, progress: 0, velocity: 0 }]
    })
  }, [root, parts])

  // Register the model (not during render), and release its GPU resources when it goes.
  useEffect(() => {
    sceneRegistry.setModel(root, parts)
    return () => {
      if (sceneRegistry.root === root) sceneRegistry.setModel(null)
      for (const s of meshStates) s.materials.forEach((m) => m.dispose())
    }
  }, [root, parts, meshStates])

  useEffect(() => {
    onLoaded(root, [...parts.keys()])
  }, [root, parts, onLoaded])

  const focusMeshes = useMemo(() => {
    if (!focus) return new Set<THREE.Mesh>()
    const record = parts.get(focus)
    return new Set(record ? collectMeshes(record.object) : [])
  }, [focus, parts])

  useEffect(() => onFocusMeshes([...focusMeshes]), [focusMeshes, onFocusMeshes])

  // Glass shell around the focused part: real transmission, tinted with the accent.
  const shellMaterial = useMemo(
    () =>
      new THREE.MeshPhysicalMaterial({
        color: accent,
        emissive: accent,
        emissiveIntensity: 0.35,
        transmission: 1,
        roughness: 0.12,
        thickness: 0.35,
        ior: 1.35,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      }),
    [accent],
  )
  const shellOpacity = useRef({ value: 0, velocity: 0 })
  useEffect(() => {
    const shells = [...focusMeshes].map((mesh) => {
      const shell = new THREE.Mesh(mesh.geometry, shellMaterial)
      shell.name = '__focus_shell__'
      shell.scale.setScalar(SHELL_SCALE)
      shell.renderOrder = 10
      mesh.add(shell)
      return shell
    })
    shellOpacity.current = { value: 0, velocity: 0 }
    return () => shells.forEach((s) => s.removeFromParent())
  }, [focusMeshes, shellMaterial])
  useEffect(() => () => shellMaterial.dispose(), [shellMaterial])

  useFrame((_, dt) => {
    const target = clampExplode(explode)
    if (target !== lastExplode.current) {
      lastExplode.current = target
      explodeStartedAt.current = performance.now()
    }
    const elapsed = performance.now() - explodeStartedAt.current
    for (const a of anims) {
      if (elapsed >= a.delayMs) {
        ;[a.progress, a.velocity] = stepSpring(a.progress, a.velocity, target, dt, 'gentle')
      }
      a.object.position.copy(a.rest).addScaledVector(a.offset, a.progress)
    }
    const dimTarget = presets.focus.dimOpacity
    for (const s of meshStates) {
      const goal = focus && focusMeshes.size > 0 && !focusMeshes.has(s.mesh) ? dimTarget : 1
      ;[s.dim, s.dimVelocity] = stepSpring(s.dim, s.dimVelocity, goal, dt, presets.focus.spring)
      s.materials.forEach((m, i) => {
        const dimmed = s.dim < 0.995
        m.opacity = (s.baseOpacity[i] ?? 1) * s.dim
        m.transparent = dimmed || (s.baseTransparent[i] ?? false)
        m.depthWrite = s.dim > 0.5
      })
    }
    const so = shellOpacity.current
    ;[so.value, so.velocity] = stepSpring(so.value, so.velocity, focusMeshes.size > 0 ? SHELL_OPACITY : 0, dt, 'standard')
    shellMaterial.opacity = so.value
  })

  return (
    <group scale={fit.scale} position={fit.offset}>
      <primitive object={root} />
    </group>
  )
}
