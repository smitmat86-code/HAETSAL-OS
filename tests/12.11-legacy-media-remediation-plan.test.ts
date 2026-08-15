import { describe, expect, it } from 'vitest'
import { buildLegacyRemediationPlan, requireLegacyRemediationApproval } from '../src/services/artifact-intake/legacy-remediation'
import type { LegacyInventoryReport } from '../src/services/artifact-intake/legacy-inventory'

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
  },
}

describe('12.11 legacy remediation approval plan', () => {
  it('freezes exact aggregate targets and enforces replace-verify-delete ordering', async () => {
    const plan = await buildLegacyRemediationPlan(report, 'a'.repeat(64))
    expect(plan.migrate.telegram).toEqual({ count: 2, bytes: 136114 })
    expect(plan.deleteAfterVerifiedReplacement).toEqual({ count: 2, bytes: 136114 })
    expect(plan.deleteConfirmedOrphans).toEqual({
      telegram: { count: 3, bytes: 204045 }, sendblue: { count: 4, bytes: 142352 },
    })
    expect(plan.orderedSteps.indexOf('verify_status_canonical_read_and_search'))
      .toBeLessThan(plan.orderedSteps.indexOf('delete_exact_approved_legacy_key'))
    expect(plan.orderedSteps.indexOf('verify_canonical_content_fingerprint_unchanged'))
      .toBeLessThan(plan.orderedSteps.indexOf('delete_exact_approved_legacy_key'))
  })

  it('cannot authorize execution without an explicit matching approval digest', async () => {
    const plan = await buildLegacyRemediationPlan(report, 'b'.repeat(64))
    expect(() => requireLegacyRemediationApproval({ plan, approved: false }))
      .toThrow('explicit_remediation_approval_required')
    expect(() => requireLegacyRemediationApproval({ plan, approved: true, approvalDigest: 'wrong' }))
      .toThrow('explicit_remediation_approval_required')
    expect(() => requireLegacyRemediationApproval({
      plan, approved: true, approvalDigest: plan.approvalDigest,
    })).not.toThrow()
  })
})
