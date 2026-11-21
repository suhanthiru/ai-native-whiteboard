/** Pure helpers for picking and shaping a numeric series from bus messages. */

export interface Sample {
  t: number
  data: unknown
}

const PREFERRED = ['velocity', 'value', 'ticks', 'data']

export function getPath(data: unknown, path: string): unknown {
  let cur: unknown = data
  for (const key of path.split('.').filter(Boolean)) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur
}

/** Choose a numeric field: an explicit path, a preferred name, or the first number found. */
export function pickField(data: unknown, wanted?: string): string | null {
  if (typeof data === 'number') return ''
  if (!data || typeof data !== 'object') return null
  if (wanted && typeof getPath(data, wanted) === 'number') return wanted
  const obj = data as Record<string, unknown>
  for (const p of PREFERRED) if (typeof obj[p] === 'number') return p
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'number') return k
    if (v && typeof v === 'object') {
      const inner = pickField(v)
      if (inner !== null) return inner ? `${k}.${inner}` : k
    }
  }
  return null
}

export function toSeries(samples: Sample[], field: string, windowS: number): { t: number; v: number }[] {
  const last = samples[samples.length - 1]?.t ?? 0
  const out: { t: number; v: number }[] = []
  for (const s of samples) {
    if (s.t < last - windowS) continue
    const v = field === '' ? s.data : getPath(s.data, field)
    if (typeof v === 'number' && Number.isFinite(v)) out.push({ t: s.t, v })
  }
  return out
}

/** SVG polyline points for a series in a w x h box (with a little headroom). */
export function polyline(series: { t: number; v: number }[], w: number, h: number): { points: string; min: number; max: number } {
  if (series.length < 2) return { points: '', min: 0, max: 0 }
  let min = Infinity
  let max = -Infinity
  for (const s of series) {
    min = Math.min(min, s.v)
    max = Math.max(max, s.v)
  }
  const pad = (max - min) * 0.1 || 1
  const lo = min - pad
  const hi = max + pad
  const t0 = series[0]?.t ?? 0
  const t1 = series[series.length - 1]?.t ?? 1
  const span = t1 - t0 || 1
  const points = series.map((s) => `${(((s.t - t0) / span) * w).toFixed(1)},${(h - ((s.v - lo) / (hi - lo)) * h).toFixed(1)}`).join(' ')
  return { points, min, max }
}

/** Find a live topic from a loose name ("left encoder" -> "titan/left_encoder"). */
export function resolveTopic(query: string, topics: string[]): string | null {
  if (topics.includes(query)) return query
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  const scored = topics
    .map((t) => ({ t, hits: words.filter((w) => t.toLowerCase().includes(w)).length }))
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits || a.t.length - b.t.length)
  return scored[0]?.t ?? null
}
