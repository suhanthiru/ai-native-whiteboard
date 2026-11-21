import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './core/design/global.css'
import { applyTheme, ThemeProvider } from './core/design/theme'
import { connectBusToSidecar } from './core/bus'
import { installCoreGlobals } from './core/plugins/coreGlobals'
import { sidecar } from './core/rpc/client'
import { ControlApp } from './shell/ControlApp'
import { OutputApp } from './shell/OutputApp'
import { listenGlobalPtt, windowRole } from './shell/tauri'

async function boot(): Promise<void> {
  const role = await windowRole()
  const theme = applyTheme(role === 'output' ? 'projector' : 'glass')
  installCoreGlobals()
  connectBusToSidecar()
  sidecar.connect(role)
  if (role === 'control') void listenGlobalPtt()
  const root = document.getElementById('root')
  if (!root) throw new Error('#root is missing')
  createRoot(root).render(
    <StrictMode>
      <ThemeProvider theme={theme}>{role === 'output' ? <OutputApp /> : <ControlApp />}</ThemeProvider>
    </StrictMode>,
  )
}

void boot()
