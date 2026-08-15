import type { Env } from '../../types/env'
import type {
  ChannelMediaDescriptor,
  ChannelMediaJob,
  ChannelMediaJobStatus,
  ChannelMediaProvider,
} from '../../types/channel-media'
import {
  CHANNEL_MEDIA_HANDOFF_EXPIRY_MS,
  CHANNEL_MEDIA_JOB_LEASE_MS,
} from '../artifact-intake/config'
import { ArtifactIntakeContractError, ARTIFACT_INTAKE_ERROR } from '../artifact-intake/contracts'
import { sha256Text } from '../artifact-intake/crypto'
import { writeChannelMediaHandoff } from './handoff'
import { validateChannelMediaDescriptor } from './descriptor'

interface JobRow {
  id: string; tenant_id: string; provider: ChannelMediaProvider; status: ChannelMediaJobStatus
  error_code: string | null; attempt_count: number; lease_token: string | null
  lease_expires_at: number | null
  delivery_status: ChannelMediaJob['deliveryStatus']; artifact_upload_id: string | null
  handoff_status: ChannelMediaJob['handoffStatus']
  canonical_capture_id: string | null; canonical_document_id: string | null
  canonical_operation_id: string | null; created_at: number; updated_at: number; expires_at: number
}

function toJob(row: JobRow): ChannelMediaJob {
  return {
    id: row.id, tenantId: row.tenant_id, provider: row.provider, status: row.status,
    errorCode: row.error_code, attemptCount: Number(row.attempt_count),
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at === null ? null : Number(row.lease_expires_at),
    deliveryStatus: row.delivery_status, handoffStatus: row.handoff_status,
    artifactUploadId: row.artifact_upload_id,
    canonicalCaptureId: row.canonical_capture_id, canonicalDocumentId: row.canonical_document_id,
    canonicalOperationId: row.canonical_operation_id, createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at), expiresAt: Number(row.expires_at),
  }
}

function changedExactlyOnce(result: D1Result): boolean {
  return Number(result.meta.changes ?? 0) === 1
}

export async function getChannelMediaJob(
  tenantId: string,
  operationId: string,
  env: Env,
): Promise<ChannelMediaJob | null> {
  const row = await env.D1_US.prepare(
    'SELECT * FROM channel_media_jobs WHERE tenant_id = ? AND id = ? LIMIT 1',
  ).bind(tenantId, operationId).first<JobRow>()
  return row ? toJob(row) : null
}
export async function reserveChannelMediaJob(args: {
  tenantId: string
  provider: ChannelMediaProvider
  eventIdentity: string
  descriptor: ChannelMediaDescriptor
  kek: CryptoKey
  now?: number
}, env: Env): Promise<ChannelMediaJob> {
  const descriptor = validateChannelMediaDescriptor(args.descriptor)
  if (descriptor.provider !== args.provider || args.eventIdentity.length < 1) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.PROVIDER_LOCATOR_INVALID)
  }
  const now = args.now ?? Date.now()
  const eventHash = await sha256Text(`${env.HMAC_SECRET}:${args.tenantId}:${args.provider}:${args.eventIdentity}`)
  const operationId = crypto.randomUUID()
  await env.D1_US.prepare(
    `INSERT OR IGNORE INTO channel_media_jobs
     (id, tenant_id, provider, event_identity_hash, status, error_code, attempt_count,
      lease_token, lease_expires_at, delivery_status, handoff_status, artifact_upload_id,
      canonical_capture_id, canonical_document_id, canonical_operation_id,
      created_at, updated_at, expires_at)
     VALUES (?, ?, ?, ?, 'accepted', NULL, 0, NULL, NULL, 'pending', 'pending', NULL, NULL, NULL, NULL, ?, ?, ?)`,
  ).bind(
    operationId, args.tenantId, args.provider, eventHash,
    now, now, now + CHANNEL_MEDIA_HANDOFF_EXPIRY_MS,
  ).run()
  const row = await env.D1_US.prepare(
    `SELECT * FROM channel_media_jobs
     WHERE tenant_id = ? AND provider = ? AND event_identity_hash = ? LIMIT 1`,
  ).bind(args.tenantId, args.provider, eventHash).first<JobRow>()
  if (!row) throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_STATE)
  if (row.handoff_status === 'pending' && row.delivery_status === 'pending') {
    await writeChannelMediaHandoff({
      tenantId: args.tenantId, operationId: row.id, descriptor, kek: args.kek,
    }, env)
  }
  return toJob(row)
}
export async function claimChannelMediaJob(
  tenantId: string,
  operationId: string,
  env: Env,
): Promise<ChannelMediaJob | null> {
  const existing = await getChannelMediaJob(tenantId, operationId, env)
  if (!existing) throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.NOT_FOUND)
  if (existing.status === 'finalized' && existing.deliveryStatus === 'pending') return existing
  if (existing.status === 'failed' && existing.deliveryStatus === 'pending') return existing
  if (existing.deliveryStatus === 'claimed') {
    if (existing.updatedAt + CHANNEL_MEDIA_JOB_LEASE_MS > Date.now()) return null
    await env.D1_US.prepare(
      `UPDATE channel_media_jobs SET
       status = CASE WHEN status = 'failed' THEN 'failed' ELSE 'delivery_unknown' END,
       delivery_status = 'unknown',
       error_code = CASE WHEN status = 'failed' THEN error_code ELSE ? END,
       updated_at = ? WHERE tenant_id = ? AND id = ? AND delivery_status = 'claimed'`,
    ).bind(ARTIFACT_INTAKE_ERROR.DELIVERY_UNKNOWN, Date.now(), tenantId, operationId).run()
    return null
  }
  if (existing.status === 'delivered' || existing.status === 'failed' || existing.status === 'delivery_unknown') return null
  const now = Date.now()
  const token = crypto.randomUUID()
  const claimed = await env.D1_US.prepare(
    `UPDATE channel_media_jobs
     SET status = 'processing', error_code = NULL, attempt_count = attempt_count + 1,
         lease_token = ?, lease_expires_at = ?, updated_at = ?
     WHERE tenant_id = ? AND id = ? AND
       (status IN ('accepted', 'retryable') OR (status = 'processing' AND lease_expires_at <= ?))`,
  ).bind(token, now + CHANNEL_MEDIA_JOB_LEASE_MS, now, tenantId, operationId, now).run()
  if (!changedExactlyOnce(claimed)) return null
  const row = await env.D1_US.prepare(
    'SELECT * FROM channel_media_jobs WHERE tenant_id = ? AND id = ? AND lease_token = ? LIMIT 1',
  ).bind(tenantId, operationId, token).first<JobRow>()
  if (!row) throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.LEASE_LOST)
  return toJob(row)
}
