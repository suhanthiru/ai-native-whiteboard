import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import * as THREE from 'three'
import type { Annotation } from '@wb/sdk'
import { Reveal } from '../motion'
import { sceneRegistry } from './registry'

/** Screen-space offset of the label from the part, in px. */
const LEADER = { dx: 56, dy: -44 }

interface AnnotationLabelProps {
  annotation: Annotation
}

function AnnotationLabel({ annotation }: AnnotationLabelProps) {
  const group = useRef<THREE.Group>(null)
  const box = useRef(new THREE.Box3())
  const center = useRef(new THREE.Vector3())

  useFrame(() => {
    const record = sceneRegistry.parts.get(annotation.part)
    if (!record || !group.current) return
    box.current.setFromObject(record.object).getCenter(center.current)
    group.current.position.copy(center.current)
  })

  return (
    <group ref={group}>
      <Html zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
        <Reveal line={{ x1: 0, y1: 0, x2: LEADER.dx, y2: LEADER.dy }}>
          <div style={{ position: 'absolute', left: LEADER.dx, top: LEADER.dy, transform: 'translate(0, -50%)' }}>
            <div className="wb-label" data-testid={`annotation-${annotation.part}`}>
              {annotation.text}
            </div>
          </div>
        </Reveal>
      </Html>
    </group>
  )
}

interface AnnotationsProps {
  annotations: Annotation[]
}

export function Annotations({ annotations }: AnnotationsProps) {
  return (
    <>
      {annotations.map((a) => (
        <AnnotationLabel key={a.id} annotation={a} />
      ))}
    </>
  )
}
