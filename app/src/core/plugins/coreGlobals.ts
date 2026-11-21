/**
 * The modules plugins import at runtime (see sidecar/src/plugins/bundler.ts
 * CORE_MODULES). One copy of each lives in the page; plugin bundles read them
 * from globalThis.__WB_CORE__.
 */
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import * as ReactDOM from 'react-dom'
import * as THREE from 'three'
import * as fiber from '@react-three/fiber'
import * as drei from '@react-three/drei'
import * as tldraw from 'tldraw'
import * as sdk from '@wb/sdk'
import * as zod from 'zod'
import * as motion from 'motion/react'

declare global {
  var __WB_CORE__: Record<string, unknown> | undefined
}

export function installCoreGlobals(): void {
  globalThis.__WB_CORE__ = {
    react: React,
    'react/jsx-runtime': jsxRuntime,
    'react-dom': ReactDOM,
    three: THREE,
    '@react-three/fiber': fiber,
    '@react-three/drei': drei,
    tldraw,
    '@wb/sdk': sdk,
    zod,
    'motion/react': motion,
  }
}
