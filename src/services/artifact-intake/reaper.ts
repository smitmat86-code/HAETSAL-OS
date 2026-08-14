import type { Env } from '../../types/env'
import { getCanonicalMemoryStore } from '../canonical-postgres'
import { canonicalR2Key } from '../canonical-memory-artifacts'
import type { ArtifactIntakeOperationRow } from './operations'
import { deleteProvenManagedArtifact } from './storage'

export interface ArtifactReaperResult {
  inspected: number
  reaped: number
  repairedFinalized: number
  failed: number
}

export async function reapExpiredArtifactUploads(
  env: Env,
  now = Date.now(),
  limit = 100,
): Promise<ArtifactReaperResult> {
  const result: ArtifactReaperResult = { inspected: 0, reaped: 0, repairedFinalized: 0, failed: 0 }
  const rows = await env.D1_US.prepare(
    `SELECT * FROM artifact_intake_operations
     WHERE status IN ('reserved', 'sealed', 'failed') AND expires_at <= ?
     ORDER BY expires_at ASC LIMIT ?`,
  ).bind(now, limit).all<ArtifactIntakeOperationRow>()
  const store = getCanonicalMemoryStore(env)
  for (const row of rows.results) {
    result.inspected += 1
    try {
      if (row.canonical_capture_id && await store.getCapture(row.tenant_id, row.canonical_capture_id)) {
        await env.D1_US.prepare(
          `UPDATE artifact_intake_operations SET status = 'finalized', error_code = NULL, updated_at = ?
           WHERE tenant_id = ? AND upload_id = ?`,
        ).bind(now, row.tenant_id, row.upload_id).run()
        result.repairedFinalized += 1
        continue
      }
      await deleteProvenManagedArtifact({
        env,
        tenantId: row.tenant_id,
        uploadId: row.upload_id,
        recordedKey: row.r2_key,
      })
      if (row.canonical_document_id && /^[a-f0-9-]{36}$/i.test(row.canonical_document_id)) {
        await env.R2_ARTIFACTS.delete(canonicalR2Key(row.tenant_id, 'documents', row.canonical_document_id))
      }
      await env.D1_US.prepare(
        `UPDATE artifact_intake_operations SET status = 'expired', error_code = NULL, updated_at = ?
         WHERE tenant_id = ? AND upload_id = ? AND status != 'finalized'`,
      ).bind(now, row.tenant_id, row.upload_id).run()
      result.reaped += 1
    } catch {
      result.failed += 1
    }
  }
  return result
}
