import type { Env } from '../../types/env'
import { CHANNEL_MEDIA_JOB_LEASE_MS } from '../artifact-intake/config'
import { ArtifactIntakeContractError, ARTIFACT_INTAKE_ERROR } from '../artifact-intake/contracts'

function requireLeaseChange(result: D1Result): void {
  if (Number(result.meta.changes ?? 0) !== 1) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.LEASE_LOST)
  }
}

export async function renewChannelMediaLease(
  tenantId: string, operationId: string, leaseToken: string, env: Env,
): Promise<void> {
  const now = Date.now()
  const result = await env.D1_US.prepare(
    `UPDATE channel_media_jobs SET lease_expires_at = ?, updated_at = ?
     WHERE tenant_id = ? AND id = ? AND status = 'processing'
       AND lease_token = ? AND lease_expires_at >= ?`,
  ).bind(now + CHANNEL_MEDIA_JOB_LEASE_MS, now, tenantId, operationId, leaseToken, now).run()
  requireLeaseChange(result)
}

export async function markChannelMediaRetryable(
  tenantId: string, operationId: string, leaseToken: string, errorCode: string, env: Env,
): Promise<void> {
  const now = Date.now()
  const result = await env.D1_US.prepare(
    `UPDATE channel_media_jobs SET status = 'retryable', error_code = ?, lease_token = NULL,
     lease_expires_at = NULL, updated_at = ? WHERE tenant_id = ? AND id = ?
       AND status = 'processing' AND lease_token = ? AND lease_expires_at >= ?`,
  ).bind(errorCode, now, tenantId, operationId, leaseToken, now).run()
  requireLeaseChange(result)
}

export async function markChannelMediaFinalized(args: {
  tenantId: string; operationId: string; uploadId: string
  captureId: string; documentId: string; canonicalOperationId: string; leaseToken: string
}, env: Env): Promise<void> {
  const now = Date.now()
  const result = await env.D1_US.prepare(
    `UPDATE channel_media_jobs SET status = 'finalized', error_code = NULL,
     artifact_upload_id = ?, canonical_capture_id = ?, canonical_document_id = ?,
     canonical_operation_id = ?, lease_token = NULL, lease_expires_at = NULL, updated_at = ?
     WHERE tenant_id = ? AND id = ? AND status = 'processing'
       AND lease_token = ? AND lease_expires_at >= ?`,
  ).bind(
    args.uploadId, args.captureId, args.documentId, args.canonicalOperationId,
    now, args.tenantId, args.operationId, args.leaseToken, now,
  ).run()
  requireLeaseChange(result)
}

/** Canonical proof is authoritative and may repair a competing pending failure. */
export async function repairChannelMediaFinalized(args: {
  tenantId: string; operationId: string; uploadId: string
  captureId: string; documentId: string; canonicalOperationId: string
}, env: Env): Promise<void> {
  const result = await env.D1_US.prepare(
    `UPDATE channel_media_jobs SET status = 'finalized', error_code = NULL,
     artifact_upload_id = ?, canonical_capture_id = ?, canonical_document_id = ?,
     canonical_operation_id = ?, lease_token = NULL, lease_expires_at = NULL, updated_at = ?
     WHERE tenant_id = ? AND id = ? AND delivery_status = 'pending'
       AND status IN ('accepted', 'processing', 'retryable', 'finalized', 'failed')`,
  ).bind(
    args.uploadId, args.captureId, args.documentId, args.canonicalOperationId,
    Date.now(), args.tenantId, args.operationId,
  ).run()
  if (Number(result.meta.changes ?? 0) !== 1) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.LEASE_LOST)
  }
}

/** Records an authoritative post-finalization integrity incident without a false failure reply. */
export async function markChannelMediaIntegrityIncident(
  tenantId: string, operationId: string, env: Env,
): Promise<void> {
  await env.D1_US.prepare(
    `UPDATE channel_media_jobs SET status = 'delivery_unknown', delivery_status = 'unknown',
     error_code = ?, lease_token = NULL, lease_expires_at = NULL, updated_at = ?
     WHERE tenant_id = ? AND id = ?
       AND status IN ('processing', 'finalized', 'delivery_unknown')`,
  ).bind(ARTIFACT_INTAKE_ERROR.INVALID_STATE, Date.now(), tenantId, operationId).run()
}

export async function markChannelMediaFailed(
  tenantId: string, operationId: string, leaseToken: string, errorCode: string, env: Env,
): Promise<void> {
  const now = Date.now()
  const result = await env.D1_US.prepare(
    `UPDATE channel_media_jobs SET status = 'failed', error_code = ?, lease_token = NULL,
     lease_expires_at = NULL, updated_at = ? WHERE tenant_id = ? AND id = ?
       AND status = 'processing' AND lease_token = ? AND lease_expires_at >= ?`,
  ).bind(errorCode, now, tenantId, operationId, leaseToken, now).run()
  requireLeaseChange(result)
}
