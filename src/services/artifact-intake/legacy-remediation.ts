import type {
  LegacyInventoryReport,
  LegacyInventoryTotal,
  LegacyPrivateInventoryEntry,
} from './legacy-inventory'
import { sha256Text } from './crypto'
import {
  buildExactTargetManifest,
  type ExactTargetManifestEntry,
} from './legacy-approval-manifest'

export const LEGACY_INVENTORY_VERSION = 2

export interface LegacyRemediationPlan {
  approvalDigest: string
  inventoryVersion: number
  inventoryAt: string
  executorCommit: string
  exactTargetCount: number
  migrate: { telegram: LegacyInventoryTotal; sendblue: LegacyInventoryTotal }
  deleteAfterVerifiedReplacement: LegacyInventoryTotal
  deleteConfirmedOrphans: { telegram: LegacyInventoryTotal; sendblue: LegacyInventoryTotal }
  exclude: { alreadyMigrated: LegacyInventoryTotal; alreadyEncrypted: LegacyInventoryTotal; ambiguous: LegacyInventoryTotal }
  canonicalContentFingerprintSha256: string
  orderedSteps: readonly string[]
  rollbackProcedure: readonly string[]
}

function total(...values: LegacyInventoryTotal[]): LegacyInventoryTotal {
  return values.reduce((sum, value) => ({ count: sum.count + value.count, bytes: sum.bytes + value.bytes }), {
    count: 0, bytes: 0,
  })
}

export async function buildLegacyRemediationPlan(args: {
  report: LegacyInventoryReport
  privateEntries: LegacyPrivateInventoryEntry[]
  canonicalContentFingerprintSha256: string
  inventoryAt: string
  executorCommit: string
  approvalHmacSecret: string
}): Promise<LegacyRemediationPlan> {
  if (!/^[a-f0-9]{64}$/i.test(args.canonicalContentFingerprintSha256)) {
    throw new Error('invalid_inventory_fingerprint')
  }
  if (!/^[a-f0-9]{40}$/i.test(args.executorCommit) || !Number.isFinite(Date.parse(args.inventoryAt))) {
    throw new Error('invalid_inventory_identity')
  }
  const targets = await buildExactTargetManifest(args.privateEntries, args.approvalHmacSecret)
  const exactTotal = (channel: 'telegram' | 'sendblue', disposition: ExactTargetManifestEntry['disposition']) =>
    targets.filter(target => target.channel === channel && target.disposition === disposition)
      .reduce((sum, target) => ({ count: sum.count + 1, bytes: sum.bytes + target.byteCount }), { count: 0, bytes: 0 })
  const expectedTargets = [
    [exactTotal('telegram', 'migrate_replace_delete'), args.report.referencedTelegram],
    [exactTotal('sendblue', 'migrate_replace_delete'), args.report.referencedSendblue],
    [exactTotal('telegram', 'delete_confirmed_orphan'), args.report.orphanTelegram],
    [exactTotal('sendblue', 'delete_confirmed_orphan'), args.report.orphanSendblue],
  ] as const
  if (expectedTargets.some(([exact, expected]) => exact.count !== expected.count || exact.bytes !== expected.bytes)) {
    throw new Error('exact_target_aggregate_mismatch')
  }
  const publicShape = {
    inventoryVersion: LEGACY_INVENTORY_VERSION,
    inventoryAt: args.inventoryAt,
    executorCommit: args.executorCommit.toLowerCase(),
    exactTargetCount: targets.length,
    migrate: { telegram: args.report.referencedTelegram, sendblue: args.report.referencedSendblue },
    deleteAfterVerifiedReplacement: total(args.report.referencedTelegram, args.report.referencedSendblue),
    deleteConfirmedOrphans: { telegram: args.report.orphanTelegram, sendblue: args.report.orphanSendblue },
    exclude: {
      alreadyMigrated: args.report.alreadyMigrated,
      alreadyEncrypted: args.report.alreadyEncrypted,
      ambiguous: args.report.ambiguous,
    },
    canonicalContentFingerprintSha256: args.canonicalContentFingerprintSha256.toLowerCase(),
  }
  const approvalDigest = await sha256Text(JSON.stringify({ ...publicShape, exactTargets: targets }))
  return {
    ...publicShape,
    approvalDigest,
    orderedSteps: [
      'recompute_and_match_exact_approval_digest',
      'read_exact_approved_legacy_original',
      'verify_approved_version_etag_hash_and_byte_count',
      'detect_mime_and_hash_plaintext',
      'reserve_tenant_scoped_managed_upload',
      'tmk_seal_and_write_managed_r2',
      'verify_ciphertext_hash_and_byte_count',
      'lock_legacy_source_capture_and_document_in_neon',
      'snapshot_legacy_source_row_and_primary_pointers',
      'atomically_replace_single_source_row_and_primary_pointers',
      'repair_content_free_d1_compatibility_state',
      'require_exactly_one_source_and_valid_primary_pointer',
      'verify_status_canonical_read_and_search',
      'verify_canonical_content_fingerprint_unchanged',
      'delete_exact_approved_legacy_key',
      'reconcile_exact_before_after_inventory',
    ],
    rollbackProcedure: [
      'retain_legacy_bytes_until_all_replacement_checks_pass',
      'rollback_neon_transaction_on_any_precommit_failure',
      'restore_snapshotted_source_row_and_primary_pointers_if_postcommit_verification_fails',
      'remove_unreferenced_managed_replacement_only_after_snapshot_restore',
      'never_restore_by_inserting_a_second_source_row',
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
