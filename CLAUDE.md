# AI-native whiteboard

A Tauri desktop app: a tldraw canvas plus a three.js viewer, driven by voice
and by Claude through an MCP server. The whiteboard is meant to **grow**: when
someone asks for something no tool covers and it could be asked again, build a
plugin (a "skill") for it instead of a one-off answer.

## Layout

- `app/` React frontend (control window and output/projector window).
- `sidecar/` Node process: boards, plugin manager, tool registry, MCP server
  (`sidecar/src/mcp/server.ts`), voice pipeline (`sidecar/src/voice/`).
- `packages/sdk/` `@wb/sdk`: the plugin contract, design and motion tokens,
  test helpers. Plugins touch the core only through it.
- `plugins/` shared plugins (every board). `boards/<board>/plugins/` board-only.
- `sidecar/src/skills/` tools that let Claude create, read and update plugins,
  call fresh plugin tools, and keep notes.
- `voice/` Python speech-to-text and text-to-speech workers.

## Commands

- `npm run dev` web + sidecar; `npm run app` the Tauri app.
- `npm test` unit tests (vitest); `npm run typecheck`; `npm run e2e`.
- `npm run plugins:install` installs shared plugins' npm dependencies.

## Building skills (plugins)

Read and follow `docs/PLUGIN_GUIDE.md` before writing a plugin.
@docs/PLUGIN_GUIDE.md

## Rules for core changes

- Plugins never reach around `@wb/sdk`. If a plugin needs something the SDK
  lacks, change the core API instead.
- Anything that moves hardware needs `requiresApproval: true`.
- Never invent sensor or board data; say what is missing.
- Core tools validate input with zod (`defineCoreTool`). Keep tool results
  short and factual; Claude reads them.
- Sidecar tests live in `sidecar/test/`; plugin tests in each plugin folder.
