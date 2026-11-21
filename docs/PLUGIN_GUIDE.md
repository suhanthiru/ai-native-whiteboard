# Building a whiteboard skill (plugin)

A **skill** is a plugin: a folder of TypeScript that adds tools, canvas shapes,
3D scene objects, panels or data sources. The app hot-loads it, design-lints
it, runs its test, previews it, and asks the user to keep it. Once kept, the
next request like it is a single tool call. Build a skill whenever someone asks
for a kind of thing that has no tool yet and could be asked again.

## When to build one

The user states goals, not build orders. "Animate the atoms", "pull an
electron off", "strip the leaves off this tree", "build a moving car", "pull up
the SO-101 files", "play this video" are all requests to make it happen,
writing whatever code that takes. Never wait to be told to build a skill.

1. `list_skill_trees` first. If a skill does it, use it.
2. If one is close, **extend** it (`read_plugin`, `update_plugin`): add a tool
   or a parameter and bump the version. The atom skill learns `ionize_atom`;
   the tree skill learns `remove_leaves`.
3. If nothing is close, **build** a new skill and file it in a tree.
4. Make tools **general**: take the element, the equation, the file, the speed
   as parameters. "show carbon" and "show neon" are the same tool.
5. Use `run_code` only for a one-off calculation nobody will ask for again.

## Skill trees

Every skill belongs to a tree: a domain such as `chemistry`, `botany`,
`robotics`, `vehicles`, `video`, `math`. Trees grow over time and the user
browses them in the app's **Skills** view. Each skill is a node; edges point
from the skills it builds on.

- Reuse an existing tree name when the domain fits; start a new tree for a new
  domain. Tree names are lowercase with dashes.
- Split a big goal into a small tree instead of one huge plugin. "Build a
  moving car": `car-body` (shape), `wheels` (parts), `drive-car` (parents
  `car-body` and `wheels`, animates them by calling their tools with
  `api.callTool`). Each skill is useful on its own and the next goal reuses it.
- A skill may build on skills in other trees (a `molecule-dynamics` skill in
  `physics` with parent `atom` from `chemistry`).
- Write the `explainer` for a person: two or three plain sentences on what it
  does and how to ask for it. Add a few `examples` of what they might say.

### Previews

The first `call_plugin_tool` call of a skill that has no preview records a
5-second clip while the tool runs: video of the 3D scene, or a PNG of new
canvas shapes, set by `skill.preview` (`scene`, `canvas` or `none`). It shows
in the skill's tooltip. Make that first call a good showcase (a colourful
element, a full animation). Re-record with `record_skill_preview`.

## How to build one (through MCP)

1. `get_plugin_guide` (this text), once per session.
2. `create_plugin` with `name`, `manifest`, `files` (path to source text) and
   `scope` (`shared` for every board, `board` for the open board only). The user
   approves the write in the app. The result reports the design lint and test.
3. If it failed, read the errors, fix them with `update_plugin` (send only the
   files that change), and try again. Stop after three failed attempts and say
   what is blocking you.
4. When it passes, the plugin is in **preview** and its tools are live. Call the
   new tool with `call_plugin_tool` to finish the user's request (your tool list
   may not have refreshed yet); that call also records the skill's preview.
   Tell the user to click **Keep** in the app.
5. To change an existing plugin: `read_plugin`, then `update_plugin`. Every
   edit is linted, tested and offered for keeping again.

From a Claude Code session in this repo you can also write the files directly
under `plugins/<name>/` (or `boards/<board>/plugins/<name>/`); the app watches
both folders and runs the same pipeline.

## Folder layout

```
plugins/<name>/
  manifest.json     written by create_plugin from the manifest you pass
  index.tsx         frontend entry (shapes, tools, scene objects, panels)
  plugin.test.ts    required; vitest + jsdom; must pass before the user sees it
  package.json      only if you need npm packages (the user approves the install)
  backend.ts        optional backend adapter (Node, for reading big files)
  *.ts              any helpers
```

`name` is lowercase letters, digits and dashes, starts with a letter, 2-48
characters, and equals the folder name.

## manifest

```json
{
  "name": "latex",
  "version": "1.0.0",
  "description": "LaTeX equations on the canvas, rendered with KaTeX.",
  "adds": { "shapes": ["latex"], "panels": [], "tools": ["show_equation"], "dataSources": [] },
  "requires": [],
  "frontend": "index.tsx",
  "test": "plugin.test.ts",
  "skill": {
    "tree": "math",
    "parents": [],
    "explainer": "Typesets any LaTeX equation as a card on the board. Ask for an equation by name or dictate it.",
    "examples": ["show the quadratic formula", "write Maxwell's equations"],
    "preview": "canvas"
  }
}
```

- `skill` places it in the skill trees (see above). Every field has a default,
  but always set `tree`, `explainer` and `examples`.
- `version` is semver. Bump it on every update.
- `adds.tools` lists the tool names you register. Claude sees them as
  `plugin_<name>_<tool>` (dashes in the name become underscores).
- `requires` disables the plugin until the open board has the data, e.g.
  `[{ "type": "file", "pattern": "*.qsm.txt", "hint": "Put a TreeQSM cylinder file in data/" }]`.
  Types: `mcap` (optionally `topics`), `glb`, `pointcloud`, `file`. Leave it
  empty when the tool can explain a missing file itself.
- `backend` names a backend adapter file. Backends have no network unless
  `"permissions": { "network": true }` is set (the user sees that).

## Frontend API (`import { definePlugin } from '@wb/sdk'`)

```tsx
import { z } from 'zod'
import { definePlugin } from '@wb/sdk'

export default definePlugin({
  setup(api) {
    api.registerTool({
      name: 'show_equation',
      description: 'Render a LaTeX equation on the canvas. Returns the shape id.',
      input: z.object({ latex: z.string().min(1).max(5000), x: z.number().optional(), y: z.number().optional() }),
      run: ({ latex, x, y }) => ({ id: api.canvas.createShape({ type: 'latex', x, y, props: { latex } }), text: 'Equation on the canvas.' }),
    })
    return () => { /* optional cleanup on unload */ }
  },
})
```

What `api` gives you:

| Area | Members |
|------|---------|
| Tools | `registerTool({ name, description, input: zodSchema, run, requiresApproval? })`. `run` returns a string or an object (an object's `text` is what Claude reads). Anything that moves hardware sets `requiresApproval: true`. |
| Canvas | `registerShape(ShapeUtilClass)`, `canvas.createShape({ type, x?, y?, props })`, `updateShape(id, props)`, `deleteShape(id)`, `viewportCenter()`, `zoomTo(id)`, `canvas.editor` (raw tldraw Editor) |
| 3D scene | `scene.addObject(id, object3D, { attachTo?: partName })`, `removeObject(id)`, `part(name)`, `root()`, `parts()`, `onModelChange(fn)`, `onFrame((dt) => ...)`, `invalidate()`. Import three normally: `import * as THREE from 'three'`. |
| Panels | `registerPanel({ id, title, component, width?, height? })`, `panels.open(id, props, { anchorPart? })` |
| Data | `board.data.list()`, `board.data.url(path)` (fetch board files from the frontend), `board.config()`, `subscribe(topic, fn)`, `publish(topic, data)`, `bus.latest(topic)` |
| Look | `design.theme().colors` (`surface`, `surfaceStrong`, `hairline`, `textPrimary`, `textSecondary`, `accent`, `accentSoft`, `danger`, `success`, ...), `design.dataColor(kind)`, `design.font`, `design.space`, `design.radius`, `design.typeSize(theme, 'md')` |
| Motion | `motion.springs`, `motion.durations`, `motion.presets`, `motion.cssTransition(...)`; `ui.Enter`, `ui.Reveal`, `ui.GlassPanel`, `ui.useTheme`, `ui.useBusLatest` |
| Other | `callTool(mcpName, args)`, `log(message)`, `role` (`control` or `output`) |

Modules the app provides (import them, never add them to package.json):
`react`, `react/jsx-runtime`, `react-dom`, `three`, `@react-three/fiber`,
`@react-three/drei`, `tldraw`, `@wb/sdk`, `zod`, `motion/react`.
Frontends cannot import `node:*`, `fs`, `path`, `http` and similar; read files
with `board.data.url(path)` + `fetch`, or use a backend adapter.

### Canvas shapes

Follow `plugins/mermaid/index.tsx`: build the ShapeUtil class inside a function
that receives `api`, extend `BaseBoxShapeUtil` from `tldraw`, declare `static
type` and `static props` (with `T` validators), and render with
`HTMLContainer className="wb-glass wb-glass--strong"`.

## Design lint (the plugin is rejected if it fails)

UI files (everything except the test and the backend) must not contain:

- colour literals: `#fff`, `rgb(...)`, `hsl(...)`, `oklch(...)`, or a literal
  string for `color`, `background`, `fill`, `stroke`, `border`, `boxShadow`...
  Take colours from `api.design` (theme colours or `dataColor(kind)`). For
  three.js materials pass `new THREE.Color(api.design.dataColor('state'))`.
- timing literals: `'300ms'`, `duration: 0.3`, `stiffness: 200`, a literal
  `transition`/`animation`. Use `api.motion`.
- `setTimeout`/`setInterval`, unless the line or a comment before it says
  `// wb-allow-timer: <reason>` and it is not animation.

Inline `eslint-disable` comments are ignored.

## The test (required)

`plugin.test.ts` runs with vitest in jsdom. Use the SDK test API:

```ts
import { describe, expect, it } from 'vitest'
import { setupForTest } from '@wb/sdk/testing'
import plugin from './index'

describe('latex plugin', () => {
  it('registers its shape and tool', async () => {
    const api = await setupForTest(plugin)
    expect(api.recorded.tools.map((t) => t.name)).toEqual(['show_equation'])
  })
  it('puts the equation on the canvas', async () => {
    const api = await setupForTest(plugin)
    await api.runTool('show_equation', { latex: 'E = mc^2' })
    expect(api.recorded.canvasShapes[0]?.props?.latex).toBe('E = mc^2')
  })
  it('rejects empty input', async () => {
    const api = await setupForTest(plugin)
    await expect(api.runTool('show_equation', { latex: '' })).rejects.toThrow()
  })
})
```

`api.runTool(name, args)` runs one of your own tools the way the core does
(validates input, then calls `run`). `api.callTool` only records calls your
plugin makes to other tools. `api.recorded` holds `shapes`, `panels`, `tools`,
`canvasShapes`, `sceneObjects` (a Map), `openedPanels`, `toolCalls`, `logs`.
`setupForTest(plugin, { parts, three, boardConfig })` lets you fake model parts
and pass `three` (`import * as THREE from 'three'`) for scene tests. Test pure
helpers (geometry builders, parsers) directly; they are where bugs hide.

## npm packages

Add a `package.json` with `"dependencies"` only for packages the app does not
provide (e.g. `katex`). They install with scripts disabled after the user
approves. Prefer small, well-known packages. Bundle CSS by importing it
(`import 'katex/dist/katex.min.css'` is fine).

## Backend adapters (big files, parsing, live data)

```ts
import { defineAdapter } from '@wb/sdk'
export default defineAdapter({
  async start(api) {
    api.registerTool({
      name: 'load_tree',
      description: 'Parse a QSM cylinder file from data/ and publish it.',
      inputSchema: { type: 'object', properties: { file: { type: 'string' } }, required: ['file'] },
      run: async ({ file }) => { const bytes = await api.board.data.read(String(file)); /* parse */ api.publish('qsm/tree', cylinders); return 'Loaded.' },
    })
  },
})
```

Backends run in a separate Node process with read access to the board's
`data/` only and no network. Use them when a file is too big to fetch into the
page or needs Node to parse; otherwise keep everything in the frontend.

## Reaching beyond the SDK

Skills can do essentially anything a browser page or a sandboxed Node process
can:

- **Packages**: physics (`cannon-es`), video players, file parsers (URDF, STL,
  PDF), audio, charts. Declare them in `package.json`; the user approves.
- **Media**: play a video or audio file from `data/` in a panel with
  `<video src={api.board.data.url(file)}>`.
- **Files from the internet** (a robot arm's model files, a dataset): a backend
  adapter with `"permissions": { "network": true }` downloads them into the
  board's `data/` through tools; the user sees and approves network access.
- **Animation and simulation**: drive state in `scene.onFrame(dt)`; take
  springs and timings from `api.motion`.
- **Composition**: call another skill's tool with `api.callTool(name, args)`
  and list it in `skill.parents`.
- **Modifying what is on screen**: model parts are `scene.part(name)` (move,
  rotate, hide via `object.visible`); your own objects are whatever you added.

If something truly needs the core (a new SDK capability), say so plainly
instead of reaching around `@wb/sdk`.

## Recipes

- **LaTeX equation**: `package.json` with `katex`; a `latex` shape whose body
  sets `innerHTML` from `katex.renderToString(latex, { throwOnError: false,
  displayMode: true })` and colours text with `design.theme().colors.textPrimary`;
  tool `show_equation({ latex, x?, y? })`; tool `update_equation({ id, latex })`.
- **3D atom model**: no packages. Keep a small table of elements (symbol,
  protons, neutrons, shell occupancy 2-8-18-32...). Build a `THREE.Group`: a
  nucleus of spheres, one ring per shell, electrons as small spheres. Animate
  with `scene.onFrame(dt => group.rotation.y += dt * speed)`. Tool
  `show_atom({ element })` accepts a symbol or name and calls
  `scene.addObject('atom', group)`; tool `hide_atom()`. Test the shell table and
  the group builder.
- **Tree QSM (quantitative structure model)**: the user puts a TreeQSM
  cylinder export (CSV/TXT: start xyz, axis xyz, length, radius, branch order)
  in the board's `data/`. Tool `show_tree_qsm({ file })` fetches it with
  `board.data.url(file)`, parses rows into cylinders, and builds one
  `THREE.InstancedMesh` of cylinders coloured by branch order with
  `design.dataColor`. If the file is missing, return an error that names the
  expected file; never invent a tree. Test the parser with a small inline sample.

## Rules

- Never invent data. If a file, topic or value is missing, say so in the tool
  result.
- Validate every tool input with zod and keep limits (string lengths, counts).
- Keep files small and focused; put parsing and geometry in plain functions
  you can test.
- Do not put secrets, user data or absolute paths in a plugin.
