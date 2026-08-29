/**
 * One structural contract for every non-empty canonical artifact manifest,
 * shared by capture normalization and the canonical store write path so the
 * layers cannot drift from the artifact-intake finalization schema again:
 * exactly one source, listed first, with no parent, and it is the only
 * primary artifact; every derivative names a strictly earlier entry as its
 * parent, which structurally excludes missing parents, self-parents, forward
 * references, and cycles. Artifact-less captures remain valid.
 */
export interface CanonicalArtifactManifestEntryShape {
  id: string
  role: 'source' | 'derivative'
  parentId: string | null
  primary: boolean
}

export function assertCanonicalArtifactManifestShape(
  entries: readonly CanonicalArtifactManifestEntryShape[],
): void {
  if (entries.length === 0) return
  const ids = new Set(entries.map(entry => entry.id))
  if (ids.size !== entries.length) throw new Error('Duplicate canonical artifact id')
  if (entries.filter(entry => entry.role === 'source').length !== 1) {
    throw new Error('Canonical artifact manifest requires exactly one source')
  }
  if (entries.filter(entry => entry.primary).length !== 1) {
    throw new Error('Canonical artifact manifest requires exactly one primary')
  }
  const seen = new Set<string>()
  for (const [index, entry] of entries.entries()) {
    if (entry.role === 'source') {
      if (index !== 0) throw new Error('Canonical source artifact must be first')
      if (entry.parentId) throw new Error('Canonical source artifact cannot have a parent')
      if (!entry.primary) throw new Error('Canonical primary artifact must be the source')
    } else {
      if (!entry.parentId) throw new Error('Canonical derivative artifact requires a parent')
      if (!seen.has(entry.parentId)) {
        throw new Error('Canonical artifact parent must precede its derivative')
      }
      if (entry.primary) throw new Error('Canonical primary artifact must be the source')
    }
    seen.add(entry.id)
  }
}
