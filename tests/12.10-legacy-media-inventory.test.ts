import { describe, expect, it } from 'vitest'
import { classifyLegacyMediaObjects } from '../src/services/artifact-intake/legacy-inventory'

describe('12.10 legacy media inventory classification', () => {
  it('uses Neon as authority, isolates D1-only ambiguity, and never emits object keys', () => {
    const report = classifyLegacyMediaObjects({
      objects: [
        { key: 'telegram-media/t/a', size: 10, channel: 'telegram', envelopeFamily: 'plaintext' },
        { key: 'sendblue-media/t/b', size: 20, channel: 'sendblue', envelopeFamily: 'tmk' },
        { key: 'telegram-media/t/c', size: 30, channel: 'telegram', envelopeFamily: 'plaintext' },
        { key: 'sendblue-media/t/d', size: 40, channel: 'sendblue', envelopeFamily: 'unknown' },
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
      objects: [{ key: 'telegram-media/t/shared', size: 50, channel: 'telegram', envelopeFamily: 'kek' }],
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
})
