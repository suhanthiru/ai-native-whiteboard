/** IPC messages between the sidecar and a backend adapter child process. */
export interface AdapterStart {
  type: 'start'
  plugin: string
  boardName: string
  dataDir: string
  config: Record<string, unknown>
  network: boolean
}

export type ParentMessage =
  | AdapterStart
  | { type: 'callTool'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'stop' }

export interface AdapterToolInfo {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  requiresApproval?: boolean
}

export type ChildMessage =
  | { type: 'ready' }
  | { type: 'publish'; topic: string; t: number; data: unknown }
  | { type: 'publishBinary'; topic: string; t: number; meta: Record<string, unknown>; payload: Uint8Array }
  | { type: 'registerTool'; tool: AdapterToolInfo }
  | { type: 'toolResult'; id: string; ok: true; result: unknown }
  | { type: 'toolResult'; id: string; ok: false; error: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'fatal'; message: string }
