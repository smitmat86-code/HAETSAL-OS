export type LegacyChannel = 'telegram' | 'sendblue'

export interface LegacyObjectInventoryInput {
  key: string
  size: number
  channel: LegacyChannel
  envelopeFamily: 'tmk' | 'kek' | 'plaintext' | 'unknown'
}

export interface LegacyCanonicalReference {
  key: string
  tenantId: string
  captureId: string
}

export interface LegacyInventoryTotal { count: number; bytes: number }

export interface LegacyInventoryReport {
  referencedTelegram: LegacyInventoryTotal
  referencedSendblue: LegacyInventoryTotal
  orphanTelegram: LegacyInventoryTotal
  orphanSendblue: LegacyInventoryTotal
  alreadyEncrypted: LegacyInventoryTotal
  alreadyMigrated: LegacyInventoryTotal
  ambiguous: LegacyInventoryTotal
  reconciliation: {
    neonReferencedMissingD1: LegacyInventoryTotal
    d1ReferencedMissingNeon: LegacyInventoryTotal
  }
}

const zero = (): LegacyInventoryTotal => ({ count: 0, bytes: 0 })
const add = (target: LegacyInventoryTotal, size: number): void => {
  target.count += 1
  target.bytes += size
}

export function classifyLegacyMediaObjects(args: {
  objects: LegacyObjectInventoryInput[]
  neonReferences: LegacyCanonicalReference[]
  d1References: LegacyCanonicalReference[]
  capturesWithManagedArtifact: Set<string>
}): LegacyInventoryReport {
  const report: LegacyInventoryReport = {
    referencedTelegram: zero(), referencedSendblue: zero(),
    orphanTelegram: zero(), orphanSendblue: zero(),
    alreadyEncrypted: zero(), alreadyMigrated: zero(), ambiguous: zero(),
    reconciliation: { neonReferencedMissingD1: zero(), d1ReferencedMissingNeon: zero() },
  }
  const neon = new Map<string, LegacyCanonicalReference[]>()
  const d1 = new Map<string, LegacyCanonicalReference[]>()
  for (const ref of args.neonReferences) neon.set(ref.key, [...(neon.get(ref.key) ?? []), ref])
  for (const ref of args.d1References) d1.set(ref.key, [...(d1.get(ref.key) ?? []), ref])

  for (const object of args.objects) {
    const authoritative = neon.get(object.key) ?? []
    const compatibility = d1.get(object.key) ?? []
    const tenantCount = new Set(authoritative.map(ref => ref.tenantId)).size
    const captureCount = new Set(authoritative.map(ref => ref.captureId)).size
    const isAmbiguous = (authoritative.length === 0 && compatibility.length > 0) || tenantCount > 1 || captureCount > 1
    if (isAmbiguous) add(report.ambiguous, object.size)
    else if (authoritative.some(ref => args.capturesWithManagedArtifact.has(ref.captureId))) {
      add(report.alreadyMigrated, object.size)
    } else if (object.envelopeFamily === 'tmk' || object.envelopeFamily === 'kek') {
      add(report.alreadyEncrypted, object.size)
    } else if (authoritative.length > 0) {
      add(object.channel === 'telegram' ? report.referencedTelegram : report.referencedSendblue, object.size)
    } else {
      add(object.channel === 'telegram' ? report.orphanTelegram : report.orphanSendblue, object.size)
    }
    if (authoritative.length > 0 && compatibility.length === 0) {
      add(report.reconciliation.neonReferencedMissingD1, object.size)
    }
    if (authoritative.length === 0 && compatibility.length > 0) {
      add(report.reconciliation.d1ReferencedMissingNeon, object.size)
    }
  }
  return report
}
