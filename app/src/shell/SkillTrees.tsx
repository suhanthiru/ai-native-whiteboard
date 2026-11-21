import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { presets, toFramer, type PluginInfo } from '@wb/sdk'
import { Button } from '../core/design/ui'
import { buildSkillForest, matchesSkill, NODE_HEIGHT, NODE_WIDTH, treeTitle, type SkillNode, type SkillTree } from './skillTreeLayout'

const TOOLTIP_WIDTH = 340
const TOOLTIP_GAP = 12
const TOOLTIP_MAX_HEIGHT = 420
const VIEWPORT_MARGIN = 12
const ALL = '__all__'
const DOT = '·'
const PLAY = '▶'
const OPEN_QUOTE = '“'
const CLOSE_QUOTE = '”'

const STATE_DOT: Record<PluginInfo['state'], string> = { active: 'wb-dot--ok', preview: 'wb-dot--warn', pending: 'wb-dot--warn', disabled: '', error: 'wb-dot--bad' }

const enter = { initial: { opacity: presets.enter.fromOpacity, y: presets.enter.fromY, scale: presets.enter.fromScale }, animate: { opacity: 1, y: 0, scale: 1 }, exit: { opacity: presets.exit.toOpacity, y: presets.exit.toY } }

/** Which skill the tooltip is for (looked up live, so new previews show at once) and where its card is. */
interface Hover {
  name: string
  rect: DOMRect
}

/** "video" or "image", from the kind the sidecar puts in the preview URL. */
export function previewKind(url: string | undefined): 'video' | 'image' | null {
  if (!url) return null
  const kind = new URL(url, 'http://local').searchParams.get('k')
  return kind === 'png' ? 'image' : 'video'
}

function PreviewMedia({ url, name }: { url?: string; name: string }) {
  const kind = previewKind(url)
  if (!url || !kind) return <div className="wb-skill-preview wb-skill-preview--empty wb-text-xs wb-faint">No preview yet. It records the first time this skill runs.</div>
  return kind === 'image' ? (
    <img className="wb-skill-preview" src={url} alt={`${name} in action`} />
  ) : (
    <video className="wb-skill-preview" src={url} autoPlay loop muted playsInline aria-label={`${name} in action`} />
  )
}

/** Beside the node, flipped to the left when there is no room on the right, kept inside the window. */
export function tooltipPosition(rect: Pick<DOMRect, 'left' | 'right' | 'top'>, viewport: { width: number; height: number }): { left: number; top: number } {
  const right = rect.right + TOOLTIP_GAP
  const left = right + TOOLTIP_WIDTH + VIEWPORT_MARGIN <= viewport.width ? right : Math.max(VIEWPORT_MARGIN, rect.left - TOOLTIP_GAP - TOOLTIP_WIDTH)
  const top = Math.min(rect.top - 40, viewport.height - TOOLTIP_MAX_HEIGHT)
  return { left, top: Math.max(VIEWPORT_MARGIN, top) }
}

function SkillTooltip({ node, rect, pinned }: { node: SkillNode; rect: DOMRect; pinned: boolean }) {
  const { info, skill } = node
  const pos = tooltipPosition(rect, { width: window.innerWidth, height: window.innerHeight })
  return (
    <motion.div
      {...enter}
      transition={toFramer('snappy')}
      className="wb-glass wb-glass--strong wb-skill-tooltip"
      style={{ position: 'fixed', left: pos.left, top: pos.top, width: TOOLTIP_WIDTH, maxHeight: TOOLTIP_MAX_HEIGHT, overflow: 'auto', zIndex: 60, pointerEvents: pinned ? 'auto' : 'none' }}
      role="tooltip"
      data-testid="skill-tooltip"
    >
      <PreviewMedia url={info.previewUrl} name={info.name} />
      <div style={{ padding: 'var(--wb-s3) var(--wb-s4) var(--wb-s4)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className={`wb-dot ${STATE_DOT[info.state]}`} />
          <span className="wb-text-md" style={{ fontWeight: 600 }}>{info.name}</span>
          <span className="wb-text-xs wb-faint">
            v{info.version} {DOT} {info.state}
          </span>
        </div>
        <div className="wb-text-xs wb-faint" style={{ marginTop: 2 }}>
          {treeTitle(skill.tree)}
          {skill.parents.length ? ` ${DOT} builds on ${skill.parents.join(', ')}` : ''}
        </div>
        <p className="wb-text-sm" style={{ margin: 'var(--wb-s2) 0 0', whiteSpace: 'pre-wrap' }}>{skill.explainer || info.description}</p>
        {skill.examples.length > 0 && (
          <div style={{ marginTop: 'var(--wb-s3)' }}>
            <div className="wb-text-xs wb-muted">Try saying</div>
            <ul className="wb-skill-examples">
              {skill.examples.map((e) => (
                <li key={e} className="wb-text-sm">
                  {OPEN_QUOTE}
                  {e}
                  {CLOSE_QUOTE}
                </li>
              ))}
            </ul>
          </div>
        )}
        {info.tools.length > 0 && <div className="wb-text-xs wb-faint wb-mono" style={{ marginTop: 'var(--wb-s3)', wordBreak: 'break-all' }}>{info.tools.join(' ')}</div>}
        {info.message && info.state !== 'active' && <div className="wb-text-xs wb-muted" style={{ marginTop: 'var(--wb-s2)', whiteSpace: 'pre-wrap' }}>{info.message}</div>}
      </div>
    </motion.div>
  )
}

export function edgePath(from: Pick<SkillNode, 'x' | 'y'>, to: Pick<SkillNode, 'x' | 'y'>): string {
  const x1 = from.x + NODE_WIDTH
  const y1 = from.y + NODE_HEIGHT / 2
  const x2 = to.x
  const y2 = to.y + NODE_HEIGHT / 2
  const bend = (x2 - x1) / 2
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`
}

interface TreeViewProps {
  tree: SkillTree
  query: string
  onHover: (h: Hover | null) => void
  onPin: (h: Hover) => void
}

function SkillCard({ node, dim, onHover, onPin }: { node: SkillNode; dim: boolean; onHover: TreeViewProps['onHover']; onPin: TreeViewProps['onPin'] }) {
  const hoverAt = (el: HTMLElement): Hover => ({ name: node.info.name, rect: el.getBoundingClientRect() })
  return (
    <button
      type="button"
      className="wb-skill-node"
      style={{ left: node.x, top: node.y, width: NODE_WIDTH, height: NODE_HEIGHT, opacity: dim ? 0.3 : 1 }}
      onMouseEnter={(e) => onHover(hoverAt(e.currentTarget))}
      onMouseLeave={() => onHover(null)}
      onFocus={(e) => onHover(hoverAt(e.currentTarget))}
      onBlur={() => onHover(null)}
      onClick={(e) => onPin(hoverAt(e.currentTarget))}
      data-testid={`skill-${node.info.name}`}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        <span className={`wb-dot ${STATE_DOT[node.info.state]}`} />
        <span className="wb-text-sm" style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.info.name}</span>
        {node.isNew && <span className="wb-skill-badge">new</span>}
        {node.info.previewUrl && (
          <span className="wb-text-xs wb-faint" title="Has a preview">
            {PLAY}
          </span>
        )}
      </span>
      <span className="wb-text-xs wb-muted wb-skill-desc">{node.info.description}</span>
      {node.crossParents.length > 0 && <span className="wb-text-xs wb-faint">uses {node.crossParents.join(', ')}</span>}
    </button>
  )
}

function TreeView({ tree, query, onHover, onPin }: TreeViewProps) {
  const byName = new Map(tree.nodes.map((n) => [n.info.name, n]))
  return (
    <section style={{ marginBottom: 'var(--wb-s6)' }} data-testid={`skill-tree-${tree.name}`}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 'var(--wb-s3)' }}>
        <span className="wb-text-lg">{treeTitle(tree.name)}</span>
        <span className="wb-text-xs wb-faint">
          {tree.nodes.length} skill{tree.nodes.length === 1 ? '' : 's'}
          {tree.newCount ? ` ${DOT} ${tree.newCount} new` : ''}
        </span>
      </div>
      <div style={{ position: 'relative', width: tree.width, height: tree.height }}>
        <svg width={tree.width} height={tree.height} style={{ position: 'absolute', inset: 0, overflow: 'visible' }} aria-hidden>
          {tree.edges.map((e) => {
            const from = byName.get(e.from)
            const to = byName.get(e.to)
            return from && to ? <path key={`${e.from}>${e.to}`} d={edgePath(from, to)} className="wb-skill-edge" /> : null
          })}
        </svg>
        {tree.nodes.map((node) => (
          <SkillCard key={node.info.name} node={node} dim={!matchesSkill(node, query)} onHover={onHover} onPin={onPin} />
        ))}
      </div>
    </section>
  )
}

function TreeTabs({ forest, selected, onSelect }: { forest: SkillTree[]; selected: string; onSelect: (name: string) => void }) {
  const all = { name: ALL, count: forest.reduce((n, t) => n + t.nodes.length, 0), fresh: forest.reduce((n, t) => n + t.newCount, 0) }
  const tabs = [all, ...forest.map((t) => ({ name: t.name, count: t.nodes.length, fresh: t.newCount }))]
  return (
    <nav className="wb-skill-sidebar" aria-label="Skill trees">
      {tabs.map((t) => (
        <button key={t.name} type="button" className="wb-skill-tree-tab" aria-pressed={selected === t.name} onClick={() => onSelect(t.name)}>
          <span>{t.name === ALL ? 'All trees' : treeTitle(t.name)}</span>
          <span className="wb-text-xs wb-faint">
            {t.count}
            {t.fresh ? ` ${DOT} new` : ''}
          </span>
        </button>
      ))}
    </nav>
  )
}

export function SkillTrees({ plugins, onClose }: { plugins: PluginInfo[]; onClose: () => void }) {
  const forest = useMemo(() => buildSkillForest(plugins), [plugins])
  const [selected, setSelected] = useState(ALL)
  const [query, setQuery] = useState('')
  const [hover, setHover] = useState<Hover | null>(null)
  const [pinned, setPinned] = useState<Hover | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (pinned) setPinned(null)
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, pinned])

  // The tooltip is placed from the card's on-screen box; drop it when that box moves.
  const clearTips = () => {
    setHover(null)
    setPinned(null)
  }
  useEffect(() => {
    window.addEventListener('resize', clearTips)
    return () => window.removeEventListener('resize', clearTips)
  }, [])

  const nodesByName = useMemo(() => new Map(forest.flatMap((t) => t.nodes.map((n) => [n.info.name, n] as const))), [forest])

  const shown = selected === ALL ? forest : forest.filter((t) => t.name === selected)
  const visible = shown.filter((t) => t.nodes.some((n) => matchesSkill(n, query)))
  const skillCount = forest.reduce((n, t) => n + t.nodes.length, 0)
  const newCount = forest.reduce((n, t) => n + t.newCount, 0)
  const tip = pinned ?? hover
  const tipNode = tip ? nodesByName.get(tip.name) : undefined

  return (
    <motion.div
      {...enter}
      transition={toFramer(presets.enter.spring)}
      className="wb-glass wb-glass--strong"
      style={{ position: 'absolute', top: 64, left: 16, right: 16, bottom: 96, zIndex: 46, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
      data-testid="skill-trees"
    >
      <div className="wb-panel-header">
        <span>
          Skills{' '}
          <span className="wb-faint" style={{ fontWeight: 400 }}>
            {DOT} {skillCount} in {forest.length} tree{forest.length === 1 ? '' : 's'}
            {newCount ? ` ${DOT} ${newCount} new` : ''}
          </span>
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input className="wb-input wb-skill-search" placeholder="Search skills" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search skills" />
          <Button icon title="Close" onClick={onClose}>
            {'×'}
          </Button>
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: '200px 1fr' }}>
        <TreeTabs forest={forest} selected={selected} onSelect={setSelected} />
        <div style={{ overflow: 'auto', padding: 'var(--wb-s5)' }} onScroll={clearTips}>
          {forest.length === 0 && (
            <div className="wb-text-sm wb-muted" style={{ maxWidth: 460 }}>
              No skills yet. Ask for anything; when no tool can do it, the whiteboard writes a skill, and it grows here as a tree.
            </div>
          )}
          {forest.length > 0 && visible.length === 0 && (
            <div className="wb-text-sm wb-muted">
              No skill matches {OPEN_QUOTE}
              {query}
              {CLOSE_QUOTE}.
            </div>
          )}
          {visible.map((tree) => (
            <TreeView key={tree.name} tree={tree} query={query} onHover={setHover} onPin={(h) => setPinned((p) => (p?.name === h.name ? null : h))} />
          ))}
        </div>
      </div>
      {/* Portalled: the panel's backdrop-filter would otherwise offset and clip a fixed tooltip. */}
      {createPortal(<AnimatePresence>{tip && tipNode && <SkillTooltip key={tip.name} node={tipNode} rect={tip.rect} pinned={!!pinned} />}</AnimatePresence>, document.body)}
    </motion.div>
  )
}
