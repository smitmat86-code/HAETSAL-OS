export function trimRequired(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label} is required`)
  return normalized
}

export function normalizeJson(value: unknown): string {
  return JSON.stringify(value ?? null)
}

export function slugifyStableSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function stableSubjectSegment(stableKey: string, fallback: string): string {
  const parts = stableKey
    .split(':')
    .map(part => part.trim())
    .filter(Boolean)
  const explicit = parts.length > 0 ? parts[parts.length - 1] : ''
  return slugifyStableSegment(explicit || fallback)
}
