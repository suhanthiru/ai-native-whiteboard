# AI-native whiteboard

A desktop whiteboard and 3D viewer you drive by voice or text: "pull up the
Titan", "explode it, focus on the left wheel encoder, explain it", "show me the
sensors in action", "make a POMDP explainer". Claude never clicks the UI. The
app exposes its own MCP tools, and new abilities arrive as hot-loaded plugins.

```
Tauri shell ── control window (glass)  ── output window (projector theme + keystone)
     │                 │ WebSocket
     └── Node sidecar: MCP server · boards · plugin loader · data bus relay · voice loop
```

## Quick start

```powershell
npm install
npm run plugins:install   # npm deps of the shared plugins (install scripts off)
npm run make:demo         # procedural Titan model + SYNTHETIC sensor log for the demo board
npm run dev               # sidecar + web UI at http://127.0.0.1:1420
npm run app               # the Tauri desktop app (Windows builds with the MSVC Rust toolchain)
```

A new or changed plugin is design-linted, then waits for you to **Keep** it (a
card in the top right). None of its code runs before that. After you click Keep,
its test runs, and it loads only if the test passes. Approvals are stored by
content hash in `plugins/approved.json`, and any later edit asks again.

Use Claude Code from this folder: the sidecar writes `.mcp.json` (gitignored,
holds a local token), so Claude sees the `whiteboard` tools.

### Text commands

Type plain language to ask the brain (Claude Code), or call a tool directly:

| Command | Does |
| --- | --- |
| `/open titan` | open a board by name or alias |
| `/explode 0.6` · `/reset` | explode the model / assemble and fly home |
| `/focus left wheel encoder` | eased camera flight, dim the rest, glass highlight |
| `/annotate left_encoder \| Counts wheel ticks` | label on the part |
| `/output split` | what the projector shows: scene, canvas or split |
| `/plugin_mcap_playback_play` | any tool, with `key=value` or JSON arguments |

### Voice

Hold **Ctrl+Space** in the window (or **Ctrl+Shift+Space** anywhere when running
the desktop app), or hold the mic button. Speech-to-text and the better voices
need a one-time setup:

```powershell
python -m pip install -r voice/requirements.txt
```

Then download `kokoro-v1.0.onnx` and `voices-v1.0.bin` (kokoro-onnx releases)
into `voice/models/`. Until then, replies use the built-in Windows voice and
speech input is off (text commands still work). Set `WB_PYTHON`,
`WB_WHISPER_MODEL` or `WB_CLAUDE_BIN` to override defaults.

### Projector

Click **Output** to open the output window. **K** toggles keystone calibration:
drag the corners, or press 1-4 and use the arrow keys. **R** resets. The
calibration is saved in `.wb/output.json`.

## Boards

```
boards/<name>/
  board.json       title, aliases, model, enabled plugins, plugin config
  canvas.json      the whiteboard (saved automatically)
  data/            .glb, .mcap, point clouds (gitignored)
  data.lock.json   expected data files with sizes and sha256
  plugins/         board-only plugins (override shared ones with the same name)
```

Plugins declare the data they need. If it's missing, the plugin stays visible
but disabled and says what to add. File access is scoped to the board's `data/`.

## Plugins

See `docs/PLUGIN_GUIDE.md` and `CLAUDE.md`. In short, a plugin is a folder with
`manifest.json`, a frontend `index.tsx` (`definePlugin`), an optional backend
`adapter.ts` (`defineAdapter`, which runs in a `node --permission` child that can
read only the board's data and has networking refused), and `plugin.test.ts`. UI
must use `api.design` tokens and `api.motion` presets; the design lint rejects
literal colors and timings.

Shipped plugins: `mermaid`, `explainer` (POMDP example), `mcap-playback`,
`sensor-viz`, `stream-plot`.

## Tests

```powershell
npm test                  # unit + sidecar integration (vitest)
npm run test:cov          # with coverage
npx playwright test       # browser E2E in Edge, isolated copy of plugins and board
```

## Not built yet

Potree point clouds (lidar uses THREE.Points), live ROS 2 (Foxglove WebSocket
bridge or rosbridge), projector-camera calibration, Javi as the brain (the `Brain`
interface in `sidecar/src/voice/brain.ts` is the seam), and packaging the sidecar
as a single executable (dev needs Node on PATH). tldraw needs a license key for
production builds; set `TLDRAW_LICENSE_KEY`.
