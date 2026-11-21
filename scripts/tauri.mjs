// Runs the Tauri CLI. On Windows it builds with the MSVC Rust toolchain
// (the GNU toolchain needs MinGW's dlltool, which Tauri's deps call).
import { spawn } from 'node:child_process'

const env = { ...process.env }
if (process.platform === 'win32' && !env.RUSTUP_TOOLCHAIN) env.RUSTUP_TOOLCHAIN = 'stable-x86_64-pc-windows-msvc'

const child = spawn('npx', ['tauri', ...process.argv.slice(2)], { stdio: 'inherit', env, shell: process.platform === 'win32' })
child.on('exit', (code) => process.exit(code ?? 1))
