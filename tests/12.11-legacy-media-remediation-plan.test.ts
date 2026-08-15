import { describe, expect, it } from 'vitest'
import { buildLegacyRemediationPlan, requireLegacyRemediationApproval } from '../src/services/artifact-intake/legacy-remediation'
import type { LegacyInventoryReport, LegacyPrivateInventoryEntry } from '../src/services/artifact-intake/legacy-inventory'

const report: LegacyInventoryReport = {
  referencedTelegram: { count: 2, bytes: 136114 },
  referencedSendblue: { count: 0, bytes: 0 },
  orphanTelegram: { count: 3, bytes: 204045 },
  orphanSendblue: { count: 4, bytes: 142352 },
  alreadyEncrypted: { count: 0, bytes: 0 },
  alreadyMigrated: { count: 0, bytes: 0 },
  ambiguous: { count: 0, bytes: 0 },
  reconciliation: {
    neonReferencedMissingD1: { count: 2, bytes: 136114 },
    d1ReferencedMissingNeon: { count: 0, bytes: 0 },
    referencedMissingR2: { count: 0, bytes: 0 },
    ownershipMismatch: { count: 0, bytes: 0 },
  },
}

const entries: LegacyPrivateInventoryEntry[] = [
  { key: 'telegram-media/private/a', size: 68057, channel: 'telegram', envelopeFamily: 'plaintext', etag: 'etag-a', version: 'v1', objectSha256: '1'.repeat(64), r2Present: true, tenantId: 'tenant-a', captureId: 'capture-a', disposition: 'migrate_replace_delete', reconciliationState: 'neon_reference_missing_d1' },
  { key: 'telegram-media/private/b', size: 68057, channel: 'telegram', envelopeFamily: 'plaintext', etag: 'etag-b', version: 'v1', objectSha256: '2'.repeat(64), r2Present: true, tenantId: 'tenant-a', captureId: 'capture-b', disposition: 'migrate_replace_delete', reconciliationState: 'neon_reference_missing_d1' },
  ...[0, 1, 2].map(index => ({ key: `telegram-media/private/orphan-${index}`, size: 68015, channel: 'telegram' as const, envelopeFamily: 'plaintext' as const, etag: `etag-t-${index}`, version: 'v1', objectSha256: `${index + 3}`.repeat(64), r2Present: true, tenantId: null, captureId: null, disposition: 'delete_confirmed_orphan' as const, reconciliationState: 'reconciled' })),
  ...[0, 1, 2, 3].map(index => ({ key: `sendblue-media/private/orphan-${index}`, size: 35588, channel: 'sendblue' as const, envelopeFamily: 'plaintext' as const, etag: `etag-s-${index}`, version: 'v1', objectSha256: `${index + 6}`.repeat(64), r2Present: true, tenantId: null, captureId: null, disposition: 'delete_confirmed_orphan' as const, reconciliationState: 'reconciled' })),
]

const args = (privateEntries = entries) => ({
  report,
  privateEntries,
  canonicalContentFingerprintSha256: 'a'.repeat(64),
  inventoryAt: '2026-08-15T00:00:00.000Z',
  executorCommit: 'b'.repeat(40),
  approvalHmacSecret: 'test-only-approval-hmac-secret',
})

describe('12.11 legacy remediation approval plan', () => {
  it('freezes exact aggregate targets and enforces replace-verify-delete ordering', async () => {
    const plan = await buildLegacyRemediationPlan(args())
    expect(plan.migrate.telegram).toEqual({ count: 2, bytes: 136114 })
    expect(plan.deleteAfterVerifiedReplacement).toEqual({ count: 2, bytes: 136114 })
    expect(plan.deleteConfirmedOrphans).toEqual({
      telegram: { count: 3, bytes: 204045 }, sendblue: { count: 4, bytes: 142352 },
    })
    expect(plan.orderedSteps.indexOf('verify_status_canonical_read_and_search'))
      .toBeLessThan(plan.orderedSteps.indexOf('delete_exact_approved_legacy_key'))
    expect(plan.orderedSteps.indexOf('verify_canonical_content_fingerprint_unchanged'))
      .toBeLessThan(plan.orderedSteps.indexOf('delete_exact_approved_legacy_key'))
    expect(plan.orderedSteps).toContain('atomically_replace_single_source_row_and_primary_pointers')
    expect(plan.orderedSteps).toContain('require_exactly_one_source_and_valid_primary_pointer')
    expect(JSON.stringify(plan)).not.toContain('telegram-media/')
    expect(JSON.stringify(plan)).not.toContain('tenant-a')
  })

  it('cannot authorize execution without an explicit matching approval digest', async () => {
    const plan = await buildLegacyRemediationPlan(args())
    expect(() => requireLegacyRemediationApproval({ plan, approved: false }))
      .toThrow('explicit_remediation_approval_required')
    expect(() => requireLegacyRemediationApproval({ plan, approved: true, approvalDigest: 'wrong' }))
      .toThrow('explicit_remediation_approval_required')
    expect(() => requireLegacyRemediationApproval({
      plan, approved: true, approvalDigest: plan.approvalDigest,
    })).not.toThrow()
  })

  it('changes the digest for same-count and same-byte target substitution', async () => {
    const original = await buildLegacyRemediationPlan(args())
    const substituted = entries.map((entry, index) => index === 0
      ? { ...entry, key: 'telegram-media/private/substitute', etag: 'etag-substitute', objectSha256: '9'.repeat(64) }
      : entry)
    const changed = await buildLegacyRemediationPlan(args(substituted))
    expect(changed.migrate).toEqual(original.migrate)
    expect(changed.deleteConfirmedOrphans).toEqual(original.deleteConfirmedOrphans)
    expect(changed.approvalDigest).not.toBe(original.approvalDigest)
  })
})
