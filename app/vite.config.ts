import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: Number(process.env.VITE_PORT ?? 1420),
    strictPort: true,
    host: '127.0.0.1',
  },
  envPrefix: ['VITE_', 'TLDRAW_'],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
  },
})
