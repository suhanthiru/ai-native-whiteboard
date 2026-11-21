/**
 * Scene registry: the parts of the loaded model and the objects plugins add.
 * The Stage component reads from here every frame; plugins write through the
 * SceneApi built by `createSceneApi`.
 */
import * as THREE from 'three'
import type { PartHandle, SceneApi, SceneObjectOptions, Vec3 } from '@wb/sdk'
import { reportError } from '../errors'

export interface PartRecord {
  name: string
  object: THREE.Object3D
  restPosition: THREE.Vector3
  restQuaternion: THREE.Quaternion
  /** True for direct children of the model root: these are what explode moves. */
  topLevel: boolean
}

interface ExtraObject {
  id: string
  object: THREE.Object3D
  attachTo?: string
  owner: string
}

const ROOT_NAME = '__root__'

/** Generic node names exporters add; they are not meaningful parts. */
const GENERIC_NAME = /^(scene|root|rootnode|object|mesh|group|node|primitive)?[_.\-\s]?\d*$/i

export function isMeaningfulName(name: string): boolean {
  return name.trim().length > 0 && !GENERIC_NAME.test(name.trim())
}

/** Named parts of a model, in traversal order. Pure: does not touch the registry. */
export function collectParts(root: THREE.Object3D): Map<string, PartRecord> {
  const parts = new Map<string, PartRecord>()
  root.traverse((node) => {
    if (node === root || !isMeaningfulName(node.name) || parts.has(node.name)) return
    parts.set(node.name, { name: node.name, object: node, restPosition: node.position.clone(), restQuaternion: node.quaternion.clone(), topLevel: node.parent === root })
  })
  return parts
}

export class SceneRegistry {
  root: THREE.Object3D | null = null
  rootRest: { position: THREE.Vector3; quaternion: THREE.Quaternion } | null = null
  readonly parts = new Map<string, PartRecord>()
  readonly extrasGroup = new THREE.Group()
  private readonly extras = new Map<string, ExtraObject>()
  private readonly frameCallbacks = new Set<(dt: number) => void>()
  private readonly modelListeners = new Set<(parts: string[]) => void>()
  private invalidateFn: () => void = () => undefined

  constructor() {
    this.extrasGroup.name = 'plugin-objects'
  }

  setInvalidate(fn: () => void): void {
    this.invalidateFn = fn
  }

  invalidate(): void {
    this.invalidateFn()
  }

  setModel(root: THREE.Object3D | null, parts: Map<string, PartRecord> = root ? collectParts(root) : new Map()): void {
    this.parts.clear()
    this.root = root
    this.rootRest = root ? { position: root.position.clone(), quaternion: root.quaternion.clone() } : null
    for (const [name, record] of parts) this.parts.set(name, record)
    this.reattachExtras()
    const names = this.partNames()
    for (const l of [...this.modelListeners]) {
      try {
        l(names)
      } catch (error) {
        reportError('scene model listener', error)
      }
    }
    this.invalidate()
  }

  partNames(): string[] {
    return [...this.parts.keys()]
  }

  topLevelParts(): PartRecord[] {
    return [...this.parts.values()].filter((p) => p.topLevel)
  }

  handle(name: string): PartHandle | null {
    if (name === ROOT_NAME) return this.rootHandle()
    const record = this.parts.get(name)
    if (!record) return null
    return makeHandle(record.name, record.object, record.restQuaternion, () => this.invalidate())
  }

  rootHandle(): PartHandle | null {
    if (!this.root || !this.rootRest) return null
    return makeHandle(ROOT_NAME, this.root, this.rootRest.quaternion, () => this.invalidate())
  }

  addExtra(owner: string, id: string, object: THREE.Object3D, options: SceneObjectOptions = {}): void {
    this.removeExtra(id)
    const extra: ExtraObject = { id, object, attachTo: options.attachTo, owner }
    this.extras.set(id, extra)
    this.place(extra)
    this.invalidate()
  }

  removeExtra(id: string): void {
    const extra = this.extras.get(id)
    if (!extra) return
    extra.object.removeFromParent()
    this.extras.delete(id)
    this.invalidate()
  }

  onFrame(callback: (dt: number) => void): () => void {
    this.frameCallbacks.add(callback)
    return () => this.frameCallbacks.delete(callback)
  }

  onModelChange(listener: (parts: string[]) => void): () => void {
    this.modelListeners.add(listener)
    return () => this.modelListeners.delete(listener)
  }

  runFrame(dt: number): void {
    for (const cb of [...this.frameCallbacks]) {
      try {
        cb(dt)
      } catch (error) {
        this.frameCallbacks.delete(cb)
        reportError('scene frame callback (removed)', error)
      }
    }
  }

  private place(extra: ExtraObject): void {
    extra.object.removeFromParent()
    const target = extra.attachTo ? this.parts.get(extra.attachTo)?.object ?? (extra.attachTo === ROOT_NAME ? this.root : null) : null
    ;(target ?? this.extrasGroup).add(extra.object)
  }

  private reattachExtras(): void {
    for (const extra of this.extras.values()) this.place(extra)
  }
}

function makeHandle(name: string, object: THREE.Object3D, restQuaternion: THREE.Quaternion, invalidate: () => void): PartHandle {
  const box = new THREE.Box3()
  const v = new THREE.Vector3()
  const q = new THREE.Quaternion()
  const axisVec = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) }
  return {
    name,
    object,
    center(): Vec3 {
      box.setFromObject(object).getCenter(v)
      return [v.x, v.y, v.z]
    },
    size(): Vec3 {
      box.setFromObject(object).getSize(v)
      return [v.x, v.y, v.z]
    },
    setRotation(axis, radians) {
      q.setFromAxisAngle(axisVec[axis], radians)
      object.quaternion.copy(restQuaternion).multiply(q)
      invalidate()
    },
    setQuaternion([x, y, z, w]) {
      q.set(x, y, z, w).normalize()
      object.quaternion.copy(restQuaternion).multiply(q)
      invalidate()
    },
    resetPose() {
      object.quaternion.copy(restQuaternion)
      invalidate()
    },
  }
}

export const sceneRegistry = new SceneRegistry()

/** A SceneApi bound to one plugin. Everything it adds is removed by `dispose`. */
export function createSceneApi(plugin: string): { api: SceneApi; dispose: () => void } {
  const ids = new Set<string>()
  const offs = new Set<() => void>()
  const api: SceneApi = {
    three: THREE,
    addObject(id, object, options) {
      if (!(object instanceof THREE.Object3D)) throw new Error('scene.addObject expects a THREE.Object3D (use api.scene.three)')
      const scoped = `${plugin}:${id}`
      ids.add(scoped)
      sceneRegistry.addExtra(plugin, scoped, object, options)
    },
    removeObject(id) {
      const scoped = `${plugin}:${id}`
      ids.delete(scoped)
      sceneRegistry.removeExtra(scoped)
    },
    part: (name) => sceneRegistry.handle(name),
    root: () => sceneRegistry.rootHandle(),
    parts: () => sceneRegistry.partNames(),
    onModelChange(listener) {
      const off = sceneRegistry.onModelChange(listener)
      offs.add(off)
      return () => {
        off()
        offs.delete(off)
      }
    },
    invalidate: () => sceneRegistry.invalidate(),
    onFrame(callback) {
      const off = sceneRegistry.onFrame(callback)
      offs.add(off)
      return () => {
        off()
        offs.delete(off)
      }
    },
  }
  const dispose = () => {
    for (const id of ids) sceneRegistry.removeExtra(id)
    ids.clear()
    for (const off of offs) off()
    offs.clear()
    for (const name of sceneRegistry.partNames()) sceneRegistry.handle(name)?.resetPose()
    sceneRegistry.rootHandle()?.resetPose()
  }
  return { api, dispose }
}
