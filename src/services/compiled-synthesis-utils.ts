export function trimRequired(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label} is required`)
  return normalized
}

export function normalizeJson(value: unknown): string {
  return JSON.stringify(value ?? null)
}
