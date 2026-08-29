export type LegacyChannel = 'telegram' | 'sendblue'
export type LegacyEnvelopeFamily = 'tmk' | 'kek' | 'plaintext' | 'unknown'
export type LegacyInventoryDisposition =
  | 'migrate_replace_delete'
  | 'delete_confirmed_orphan'
  | 'exclude_already_encrypted'
  | 'exclude_already_migrated'
  | 'exclude_ambiguous'

export interface LegacyObjectInventoryInput {
  key: string
  size: number
  channel: LegacyChannel
  envelopeFamily: LegacyEnvelopeFamily
  etag?: string | null
  version?: string | null
  objectSha256?: string | null
}

export interface LegacyCanonicalReference {
  key: string
  tenantId: string
  captureId: string
  /** Raw canonical provenance. Only the exact value `source` is eligible. */
  role?: string | null
}
export interface LegacyManagedPrimarySourceReplacement extends LegacyCanonicalReference {}
export interface LegacyManagedReplacementQueryRow {
  key: string
  tenant_id: string
  capture_id: string
  legacy_role?: string | null
  legacy_artifact_count?: number | string
  eligible_legacy_source_count: number | string
  managed_primary_source_count: number | string
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
    referencedMissingR2: LegacyInventoryTotal
    ownershipMismatch: LegacyInventoryTotal
  }
}

/** Private: callers must never log or include these entries in an approval packet. */
export interface LegacyPrivateInventoryEntry {
  key: string
  size: number
  channel: LegacyChannel
  envelopeFamily: LegacyEnvelopeFamily
  etag: string | null
  version: string | null
  objectSha256: string | null
  r2Present: boolean
  tenantId: string | null
  captureId: string | null
  disposition: LegacyInventoryDisposition
  reconciliationState: string
}

export interface LegacyInventoryClassification {
  report: LegacyInventoryReport
  privateEntries: LegacyPrivateInventoryEntry[]
}
