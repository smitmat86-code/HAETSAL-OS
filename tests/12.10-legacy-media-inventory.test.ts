import { describe, expect, it } from 'vitest'
import {
  classifyLegacyMediaInventory,
  classifyLegacyMediaObjects,
  exactManagedPrimarySourceReplacements,
  LEGACY_MANAGED_REPLACEMENT_CANDIDATES_SQL,
} from '../src/services/artifact-intake/legacy-inventory'

const identified = (key: string, size: number, channel: 'telegram' | 'sendblue', envelopeFamily: 'tmk' | 'kek' | 'plaintext' | 'unknown') => ({
  key, size, channel, envelopeFamily, etag: `etag-${key}`, objectSha256: 'a'.repeat(64), version: 'v1',
})

describe('12.10 legacy media inventory classification', () => {
  it('uses Neon as authority, isolates D1-only ambiguity, and never emits object keys', () => {
    const report = classifyLegacyMediaObjects({
      objects: [
        identified('telegram-media/t/a', 10, 'telegram', 'plaintext'),
        identified('sendblue-media/t/b', 20, 'sendblue', 'tmk'),
        identified('telegram-media/t/c', 30, 'telegram', 'plaintext'),
        identified('sendblue-media/t/d', 40, 'sendblue', 'unknown'),
      ],
      neonReferences: [
        { key: 'telegram-media/t/a', tenantId: 't', captureId: 'capture-a' },
        { key: 'sendblue-media/t/b', tenantId: 't', captureId: 'capture-b' },
      ],
      d1References: [
        { key: 'telegram-media/t/a', tenantId: 't', captureId: 'capture-a' },
        { key: 'sendblue-media/t/d', tenantId: 't', captureId: 'stale-d1-capture' },
      ],
      managedPrimarySourceReplacements: [
        { key: 'sendblue-media/t/b', tenantId: 't', captureId: 'capture-b' },
      ],
    })
    expect(report).toMatchObject({
      referencedTelegram: { count: 1, bytes: 10 },
      referencedSendblue: { count: 0, bytes: 0 },
      orphanTelegram: { count: 1, bytes: 30 },
      orphanSendblue: { count: 0, bytes: 0 },
      alreadyEncrypted: { count: 0, bytes: 0 },
      alreadyMigrated: { count: 1, bytes: 20 },
      ambiguous: { count: 1, bytes: 40 },
      reconciliation: {
        neonReferencedMissingD1: { count: 1, bytes: 20 },
        d1ReferencedMissingNeon: { count: 1, bytes: 40 },
        referencedMissingR2: { count: 0, bytes: 0 },
        ownershipMismatch: { count: 0, bytes: 0 },
      },
    })
    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain('telegram-media/')
    expect(serialized).not.toContain('sendblue-media/')
    expect([
      report.referencedTelegram, report.referencedSendblue,
      report.orphanTelegram, report.orphanSendblue,
      report.alreadyEncrypted, report.alreadyMigrated, report.ambiguous,
    ].reduce((count, category) => count + category.count, 0)).toBe(4)
  })

  it('marks multi-capture references ambiguous and excludes them from migration categories', () => {
    const report = classifyLegacyMediaObjects({
      objects: [identified('telegram-media/t/shared', 50, 'telegram', 'kek')],
      neonReferences: [
        { key: 'telegram-media/t/shared', tenantId: 't', captureId: 'one' },
        { key: 'telegram-media/t/shared', tenantId: 't', captureId: 'two' },
      ],
      d1References: [],
      managedPrimarySourceReplacements: [],
    })
    expect(report.ambiguous).toEqual({ count: 1, bytes: 50 })
    expect(report.referencedTelegram).toEqual({ count: 0, bytes: 0 })
    expect(report.alreadyEncrypted).toEqual({ count: 0, bytes: 0 })
  })

  it('treats two identical authoritative Neon references as ambiguous and deletion-ineligible', () => {
    const object = identified('telegram-media/t/duplicate-neon', 17, 'telegram', 'plaintext')
    const classified = classifyLegacyMediaInventory({
      objects: [object],
      neonReferences: [
        { key: object.key, tenantId: 't', captureId: 'same-capture' },
        { key: object.key, tenantId: 't', captureId: 'same-capture' },
      ],
      d1References: [],
      managedPrimarySourceReplacements: [],
    })
    expect(classified.report.ambiguous).toEqual({ count: 1, bytes: 17 })
    expect(classified.report.orphanTelegram).toEqual({ count: 0, bytes: 0 })
    expect(classified.report.referencedTelegram).toEqual({ count: 0, bytes: 0 })
    expect(classified.privateEntries[0]?.disposition).toBe('exclude_ambiguous')
  })

  it('keeps duplicate Neon references ambiguous even when D1 has the matching reference', () => {
    const object = identified('sendblue-media/t/duplicate-neon-matching-d1', 18, 'sendblue', 'plaintext')
    const reference = { key: object.key, tenantId: 't', captureId: 'same-capture' }
    const classified = classifyLegacyMediaInventory({
      objects: [object],
      neonReferences: [reference, reference],
      d1References: [reference],
      managedPrimarySourceReplacements: [],
    })
    expect(classified.report.ambiguous).toEqual({ count: 1, bytes: 18 })
    expect(classified.report.orphanSendblue).toEqual({ count: 0, bytes: 0 })
    expect(classified.privateEntries[0]?.disposition).toBe('exclude_ambiguous')
  })

  it('treats duplicate D1 references as ambiguous and deletion-ineligible', () => {
    const object = identified('telegram-media/t/duplicate-d1', 19, 'telegram', 'plaintext')
    const reference = { key: object.key, tenantId: 't', captureId: 'capture' }
    const classified = classifyLegacyMediaInventory({
      objects: [object],
      neonReferences: [reference],
      d1References: [reference, reference],
      managedPrimarySourceReplacements: [],
    })
    expect(classified.report.ambiguous).toEqual({ count: 1, bytes: 19 })
    expect(classified.report.referencedTelegram).toEqual({ count: 0, bytes: 0 })
    expect(classified.report.orphanTelegram).toEqual({ count: 0, bytes: 0 })
    expect(classified.privateEntries[0]?.disposition).toBe('exclude_ambiguous')
  })

  it('treats multiple owners and captures as ambiguous and deletion-ineligible', () => {
    const object = identified('sendblue-media/t/multiple-owners', 21, 'sendblue', 'plaintext')
    const classified = classifyLegacyMediaInventory({
      objects: [object],
      neonReferences: [
        { key: object.key, tenantId: 'tenant-a', captureId: 'capture-a' },
        { key: object.key, tenantId: 'tenant-b', captureId: 'capture-b' },
      ],
      d1References: [
        { key: object.key, tenantId: 'tenant-a', captureId: 'capture-a' },
        { key: object.key, tenantId: 'tenant-b', captureId: 'capture-b' },
      ],
      managedPrimarySourceReplacements: [],
    })
    expect(classified.report.ambiguous).toEqual({ count: 1, bytes: 21 })
    expect(classified.report.referencedSendblue).toEqual({ count: 0, bytes: 0 })
    expect(classified.report.orphanSendblue).toEqual({ count: 0, bytes: 0 })
    expect(classified.privateEntries[0]?.disposition).toBe('exclude_ambiguous')
  })

  it('allows only zero authoritative and zero compatibility references to start as an orphan', () => {
    const object = identified('telegram-media/t/only-orphan-start', 23, 'telegram', 'plaintext')
    const classified = classifyLegacyMediaInventory({
      objects: [object],
      neonReferences: [],
      d1References: [],
      managedPrimarySourceReplacements: [],
    })
    expect(classified.report.orphanTelegram).toEqual({ count: 1, bytes: 23 })
    expect(classified.report.ambiguous).toEqual({ count: 0, bytes: 0 })
    expect(classified.privateEntries[0]).toMatchObject({
      disposition: 'delete_confirmed_orphan', tenantId: null, captureId: null,
    })
  })

  it('does not treat a managed derivative or unrelated managed artifact as a migrated legacy source', () => {
    const object = identified('telegram-media/t/legacy-source', 29, 'telegram', 'plaintext')
    const reference = { key: object.key, tenantId: 't', captureId: 'capture-with-managed-derivative' }
    const classified = classifyLegacyMediaInventory({
      objects: [object],
      neonReferences: [reference],
      d1References: [reference],
      managedPrimarySourceReplacements: [],
    })
    expect(classified.report.alreadyMigrated).toEqual({ count: 0, bytes: 0 })
    expect(classified.report.referencedTelegram).toEqual({ count: 1, bytes: 29 })
    expect(classified.privateEntries[0]?.disposition).toBe('migrate_replace_delete')
  })

  it('fails closed at the query boundary when two legacy keys share one capture', () => {
    const first = identified('telegram-media/t/legacy-one', 31, 'telegram', 'plaintext')
    const second = identified('telegram-media/t/legacy-two', 37, 'telegram', 'plaintext')
    const queryRows = [first, second].map(object => ({
      key: object.key,
      tenant_id: 't',
      capture_id: 'shared-capture',
      eligible_legacy_source_count: '2',
      managed_primary_source_count: '1',
    }))
    const replacements = exactManagedPrimarySourceReplacements(queryRows)
    expect(replacements).toEqual([])
    expect(LEGACY_MANAGED_REPLACEMENT_CANDIDATES_SQL).toContain(
      'COUNT(*) OVER (PARTITION BY tenant_id, capture_id)',
    )

    const classified = classifyLegacyMediaInventory({
      objects: [first, second],
      neonReferences: [first, second].map(object => ({
        key: object.key, tenantId: 't', captureId: 'shared-capture',
      })),
      d1References: [first, second].map(object => ({
        key: object.key, tenantId: 't', captureId: 'shared-capture',
      })),
      managedPrimarySourceReplacements: replacements,
    })
    expect(classified.report.alreadyMigrated).toEqual({ count: 0, bytes: 0 })
    expect(classified.report.ambiguous).toEqual({ count: 2, bytes: 68 })
    expect(classified.privateEntries).toHaveLength(2)
    expect(classified.privateEntries.every(entry => (
      entry.disposition === 'exclude_ambiguous' &&
      entry.reconciliationState === 'capture_legacy_source_multiplicity'
    ))).toBe(true)
  })

  it('accepts one exact singleton query candidate only when the managed primary source is unique', () => {
    expect(exactManagedPrimarySourceReplacements([{
      key: 'sendblue-media/t/singleton',
      tenant_id: 't',
      capture_id: 'capture',
      eligible_legacy_source_count: 1,
      managed_primary_source_count: 1,
    }])).toEqual([{
      key: 'sendblue-media/t/singleton', tenantId: 't', captureId: 'capture',
    }])
    expect(exactManagedPrimarySourceReplacements([{
      key: 'sendblue-media/t/unclear',
      tenant_id: 't',
      capture_id: 'capture',
      eligible_legacy_source_count: 1,
      managed_primary_source_count: 2,
    }])).toEqual([])
  })

  it('makes unknown unreferenced objects ambiguous and deletion-ineligible', () => {
    const classified = classifyLegacyMediaInventory({
      objects: [identified('telegram-media/t/unknown', 9, 'telegram', 'unknown')],
      neonReferences: [], d1References: [], managedPrimarySourceReplacements: [],
    })
    expect(classified.report.ambiguous).toEqual({ count: 1, bytes: 9 })
    expect(classified.report.orphanTelegram).toEqual({ count: 0, bytes: 0 })
    expect(classified.privateEntries[0]?.disposition).toBe('exclude_ambiguous')
  })

  it('reconciles missing R2 references and D1/Neon ownership disagreement over the full union', () => {
    const mismatch = identified('sendblue-media/t/mismatch', 12, 'sendblue', 'plaintext')
    const report = classifyLegacyMediaObjects({
      objects: [mismatch],
      neonReferences: [
        { key: 'telegram-media/t/missing', tenantId: 't', captureId: 'missing' },
        { key: mismatch.key, tenantId: 't', captureId: 'neon-capture' },
      ],
      d1References: [
        { key: 'telegram-media/t/missing', tenantId: 't', captureId: 'missing' },
        { key: mismatch.key, tenantId: 'other', captureId: 'd1-capture' },
      ],
      managedPrimarySourceReplacements: [],
    })
    expect(report.ambiguous).toEqual({ count: 2, bytes: 12 })
    expect(report.reconciliation.referencedMissingR2).toEqual({ count: 1, bytes: 0 })
    expect(report.reconciliation.ownershipMismatch).toEqual({ count: 1, bytes: 12 })
    expect(report.referencedTelegram.count + report.referencedSendblue.count).toBe(0)
  })
})
