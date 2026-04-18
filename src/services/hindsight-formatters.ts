export function buildHindsightDocumentId(
  tenantId: string,
  source: string,
  dedupHash: string,
): string {
  return `${tenantId}:${source}:${dedupHash}`
}

export function buildHindsightTags(
  tenantId: string,
  domain?: string,
  source?: string,
): string[] {
  const tags = [`tenant:${tenantId}`]
  if (domain) tags.push(`domain:${domain}`)
  if (source) tags.push(`source:${source}`)
  return tags
}

export function buildRetainContext(
  source: string,
  provenance: string | undefined,
  domain: string | undefined,
): string {
  const context = [`source=${source}`]
  if (provenance) context.push(`provenance=${provenance}`)
  if (domain) context.push(`domain=${domain}`)
  return context.join(' ')
}
