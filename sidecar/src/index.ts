import { createSidecar } from './app'
import { logger } from './log'

const log = logger('main')

async function main(): Promise<void> {
  const sidecar = await createSidecar()
  log.info(`ready on port ${sidecar.port}; MCP at http://127.0.0.1:${sidecar.port}/mcp`)
  let closing = false
  const shutdown = async (signal: string) => {
    if (closing) return
    closing = true
    log.info(`${signal}: shutting down`)
    await sidecar.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  // Tauri sets this and closes our stdin when the app quits.
  if (process.env.WB_EXIT_ON_STDIN === '1') {
    process.stdin.on('end', () => void shutdown('stdin closed'))
    process.stdin.resume()
  }
}

main().catch((error: unknown) => {
  log.error('failed to start', error)
  process.exit(1)
})
