import type { LegacyInventoryReport, LegacyInventoryTotal } from './legacy-inventory'
import { sha256Text } from './crypto'

export interface LegacyRemediationPlan {
  approvalDigest: string
  migrate: { telegram: LegacyInventoryTotal; sendblue: LegacyInventoryTotal }
  deleteAfterVerifiedReplacement: LegacyInventoryTotal
  deleteConfirmedOrphans: { telegram: LegacyInventoryTotal; sendblue: LegacyInventoryTotal }
  exclude: { alreadyMigrated: LegacyInventoryTotal; ambiguous: LegacyInventoryTotal }
  canonicalContentFingerprintSha256: string
  orderedSteps: readonly string[]
}

function total(...values: LegacyInventoryTotal[]): LegacyInventoryTotal {
  return values.reduce((sum, value) => ({ count: sum.count + value.count, bytes: sum.bytes + value.bytes }), {
    count: 0, bytes: 0,
  })
}

export async function buildLegacyRemediationPlan(
  report: LegacyInventoryReport,
  canonicalContentFingerprintSha256: string,
): Promise<LegacyRemediationPlan> {
  if (!/^[a-f0-9]{64}$/i.test(canonicalContentFingerprintSha256)) throw new Error('invalid_inventory_fingerprint')
  const shape = {
    migrate: { telegram: report.referencedTelegram, sendblue: report.referencedSendblue },
    deleteAfterVerifiedReplacement: total(report.referencedTelegram, report.referencedSendblue),
    deleteConfirmedOrphans: { telegram: report.orphanTelegram, sendblue: report.orphanSendblue },
    exclude: { alreadyMigrated: report.alreadyMigrated, ambiguous: report.ambiguous },
    canonicalContentFingerprintSha256,
  }
  return {
    ...shape,
    approvalDigest: await sha256Text(JSON.stringify(shape)),
    orderedSteps: [
      'read_approved_legacy_original',
      'detect_mime_and_hash_plaintext',
      'reserve_tenant_scoped_managed_upload',
      'tmk_seal_and_write_managed_r2',
      'verify_ciphertext_hash_and_byte_count',
      'link_artifact_manifest_in_neon_transaction',
      'repair_content_free_d1_compatibility_state',
      'verify_status_canonical_read_and_search',
      'verify_canonical_content_fingerprint_unchanged',
      'delete_exact_approved_legacy_key',
      'reconcile_before_after_aggregates',
    ],
  }
}

export function requireLegacyRemediationApproval(args: {
  plan: LegacyRemediationPlan
  approved: boolean
  approvalDigest?: string
}): void {
  if (!args.approved || !args.approvalDigest || args.approvalDigest !== args.plan.approvalDigest) {
    throw new Error('explicit_remediation_approval_required')
  }
}
