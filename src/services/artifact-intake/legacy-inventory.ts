import type {
  LegacyCanonicalReference,
  LegacyChannel,
  LegacyInventoryClassification,
  LegacyInventoryDisposition,
  LegacyInventoryReport,
  LegacyInventoryTotal,
  LegacyManagedPrimarySourceReplacement,
  LegacyObjectInventoryInput,
  LegacyPrivateInventoryEntry,
} from './legacy-inventory-types'

export type * from './legacy-inventory-types'

const zero = (): LegacyInventoryTotal => ({ count: 0, bytes: 0 })
const add = (target: LegacyInventoryTotal, size: number): void => {
  target.count += 1
  target.bytes += size
}

function groupReferences(references: LegacyCanonicalReference[]): Map<string, LegacyCanonicalReference[]> {
  const grouped = new Map<string, LegacyCanonicalReference[]>()
  for (const reference of references) {
    grouped.set(reference.key, [...(grouped.get(reference.key) ?? []), reference])
  }
  return grouped
}

function referenceIdentity(reference: LegacyCanonicalReference): string {
  return `${reference.tenantId}\0${reference.captureId}`
}

function inferredChannel(key: string): LegacyChannel {
  return key.startsWith('sendblue-media/') ? 'sendblue' : 'telegram'
}

export function classifyLegacyMediaInventory(args: {
  objects: LegacyObjectInventoryInput[]
  neonReferences: LegacyCanonicalReference[]
  d1References: LegacyCanonicalReference[]
  managedPrimarySourceReplacements: LegacyManagedPrimarySourceReplacement[]
}): LegacyInventoryClassification {
  const report: LegacyInventoryReport = {
    referencedTelegram: zero(), referencedSendblue: zero(),
    orphanTelegram: zero(), orphanSendblue: zero(),
    alreadyEncrypted: zero(), alreadyMigrated: zero(), ambiguous: zero(),
    reconciliation: {
      neonReferencedMissingD1: zero(), d1ReferencedMissingNeon: zero(),
      referencedMissingR2: zero(), ownershipMismatch: zero(),
    },
  }
  const objects = new Map(args.objects.map(object => [object.key, object]))
  const neon = groupReferences(args.neonReferences)
  const d1 = groupReferences(args.d1References)
  const managedPrimarySourceReplacements = new Set(
    args.managedPrimarySourceReplacements.map(reference => `${reference.key}\0${referenceIdentity(reference)}`),
  )
  const keys = [...new Set([...objects.keys(), ...neon.keys(), ...d1.keys()])].sort()
  const privateEntries: LegacyPrivateInventoryEntry[] = []

  for (const key of keys) {
    const object = objects.get(key)
    const authoritative = neon.get(key) ?? []
    const compatibility = d1.get(key) ?? []
    const size = object?.size ?? 0
    const channel = object?.channel ?? inferredChannel(key)
    const neonIdentities = new Set(authoritative.map(referenceIdentity))
    const d1Identities = new Set(compatibility.map(referenceIdentity))
    const authoritativeMultiplicity = authoritative.length > 0 && authoritative.length !== 1
    const compatibilityMultiplicity = compatibility.length > 1
    const multiOwner = neonIdentities.size > 1 || d1Identities.size > 1
    const ownershipMismatch = authoritative.length > 0 && compatibility.length > 0 && (
      neonIdentities.size !== d1Identities.size ||
      [...neonIdentities].some(identity => !d1Identities.has(identity))
    )
    const missingR2 = !object && (authoritative.length > 0 || compatibility.length > 0)
    const neonMissingD1 = authoritative.length > 0 && compatibility.length === 0
    const d1MissingNeon = compatibility.length > 0 && authoritative.length === 0
    const incompleteObjectEvidence = Boolean(object) && (
      !object?.etag || !object.objectSha256 || !/^[a-f0-9]{64}$/i.test(object.objectSha256)
    )
    const ambiguous = missingR2 || authoritativeMultiplicity || compatibilityMultiplicity ||
      multiOwner || ownershipMismatch || d1MissingNeon ||
      object?.envelopeFamily === 'unknown' || incompleteObjectEvidence
    let disposition: LegacyInventoryDisposition
    let reconciliationState = 'reconciled'
    if (missingR2) reconciliationState = 'referenced_missing_r2'
    else if (authoritativeMultiplicity) reconciliationState = 'authoritative_reference_multiplicity'
    else if (compatibilityMultiplicity) reconciliationState = 'd1_reference_multiplicity'
    else if (ownershipMismatch || multiOwner) reconciliationState = 'ownership_mismatch'
    else if (d1MissingNeon) reconciliationState = 'd1_only_reference'
    else if (neonMissingD1) reconciliationState = 'neon_reference_missing_d1'
    else if (object?.envelopeFamily === 'unknown') reconciliationState = 'unreadable_or_unknown_envelope'
    else if (incompleteObjectEvidence) reconciliationState = 'incomplete_object_identity'

    if (ambiguous) {
      disposition = 'exclude_ambiguous'
      add(report.ambiguous, size)
    } else if (
      authoritative.length === 1 &&
      managedPrimarySourceReplacements.has(`${key}\0${referenceIdentity(authoritative[0]!)}`)
    ) {
      disposition = 'exclude_already_migrated'
      add(report.alreadyMigrated, size)
    } else if (object!.envelopeFamily === 'tmk' || object!.envelopeFamily === 'kek') {
      disposition = 'exclude_already_encrypted'
      add(report.alreadyEncrypted, size)
    } else if (authoritative.length === 1) {
      disposition = 'migrate_replace_delete'
      add(channel === 'telegram' ? report.referencedTelegram : report.referencedSendblue, size)
    } else {
      disposition = 'delete_confirmed_orphan'
      add(channel === 'telegram' ? report.orphanTelegram : report.orphanSendblue, size)
    }

    if (neonMissingD1) add(report.reconciliation.neonReferencedMissingD1, size)
    if (d1MissingNeon) add(report.reconciliation.d1ReferencedMissingNeon, size)
    if (missingR2) add(report.reconciliation.referencedMissingR2, size)
    if (authoritativeMultiplicity || compatibilityMultiplicity || ownershipMismatch || multiOwner) {
      add(report.reconciliation.ownershipMismatch, size)
    }
    const owner = authoritative.length === 1 ? authoritative[0] : null
    privateEntries.push({
      key, size, channel,
      envelopeFamily: object?.envelopeFamily ?? 'unknown',
      etag: object?.etag ?? null,
      version: object?.version ?? null,
      objectSha256: object?.objectSha256?.toLowerCase() ?? null,
      r2Present: Boolean(object),
      tenantId: owner?.tenantId ?? null,
      captureId: owner?.captureId ?? null,
      disposition,
      reconciliationState,
    })
  }
  return { report, privateEntries }
}

export function classifyLegacyMediaObjects(
  args: Parameters<typeof classifyLegacyMediaInventory>[0],
): LegacyInventoryReport {
  return classifyLegacyMediaInventory(args).report
}
