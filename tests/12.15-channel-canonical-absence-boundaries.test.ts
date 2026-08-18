import { afterEach, describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { recoverFinalizedChannelMediaJob } from '../src/services/channel-media/canonical-recovery'
import {
  getArtifactIntakeOperation,
  reserveArtifactUpload,
  uploadArtifactBytes,
} from '../src/services/artifact-intake/operations'
import { sha256Bytes, sha256Text } from '../src/services/artifact-intake/crypto'
import type { ChannelMediaJob } from '../src/types/channel-media'

const SUITE_ID = crypto.randomUUID()
const TENANT = `test-tenant-absence-boundary-${SUITE_ID}`

async function ensureTenant(): Promise<void> {
  const now = Date.now()
  await env.D1_US.prepare(
    `INSERT OR IGNORE INTO tenants
     (id, created_at, updated_at, data_region, primary_channel, hindsight_tenant_id, ai_cost_reset_at)
     VALUES (?, ?, ?, 'us', 'sms', ?, ?)`,
  ).bind(TENANT, now, now, `hindsight-${TENANT}`, now).run()
}

interface AbsentCanonicalSetup {
  job: ChannelMediaJob
  finalizationId: string
  uploadId: string
  r2Key: string
}

/**
 * A reserved channel finalization whose raw proof verifies but whose canonical
 * records were never written: the canonical-record-missing recovery state.
 */
async function absentCanonicalSetup(args: {
  recoveryExpiresAt: number
  leaseExpiresAt?: number
}): Promise<AbsentCanonicalSetup> {
  await ensureTenant()
  const bytes = new TextEncoder().encode(`absence-${crypto.randomUUID()}`)
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode('session-two-artifact-test-key!!!'),
    { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'],
  )
  const reserved = await reserveArtifactUpload({
    tenantId: TENANT, idempotencyKey: `absence-${crypto.randomUUID()}`,
    byteLength: bytes.byteLength, plaintextSha256: await sha256Bytes(bytes),
    declaredMimeType: 'text/plain',
  }, env)
  await uploadArtifactBytes({
    tenantId: TENANT, uploadId: reserved.uploadId, bytes,
    detectedMimeType: 'text/plain', declaredMimeType: 'text/plain',
    encryptionFamily: 'tmk', key,
  }, env)

  const jobId = crypto.randomUUID()
  const finalizationId = crypto.randomUUID()
  const captureId = crypto.randomUUID()
  const documentId = crypto.randomUUID()
  const operationId = crypto.randomUUID()
  const now = Date.now()
  await env.D1_US.batch([
    env.D1_US.prepare(
      `INSERT INTO artifact_intake_finalizations
       (id, tenant_id, idempotency_hash, manifest_sha256, status, error_code,
        canonical_capture_id, canonical_document_id, canonical_operation_id,
        created_at, updated_at, expected_operation_count, artifact_manifest_sha256,
        lease_owner, lease_expires_at, recovery_expires_at)
       VALUES (?, ?, ?, ?, 'reserved', NULL, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    ).bind(
      finalizationId, TENANT, await sha256Text(`channel-media-finalize:${jobId}`),
      crypto.randomUUID(), captureId, documentId, operationId, now, now,
      'a'.repeat(64),
      args.leaseExpiresAt === undefined ? null : 'boundary-lease-owner',
      args.leaseExpiresAt ?? null, args.recoveryExpiresAt,
    ),
    env.D1_US.prepare(
      `UPDATE artifact_intake_operations
       SET finalization_id = ?, canonical_capture_id = ?, canonical_document_id = ?,
           canonical_operation_id = ?, updated_at = ?
       WHERE tenant_id = ? AND upload_id = ?`,
    ).bind(finalizationId, captureId, documentId, operationId, now, TENANT, reserved.uploadId),
  ])
  const row = await getArtifactIntakeOperation(env, TENANT, reserved.uploadId)
  const job: ChannelMediaJob = {
    id: jobId, tenantId: TENANT, provider: 'telegram', status: 'processing',
    errorCode: null, attemptCount: 1, leaseToken: null, leaseExpiresAt: null,
    deliveryStatus: 'pending', handoffStatus: 'pending',
    artifactUploadId: reserved.uploadId, canonicalCaptureId: null,
    canonicalDocumentId: null, canonicalOperationId: null,
    createdAt: now, updatedAt: now, expiresAt: now + 60_000,
  }
  return { job, finalizationId, uploadId: reserved.uploadId, r2Key: row!.r2_key }
}

async function finalizationRow(finalizationId: string) {
  return env.D1_US.prepare(
    `SELECT status, lease_owner FROM artifact_intake_finalizations
     WHERE tenant_id = ? AND id = ?`,
  ).bind(TENANT, finalizationId).first<{ status: string; lease_owner: string | null }>()
}

afterEach(() => {
  vi.useRealTimers()
})

describe('12.15 canonical absence and expired recovery deadlines', () => {
  it('reports retryable absence one millisecond before the recovery deadline', async () => {
    const frozenNow = Date.now()
    const setup = await absentCanonicalSetup({ recoveryExpiresAt: frozenNow + 1 })
    vi.useFakeTimers({ now: frozenNow, toFake: ['Date'] })
    const result = await recoverFinalizedChannelMediaJob(setup.job, env)
    vi.useRealTimers()
    // Data preserved: the reservation can still acquire a normal lease and
    // the normal finalize path repairs it.
    expect(result).toEqual({ status: 'stably_absent' })
    expect(await finalizationRow(setup.finalizationId)).toMatchObject({ status: 'reserved' })
    expect(await env.R2_ARTIFACTS.head(setup.r2Key)).not.toBeNull()
    const operation = await getArtifactIntakeOperation(env, TENANT, setup.uploadId)
    expect(operation?.finalization_id).toBe(setup.finalizationId)
  })

  it('fails the reservation one millisecond after the recovery deadline', async () => {
    const frozenNow = Date.now()
    const setup = await absentCanonicalSetup({ recoveryExpiresAt: frozenNow - 1 })
    vi.useFakeTimers({ now: frozenNow, toFake: ['Date'] })
    const result = await recoverFinalizedChannelMediaJob(setup.job, env)
    vi.useRealTimers()
    // Guarded terminal transition: the reservation is failed and released so
    // it can never remain permanently bound without a normal lease.
    expect(result).toEqual({ status: 'failed', errorCode: 'canonical_write_failed' })
    expect(await finalizationRow(setup.finalizationId)).toMatchObject({ status: 'failed' })
    const operation = await getArtifactIntakeOperation(env, TENANT, setup.uploadId)
    expect(operation?.finalization_id).toBeNull()
  })

  it('defers to a live lease extending to the expired boundary', async () => {
    const frozenNow = Date.now()
    const setup = await absentCanonicalSetup({
      recoveryExpiresAt: frozenNow - 1_000, leaseExpiresAt: frozenNow + 1,
    })
    vi.useFakeTimers({ now: frozenNow, toFake: ['Date'] })
    const result = await recoverFinalizedChannelMediaJob(setup.job, env)
    vi.useRealTimers()
    // Never release raw data beneath a live canonical writer.
    expect(result.status).toBe('in_progress')
    expect(await finalizationRow(setup.finalizationId)).toMatchObject({
      status: 'reserved', lease_owner: 'boundary-lease-owner',
    })
    expect(await env.R2_ARTIFACTS.head(setup.r2Key)).not.toBeNull()
  })

  it('runs the guarded failure only once the boundary lease has lapsed', async () => {
    const frozenNow = Date.now()
    const setup = await absentCanonicalSetup({
      recoveryExpiresAt: frozenNow - 1_000, leaseExpiresAt: frozenNow,
    })
    vi.useFakeTimers({ now: frozenNow, toFake: ['Date'] })
    const result = await recoverFinalizedChannelMediaJob(setup.job, env)
    vi.useRealTimers()
    expect(result).toEqual({ status: 'failed', errorCode: 'canonical_write_failed' })
    expect(await finalizationRow(setup.finalizationId)).toMatchObject({ status: 'failed' })
  })
})
