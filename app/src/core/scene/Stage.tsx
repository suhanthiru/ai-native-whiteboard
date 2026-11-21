import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { CameraControls, ContactShadows, Environment, Lightformer } from '@react-three/drei'
import { EffectComposer, N8AO, SelectiveBloom, ToneMapping } from '@react-three/postprocessing'
import { ToneMappingMode } from 'postprocessing'
import * as THREE from 'three'
import { presets, type SceneState, type Theme } from '@wb/sdk'
import { ErrorBoundary } from '../ErrorBoundary'
import { Annotations } from './Annotations'
import { AnchorProjector } from './anchors'
import { Model, MODEL_SIZE } from './Model'
import { sceneRegistry } from './registry'

const CAMERA_HOME: [number, number, number] = [3.2, 2.1, 3.6]
const FOCUS_PADDING = 0.35

interface CameraDirectorProps {
  focus: string | null
  viewNonce: number
  modelRoot: THREE.Object3D | null
  interactive: boolean
}

/** Eased camera flights for focus and reset. Never a jump cut. */
function CameraDirector({ focus, viewNonce, modelRoot, interactive }: CameraDirectorProps) {
  const controls = useRef<CameraControls>(null)

  useEffect(() => {
    const c = controls.current
    if (!c || !modelRoot) return
    const target = focus ? sceneRegistry.parts.get(focus)?.object : modelRoot
    if (!target) return
    // The model's fit scale lives on a parent group; make sure world matrices include it.
    target.updateWorldMatrix(true, true)
    const pad = focus ? FOCUS_PADDING : FOCUS_PADDING * 0.5
    void c.fitToBox(target, true, { paddingTop: pad, paddingBottom: pad, paddingLeft: pad, paddingRight: pad })
  }, [focus, viewNonce, modelRoot])

  return (
    <CameraControls
      ref={controls}
      makeDefault
      enabled={interactive}
      smoothTime={presets.cameraFlight.smoothTime}
      draggingSmoothTime={presets.cameraFlight.smoothTime * 0.4}
      minDistance={0.2}
      maxDistance={MODEL_SIZE * 8}
    />
  )
}

function FrameDriver() {
  const invalidate = useThree((s) => s.invalidate)
  const get = useThree((s) => s.get)
  useEffect(() => sceneRegistry.setInvalidate(invalidate), [invalidate])
  useEffect(() => {
    if (import.meta.env.DEV) (globalThis as { __WB_R3F__?: unknown }).__WB_R3F__ = get
  }, [get])
  useFrame((_, dt) => sceneRegistry.runFrame(dt))
  return null
}

/** Studio lighting from soft area lights baked into an environment map. No HDRI download. */
function StudioLighting() {
  return (
    <Environment resolution={256} frames={1}>
      <Lightformer form="rect" intensity={2.2} position={[0, 4, -3]} rotation-x={Math.PI / 2.4} scale={[8, 3, 1]} />
      <Lightformer form="rect" intensity={1.4} position={[-4, 1.5, 1]} rotation-y={Math.PI / 2} scale={[4, 2, 1]} />
      <Lightformer form="rect" intensity={1.1} position={[4, 1.5, 1]} rotation-y={-Math.PI / 2} scale={[4, 2, 1]} />
      <Lightformer form="ring" intensity={0.6} position={[0, 2, 5]} scale={3} />
    </Environment>
  )
}

interface StageProps {
  scene: SceneState
  theme: Theme
  interactive: boolean
  onModelInfo?: (file: string, parts: string[]) => void
  /** Parts whose screen position panels need. */
  anchorParts?: string[]
}

export function Stage({ scene, theme, interactive, onModelInfo, anchorParts = [] }: StageProps) {
  const [modelRoot, setModelRoot] = useState<THREE.Object3D | null>(null)
  const [focusMeshes, setFocusMeshes] = useState<THREE.Mesh[]>([])
  const keyLight = useRef<THREE.DirectionalLight>(null)
  const fill = useRef<THREE.AmbientLight>(null)
  const [lights, setLights] = useState<THREE.Light[]>([])

  useEffect(() => {
    if (keyLight.current && fill.current) setLights([keyLight.current, fill.current])
  }, [])

  const handleLoaded = useCallback(
    (root: THREE.Object3D, parts: string[]) => {
      setModelRoot(root)
      if (scene.modelFile) onModelInfo?.(scene.modelFile, parts)
    },
    [onModelInfo, scene.modelFile],
  )

  useEffect(() => {
    if (!scene.model) setModelRoot(null)
  }, [scene.model])

  return (
    <Canvas
      shadows="percentage"
      dpr={[1, 2]}
      camera={{ position: CAMERA_HOME, fov: 32, near: 0.01, far: 200 }}
      gl={{ antialias: true, powerPreference: 'high-performance' }}
      data-testid="stage"
    >
      <color attach="background" args={[theme.colors.stage]} />
      <ambientLight ref={fill} intensity={0.25} />
      <directionalLight ref={keyLight} position={[3, 6, 4]} intensity={1.2} castShadow shadow-mapSize={[1024, 1024]} />
      <StudioLighting />
      <FrameDriver />
      <AnchorProjector parts={anchorParts} />
      <ErrorBoundary source="3D model" fallback={null} resetKey={scene.model ?? ''}>
        <Suspense fallback={null}>
          {scene.model && (
            <Model url={scene.model} explode={scene.explode} focus={scene.focus} onLoaded={handleLoaded} onFocusMeshes={setFocusMeshes} accent={theme.colors.accent} />
          )}
        </Suspense>
      </ErrorBoundary>
      <primitive object={sceneRegistry.extrasGroup} />
      <Annotations annotations={scene.annotations} />
      <ContactShadows position={[0, -0.001, 0]} opacity={0.55} scale={MODEL_SIZE * 4} blur={2.6} far={MODEL_SIZE * 1.5} resolution={512} />
      <CameraDirector focus={scene.focus} viewNonce={scene.viewNonce} modelRoot={modelRoot} interactive={interactive} />
      <EffectComposer multisampling={4}>
        <N8AO aoRadius={0.4} distanceFalloff={0.6} intensity={2.2} halfRes quality="medium" />
        <SelectiveBloom selection={focusMeshes} lights={lights} intensity={0.9} luminanceThreshold={0.15} luminanceSmoothing={0.4} mipmapBlur radius={0.6} />
        <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
      </EffectComposer>
    </Canvas>
  )
}
