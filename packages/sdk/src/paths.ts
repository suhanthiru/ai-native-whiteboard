/**
 * Board paths are always relative and stay inside the board's data/ folder.
 * This is the platform-independent first check; the sidecar also resolves the
 * real path on disk and rejects symlinks that escape.
 */
export function normaliseBoardPath(input: string): string | null {
  if (typeof input !== 'string') return null
  const trimmed = input.trim().replace(/\\/g, '/')
  if (trimmed.length === 0 || trimmed.length > 512) return null
  if (trimmed.includes('\0')) return null
  if (trimmed.startsWith('/') || /^[a-zA-Z]:/.test(trimmed) || trimmed.startsWith('//')) return null
  const withoutPrefix = trimmed.startsWith('data/') ? trimmed.slice(5) : trimmed
  const parts = withoutPrefix.split('/').filter((p) => p.length > 0 && p !== '.')
  if (parts.length === 0) return null
  if (parts.some((p) => p === '..')) return null
  return parts.join('/')
}

/** Simple glob for data file names: `*` matches within a segment, `**` across segments. */
export function matchesPattern(path: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/\\/g, '/')
    .replace(/[.+^${}()|[\]]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '.*')
  return new RegExp(`^${escaped}$`, 'i').test(path)
}
