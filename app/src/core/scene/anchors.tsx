/**
 * Screen positions of 3D parts, so DOM panels can sit next to a part
 * ("focus on the left encoder, show it live").
 */
import { useEffect, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { sceneRegistry } from './registry'

export interface AnchorPoint {
  x: number
  y: number
  visible: boolean
}

const positions = new Map<string, AnchorPoint>()
const listeners = new Set<() => void>()
const box = new THREE.Box3()
const v = new THREE.Vector3()

interface AnchorProjectorProps {
  parts: string[]
}

/** Lives inside the R3F Canvas; projects the requested parts every frame. */
export function AnchorProjector({ parts }: AnchorProjectorProps) {
  useFrame(({ camera, size }) => {
    if (!parts.length) return
    for (const name of parts) {
      const record = sceneRegistry.parts.get(name)
      if (!record) {
        positions.delete(name)
        continue
      }
      box.setFromObject(record.object).getCenter(v)
      v.project(camera)
      positions.set(name, { x: ((v.x + 1) / 2) * size.width, y: ((1 - v.y) / 2) * size.height, visible: v.z > -1 && v.z < 1 })
    }
    for (const l of listeners) l()
  })
  return null
}

export function useAnchor(part: string | undefined): AnchorPoint | null {
  const [point, setPoint] = useState<AnchorPoint | null>(null)
  useEffect(() => {
    if (!part) return undefined
    let frame = 0
    const listener = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        const p = positions.get(part)
        setPoint((prev) => (p && (!prev || Math.abs(prev.x - p.x) > 0.5 || Math.abs(prev.y - p.y) > 0.5 || prev.visible !== p.visible) ? { ...p } : prev))
      })
    }
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [part])
  return point
}
