import { describe, expect, it } from 'vitest'
import {
  classifyLegacyMediaInventory,
  classifyLegacyMediaObjects,
  exactManagedPrimarySourceReplacements,
  LEGACY_D1_CANONICAL_REFERENCES_SQL,
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
        { key: 'telegram-media/t/a', tenantId: 't', captureId: 'capture-a', role: 'source' },
        { key: 'sendblue-media/t/b', tenantId: 't', captureId: 'capture-b', role: 'source' },
      ],
      d1References: [
        { key: 'telegram-media/t/a', tenantId: 't', captureId: 'capture-a', role: 'source' },
        { key: 'sendblue-media/t/d', tenantId: 't', captureId: 'stale-d1-capture', role: 'source' },
      ],
      managedPrimarySourceReplacements: [
        { key: 'sendblue-media/t/b', tenantId: 't', captureId: 'capture-b', role: 'source' },
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
        { key: 'telegram-media/t/shared', tenantId: 't', captureId: 'one', role: 'source' },
        { key: 'telegram-media/t/shared', tenantId: 't', captureId: 'two', role: 'source' },
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
        { key: object.key, tenantId: 't', captureId: 'same-capture', role: 'source' },
        { key: object.key, tenantId: 't', captureId: 'same-capture', role: 'source' },
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
    const reference = { key: object.key, tenantId: 't', captureId: 'same-capture', role: 'source' }
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
    const reference = { key: object.key, tenantId: 't', captureId: 'capture', role: 'source' }
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
        { key: object.key, tenantId: 'tenant-a', captureId: 'capture-a', role: 'source' },
        { key: object.key, tenantId: 'tenant-b', captureId: 'capture-b', role: 'source' },
      ],
      d1References: [
        { key: object.key, tenantId: 'tenant-a', captureId: 'capture-a', role: 'source' },
        { key: object.key, tenantId: 'tenant-b', captureId: 'capture-b', role: 'source' },
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
    const reference = {
      key: object.key, tenantId: 't', captureId: 'capture-with-managed-derivative', role: 'source',
    }
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
      legacy_role: 'source',
      legacy_artifact_count: '2',
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
        key: object.key, tenantId: 't', captureId: 'shared-capture', role: 'source',
      })),
      d1References: [first, second].map(object => ({
        key: object.key, tenantId: 't', captureId: 'shared-capture', role: 'source',
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
    const object = identified('sendblue-media/t/singleton', 41, 'sendblue', 'plaintext')
    const replacement = exactManagedPrimarySourceReplacements([{
      key: 'sendblue-media/t/singleton',
      tenant_id: 't',
      capture_id: 'capture',
      legacy_role: 'source',
      legacy_artifact_count: 1,
      eligible_legacy_source_count: 1,
      managed_primary_source_count: 1,
    }])
    expect(replacement).toEqual([{
      key: 'sendblue-media/t/singleton', tenantId: 't', captureId: 'capture', role: 'source',
    }])
    expect(exactManagedPrimarySourceReplacements([{
      key: 'sendblue-media/t/unclear',
      tenant_id: 't',
      capture_id: 'capture',
      legacy_role: 'source',
      legacy_artifact_count: 1,
      eligible_legacy_source_count: 1,
      managed_primary_source_count: 2,
    }])).toEqual([])
    const classified = classifyLegacyMediaInventory({
      objects: [object],
      neonReferences: [{ key: object.key, tenantId: 't', captureId: 'capture', role: 'source' }],
      d1References: [{ key: object.key, tenantId: 't', captureId: 'capture', role: 'source' }],
      managedPrimarySourceReplacements: replacement,
    })
    expect(classified.report.alreadyMigrated).toEqual({ count: 1, bytes: 41 })
    expect(classified.privateEntries[0]?.disposition).toBe('exclude_already_migrated')
  })

  it('keeps a singleton legacy derivative visible and ambiguous despite a managed primary source', () => {
    const object = identified('telegram-media/t/legacy-derivative', 43, 'telegram', 'plaintext')
    const queryRows = [{
      key: object.key, tenant_id: 't', capture_id: 'capture', legacy_role: 'derivative',
      legacy_artifact_count: 1, eligible_legacy_source_count: 0, managed_primary_source_count: 1,
    }]
    expect(exactManagedPrimarySourceReplacements(queryRows)).toEqual([])
    expect(LEGACY_MANAGED_REPLACEMENT_CANDIDATES_SQL).toContain('role AS legacy_role')
    expect(LEGACY_D1_CANONICAL_REFERENCES_SQL).toContain("THEN 'source' ELSE NULL END AS role")
    const reference = { key: object.key, tenantId: 't', captureId: 'capture', role: 'derivative' }
    const classified = classifyLegacyMediaInventory({
      objects: [object], neonReferences: [reference], d1References: [reference],
      managedPrimarySourceReplacements: [],
    })
    expect(classified.report.ambiguous).toEqual({ count: 1, bytes: 43 })
    expect(classified.report.alreadyMigrated).toEqual({ count: 0, bytes: 0 })
    expect(classified.privateEntries[0]).toMatchObject({
      disposition: 'exclude_ambiguous', reconciliationState: 'legacy_role_not_source',
    })
  })

  it('classifies missing and unknown legacy roles ambiguous at the query and classifier boundaries', () => {
    const missing = identified('telegram-media/t/missing-role', 47, 'telegram', 'plaintext')
    const unknown = identified('sendblue-media/t/unknown-role', 53, 'sendblue', 'plaintext')
    expect(exactManagedPrimarySourceReplacements([
      {
        key: missing.key, tenant_id: 't', capture_id: 'missing', legacy_role: null,
        legacy_artifact_count: 1, eligible_legacy_source_count: 0, managed_primary_source_count: 1,
      },
      {
        key: unknown.key, tenant_id: 't', capture_id: 'unknown', legacy_role: 'legacy',
        legacy_artifact_count: 1, eligible_legacy_source_count: 0, managed_primary_source_count: 1,
      },
    ])).toEqual([])
    const classified = classifyLegacyMediaInventory({
      objects: [missing, unknown],
      neonReferences: [
        { key: missing.key, tenantId: 't', captureId: 'missing', role: null },
        { key: unknown.key, tenantId: 't', captureId: 'unknown', role: 'legacy' },
      ],
      d1References: [
        { key: missing.key, tenantId: 't', captureId: 'missing' },
        { key: unknown.key, tenantId: 't', captureId: 'unknown', role: 'legacy' },
      ],
      managedPrimarySourceReplacements: [],
    })
    expect(classified.report.ambiguous).toEqual({ count: 2, bytes: 100 })
    expect(classified.privateEntries.every(entry => entry.disposition === 'exclude_ambiguous')).toBe(true)
  })

  it('fails closed when one capture mixes a legacy source and derivative', () => {
    const source = identified('telegram-media/t/mixed-source', 59, 'telegram', 'plaintext')
    const derivative = identified('telegram-media/t/mixed-derivative', 61, 'telegram', 'plaintext')
    const rows = [
      { key: source.key, legacy_role: 'source', eligible_legacy_source_count: 1 },
      { key: derivative.key, legacy_role: 'derivative', eligible_legacy_source_count: 1 },
    ].map(row => ({
      ...row, tenant_id: 't', capture_id: 'mixed', legacy_artifact_count: 2,
      managed_primary_source_count: 1,
    }))
    expect(exactManagedPrimarySourceReplacements(rows)).toEqual([])
    const neonReferences = [
      { key: source.key, tenantId: 't', captureId: 'mixed', role: 'source' },
      { key: derivative.key, tenantId: 't', captureId: 'mixed', role: 'derivative' },
    ]
    const classified = classifyLegacyMediaInventory({
      objects: [source, derivative], neonReferences, d1References: neonReferences,
      managedPrimarySourceReplacements: [],
    })
    expect(classified.report.ambiguous).toEqual({ count: 2, bytes: 120 })
    expect(classified.report.referencedTelegram).toEqual({ count: 0, bytes: 0 })
    expect(classified.privateEntries.every(entry => entry.disposition === 'exclude_ambiguous')).toBe(true)
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
        { key: 'telegram-media/t/missing', tenantId: 't', captureId: 'missing', role: 'source' },
        { key: mismatch.key, tenantId: 't', captureId: 'neon-capture', role: 'source' },
      ],
      d1References: [
        { key: 'telegram-media/t/missing', tenantId: 't', captureId: 'missing', role: 'source' },
        { key: mismatch.key, tenantId: 'other', captureId: 'd1-capture', role: 'source' },
      ],
      managedPrimarySourceReplacements: [],
    })
    expect(report.ambiguous).toEqual({ count: 2, bytes: 12 })
    expect(report.reconciliation.referencedMissingR2).toEqual({ count: 1, bytes: 0 })
    expect(report.reconciliation.ownershipMismatch).toEqual({ count: 1, bytes: 12 })
    expect(report.referencedTelegram.count + report.referencedSendblue.count).toBe(0)
  })
})
