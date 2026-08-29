import type { Env } from '../../types/env'
import { getArtifactIntakeOperation } from './operations'
import { managedArtifactR2Key } from './storage-keys'

interface LegacyTombstoneRow {
  tenant_id: string
  upload_id: string
}

export interface LegacyKeySweepResult {
  inspected: number
  deleted: number
  pending: number
  indeterminate: number
}

/** Records the deterministic shared key before promotion can abandon it. */
export async function recordLegacyKeyTombstone(env: Env, args: {
  tenantId: string
  uploadId: string
  now: number
}): Promise<void> {
  await env.D1_US.prepare(
    `INSERT OR IGNORE INTO artifact_legacy_key_tombstones
     (tenant_id, upload_id, created_at) VALUES (?, ?, ?)`,
  ).bind(args.tenantId, args.uploadId, args.now).run()
}

/**
 * Rechecks retired shared keys forever. Old HTTP requests have no bounded
 * lifetime and multiple old requests may put the same key, so absence never
 * retires this content-free pointer. Work is round-robin bounded by the last
 * sweep timestamp and reads no object bodies.
 */
export async function sweepRetiredLegacyArtifactKeys(
  env: Env,
  now = Date.now(),
  limit = 50,
): Promise<LegacyKeySweepResult> {
  const result: LegacyKeySweepResult = {
    inspected: 0, deleted: 0, pending: 0, indeterminate: 0,
  }
  const rows = await env.D1_US.prepare(
    `SELECT tenant_id, upload_id FROM artifact_legacy_key_tombstones
     ORDER BY COALESCE(swept_at, created_at) ASC LIMIT ?`,
  ).bind(limit).all<LegacyTombstoneRow>()
  for (const row of rows.results) {
    result.inspected += 1
    try {
      // Advance the round-robin cursor before external reads so one corrupt
      // or repeatedly unavailable row cannot starve every later tombstone.
      await markSwept(env, row, now)
      const operation = await getArtifactIntakeOperation(env, row.tenant_id, row.upload_id)
      if (!operation) {
        result.indeterminate += 1
        continue
      }
      const legacyKey = await managedArtifactR2Key(row.tenant_id, row.upload_id)
      if (!operation.adopted_attempt_token || operation.r2_key === legacyKey) {
        result.pending += 1
        continue
      }
      if (await env.R2_ARTIFACTS.head(legacyKey)) {
        await env.R2_ARTIFACTS.delete(legacyKey)
        result.deleted += 1
      }
    } catch {
      result.indeterminate += 1
    }
  }
  return result
}

async function markSwept(env: Env, row: LegacyTombstoneRow, now: number): Promise<void> {
  await env.D1_US.prepare(
    `UPDATE artifact_legacy_key_tombstones
     SET swept_at = ?, sweep_count = sweep_count + 1
     WHERE tenant_id = ? AND upload_id = ?`,
  ).bind(now, row.tenant_id, row.upload_id).run()
}
