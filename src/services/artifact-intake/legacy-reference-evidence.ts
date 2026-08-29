import type { LegacyCanonicalReference } from './legacy-inventory-types'

export function groupLegacyReferences(
  references: LegacyCanonicalReference[],
): Map<string, LegacyCanonicalReference[]> {
  const grouped = new Map<string, LegacyCanonicalReference[]>()
  for (const reference of references) {
    grouped.set(reference.key, [...(grouped.get(reference.key) ?? []), reference])
  }
  return grouped
}

export function legacyReferenceIdentity(reference: LegacyCanonicalReference): string {
  return `${reference.tenantId}\0${reference.captureId}`
}

export function canonicalRoleEvidence(
  authoritative: LegacyCanonicalReference[],
  compatibility: LegacyCanonicalReference[],
): { unclear: boolean; conflict: boolean } {
  const unclear = [...authoritative, ...compatibility].some(reference => reference.role !== 'source')
  const sameIdentityAndRole = (
    reference: LegacyCanonicalReference,
    candidates: LegacyCanonicalReference[],
  ): boolean => candidates.some(candidate => (
    legacyReferenceIdentity(candidate) === legacyReferenceIdentity(reference) &&
    candidate.role === reference.role
  ))
  const conflict = authoritative.length > 0 && compatibility.length > 0 && (
    authoritative.some(reference => !sameIdentityAndRole(reference, compatibility)) ||
    compatibility.some(reference => !sameIdentityAndRole(reference, authoritative))
  )
  return { unclear, conflict }
}
