type EdgeLike = {
  capture_id: string
  document_id: string
  scope: string
  source_system: string
  source_ref: string | null
  title: string | null
}

const slugify = (value: string | null | undefined) =>
  (value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
const normalize = (value: string | null | undefined) =>
  (value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '')
const titleCase = (value: string) => value.replace(/\b([a-z])/g, (_, letter: string) => letter.toUpperCase())

export function parseCanonicalGraphEdgeKey(canonicalKey: string) {
  const match = canonicalKey.match(/^canonical:\/\/edges\/(.+):([^:]+):(.+?)(?:@(\d+))?$/)
  return match ? { fromKey: decodeURIComponent(match[1]!), relation: match[2]!, toKey: decodeURIComponent(match[3]!), eventAt: match[4] ? Number(match[4]) : null } : null
}

export function humanizeCanonicalGraphKey(key: string): string {
  return decodeURIComponent(key.split('/').at(-1) ?? key).replace(/[-_]+/g, ' ').trim() || key
}

export function labelCanonicalGraphEntity(key: string, row: EdgeLike): string {
  if (key === `canonical://captures/${row.capture_id}`) return row.title?.trim() || row.capture_id
  if (key === `canonical://documents/${row.document_id}`) return row.title?.trim() || row.document_id
  if (key === `canonical://scopes/${row.scope}`) return row.scope
  if (key === `canonical://topics/${slugify(row.title)}` && row.title) return row.title.trim()
  if (key === 'canonical://participants/user') return 'User'
  if (key === 'canonical://participants/assistant') return 'Assistant'
  if (key.startsWith('canonical://sources/')) return row.source_ref?.trim() || row.source_system
  if (key.startsWith('canonical://people/') || key.startsWith('canonical://organizations/') || key.startsWith('canonical://projects/')) {
    return titleCase(humanizeCanonicalGraphKey(key))
  }
  return humanizeCanonicalGraphKey(key)
}

export function matchesCanonicalGraphEntity(query: string, key: string, row: EdgeLike): boolean {
  const needle = normalize(query)
  if (!needle) return false
  return [key, labelCanonicalGraphEntity(key, row), humanizeCanonicalGraphKey(key)].some(value => {
    const normalized = normalize(value)
    return normalized === needle || normalized.includes(needle) || needle.includes(normalized)
  })
}
