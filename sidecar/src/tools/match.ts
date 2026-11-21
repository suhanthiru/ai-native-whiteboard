/** Fuzzy matching for spoken names: "the left wheel encoder" finds `left_encoder`. */

const HEAD_BONUS = 0.05
const FILLER = new Set(['the', 'a', 'an', 'of', 'on', 'part', 'its', 'it'])

export function tokens(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t.length > 0 && !FILLER.has(t))
}

export function scoreName(query: string, candidate: string): number {
  const q = tokens(query)
  const c = tokens(candidate)
  if (q.length === 0 || c.length === 0) return 0
  if (q.join('_') === c.join('_')) return 1
  const hits = c.filter((ct) => q.some((qt) => qt === ct || (qt.length > 2 && ct.startsWith(qt)) || (ct.length > 2 && qt.startsWith(ct)))).length
  if (hits === 0) return 0
  // Every candidate token should be covered; extra query words cost a little.
  const coverage = hits / c.length
  const precision = hits / q.length
  // In English the last word is usually the thing itself ("left wheel ENCODER").
  const head = q[q.length - 1] ?? ''
  const headBonus = c.includes(head) ? HEAD_BONUS : 0
  return Math.min(1, coverage * 0.75 + precision * 0.25 + headBonus)
}

const MIN_SCORE = 0.6

export function bestMatch(query: string, candidates: string[]): { name: string; score: number } | null {
  let best: { name: string; score: number } | null = null
  for (const name of candidates) {
    const score = scoreName(query, name)
    if (!best || score > best.score || (score === best.score && name.length < best.name.length)) best = { name, score }
  }
  return best && best.score >= MIN_SCORE ? best : null
}
