import { describe, expect, it } from 'vitest'
import { classifyLegacyMediaInventory, classifyLegacyMediaObjects } from '../src/services/artifact-intake/legacy-inventory'

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
      capturesWithManagedArtifact: new Set(['capture-b']),
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
      capturesWithManagedArtifact: new Set(),
    })
    expect(report.ambiguous).toEqual({ count: 1, bytes: 50 })
    expect(report.referencedTelegram).toEqual({ count: 0, bytes: 0 })
    expect(report.alreadyEncrypted).toEqual({ count: 0, bytes: 0 })
  })

  it('makes unknown unreferenced objects ambiguous and deletion-ineligible', () => {
    const classified = classifyLegacyMediaInventory({
      objects: [identified('telegram-media/t/unknown', 9, 'telegram', 'unknown')],
      neonReferences: [], d1References: [], capturesWithManagedArtifact: new Set(),
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
      capturesWithManagedArtifact: new Set(),
    })
    expect(report.ambiguous).toEqual({ count: 2, bytes: 12 })
    expect(report.reconciliation.referencedMissingR2).toEqual({ count: 1, bytes: 0 })
    expect(report.reconciliation.ownershipMismatch).toEqual({ count: 1, bytes: 12 })
    expect(report.referencedTelegram.count + report.referencedSendblue.count).toBe(0)
  })
})
