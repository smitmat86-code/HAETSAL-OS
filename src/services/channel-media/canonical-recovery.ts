import type { Env } from '../../types/env'
import type { ChannelMediaJob } from '../../types/channel-media'
import type { ArtifactIntakeOperationRow } from '../artifact-intake/operations'
import { getCanonicalMemoryStore } from '../canonical-postgres'
import { ARTIFACT_INTAKE_ERROR } from '../artifact-intake/contracts'
import { CHANNEL_MEDIA_FINALIZATION_STALE_MS } from '../artifact-intake/config'
import { sha256Text } from '../artifact-intake/crypto'
import { markArtifactOperationsFinalized } from '../artifact-intake/operations'
import { channelMediaRetrySeconds } from './claim-outcome'
import { repairChannelMediaFinalized } from './job-transitions'

interface FinalizationRow {
  id: string
  status: 'reserved' | 'finalized' | 'failed'
  error_code: string | null
  canonical_capture_id: string
  canonical_document_id: string
  canonical_operation_id: string
  updated_at: number
}

export type ChannelMediaCanonicalRecoveryResult =
  | { status: 'recovered' }
  | { status: 'in_progress'; retryAfterSeconds: number }
  | { status: 'stably_absent' }
  | { status: 'failed'; errorCode: string }
  | { status: 'inconsistent'; errorCode: string }

async function finalizationFor(job: ChannelMediaJob, env: Env): Promise<FinalizationRow | null> {
  return env.D1_US.prepare(
    `SELECT id, status, error_code, canonical_capture_id, canonical_document_id,
       canonical_operation_id, updated_at
     FROM artifact_intake_finalizations WHERE tenant_id = ? AND idempotency_hash = ? LIMIT 1`,
  ).bind(job.tenantId, await sha256Text(`channel-media-finalize:${job.id}`)).first<FinalizationRow>()
}

/** Repair the D1 side of canonical success before any provider fetch or vision retry. */
export async function recoverFinalizedChannelMediaJob(
  job: ChannelMediaJob,
  env: Env,
): Promise<ChannelMediaCanonicalRecoveryResult> {
  const finalization = await finalizationFor(job, env)
  if (!finalization) return { status: 'stably_absent' }
  const store = getCanonicalMemoryStore(env)
  const capture = await store.getCapture(job.tenantId, finalization.canonical_capture_id)
  if (!capture) {
    if (finalization.status === 'failed') {
      return {
        status: 'failed',
        errorCode: finalization.error_code ?? ARTIFACT_INTAKE_ERROR.CANONICAL_WRITE_FAILED,
      }
    }
    if (finalization.status === 'finalized') {
      return { status: 'inconsistent', errorCode: ARTIFACT_INTAKE_ERROR.INVALID_STATE }
    }
    const staleAt = Number(finalization.updated_at) + CHANNEL_MEDIA_FINALIZATION_STALE_MS
    const now = Date.now()
    if (staleAt > now) {
      return { status: 'in_progress', retryAfterSeconds: channelMediaRetrySeconds(staleAt, now) }
    }
    const failed = await env.D1_US.prepare(
      `UPDATE artifact_intake_finalizations SET status = 'failed', error_code = ?, updated_at = ?
       WHERE tenant_id = ? AND id = ? AND status = 'reserved' AND updated_at = ?`,
    ).bind(
      ARTIFACT_INTAKE_ERROR.CANONICAL_WRITE_FAILED, now,
      job.tenantId, finalization.id, finalization.updated_at,
    ).run()
    if (Number(failed.meta.changes ?? 0) === 1) {
      return { status: 'failed', errorCode: ARTIFACT_INTAKE_ERROR.CANONICAL_WRITE_FAILED }
    }
    return { status: 'in_progress', retryAfterSeconds: 1 }
  }
  const document = await store.getDocument(job.tenantId, finalization.canonical_document_id)
  const result = await env.D1_US.prepare(
    `SELECT * FROM artifact_intake_operations
     WHERE tenant_id = ? AND canonical_capture_id = ? ORDER BY upload_id ASC`,
  ).bind(job.tenantId, finalization.canonical_capture_id).all<ArtifactIntakeOperationRow>()
  const operations = result.results
  const source = document?.artifact_manifest.filter(item => item.role === 'source') ?? []
  const primary = source.filter(item => item.primary)
  const operation = operations[0]
  const inconsistent = (
    !document || document.capture_id !== capture.id ||
    capture.source_system !== job.provider || capture.source_ref !== `${job.provider}:operation:${job.id}` ||
    source.length !== 1 || primary.length !== 1 || document.artifact_id !== primary[0]!.artifact_id ||
    document.artifact_manifest.length !== 1 || operations.length !== 1 || !operation ||
    operation.artifact_id !== primary[0]!.artifact_id || operation.encryption_family !== 'tmk' ||
    !operation.ciphertext_sha256 || Number(operation.byte_length) !== Number(primary[0]!.byte_length) ||
    operation.plaintext_sha256 !== primary[0]!.sha256 || operation.ciphertext_sha256 !== primary[0]!.cipher_sha256
  )
  if (inconsistent) return { status: 'inconsistent', errorCode: ARTIFACT_INTAKE_ERROR.INVALID_STATE }
  const now = Date.now()
  await markArtifactOperationsFinalized({
    tenantId: job.tenantId, uploadIds: [operation.upload_id],
    captureId: finalization.canonical_capture_id, documentId: finalization.canonical_document_id,
    operationId: finalization.canonical_operation_id, now,
  }, env)
  await env.D1_US.prepare(
    `UPDATE artifact_intake_finalizations SET status = 'finalized', error_code = NULL, updated_at = ?
     WHERE tenant_id = ? AND id = ? AND canonical_capture_id = ?`,
  ).bind(now, job.tenantId, finalization.id, finalization.canonical_capture_id).run()
  await repairChannelMediaFinalized({
    tenantId: job.tenantId, operationId: job.id, uploadId: operation.upload_id,
    captureId: finalization.canonical_capture_id, documentId: finalization.canonical_document_id,
    canonicalOperationId: finalization.canonical_operation_id,
  }, env)
  return { status: 'recovered' }
}
