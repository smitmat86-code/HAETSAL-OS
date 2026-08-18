import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'
import {
  getArtifactIntakeOperation,
  repairFailedFinalizationWithProvenChildren,
  reserveArtifactUpload,
  uploadArtifactBytes,
} from '../src/services/artifact-intake/operations'
import { reapExpiredArtifactUploads } from '../src/services/artifact-intake/reaper'
import { sha256Bytes } from '../src/services/artifact-intake/crypto'

const SUITE_ID = crypto.randomUUID()
const TENANT = `test-tenant-repair-races-${SUITE_ID}`

async function ensureTenant(): Promise<void> {
  const now = Date.now()
  await env.D1_US.prepare(
    `INSERT OR IGNORE INTO tenants
     (id, created_at, updated_at, data_region, primary_channel, hindsight_tenant_id, ai_cost_reset_at)
     VALUES (?, ?, ?, 'us', 'sms', ?, ?)`,
  ).bind(TENANT, now, now, `hindsight-${TENANT}`, now).run()
}

async function sealedOperation(idempotencyKey: string, text: string) {
  await ensureTenant()
  const bytes = new TextEncoder().encode(text)
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode('session-two-artifact-test-key!!!'),
    { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'],
  )
  const reserved = await reserveArtifactUpload({
    tenantId: TENANT, idempotencyKey, byteLength: bytes.byteLength,
    plaintextSha256: await sha256Bytes(bytes), declaredMimeType: 'text/plain',
  }, env)
  await uploadArtifactBytes({
    tenantId: TENANT, uploadId: reserved.uploadId, bytes,
    detectedMimeType: 'text/plain', declaredMimeType: 'text/plain',
    encryptionFamily: 'tmk', key,
  }, env)
  return reserved
}

interface Split {
  uploadId: string
  finalizationId: string
  captureId: string
  documentId: string
  operationId: string
}

/** A proof-backed historical split: parent failed while its child stayed sealed. */
async function failedParentSealedChild(idempotencyKey: string): Promise<Split> {
  const reserved = await sealedOperation(idempotencyKey, `repair-${idempotencyKey}`)
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
        created_at, updated_at, expected_operation_count, artifact_manifest_sha256)
       VALUES (?, ?, ?, ?, 'failed', 'canonical_write_failed', ?, ?, ?, ?, ?, 1, ?)`,
    ).bind(
      finalizationId, TENANT, crypto.randomUUID(), crypto.randomUUID(),
      captureId, documentId, operationId, now, now, 'a'.repeat(64),
    ),
    env.D1_US.prepare(
      `UPDATE artifact_intake_operations
       SET finalization_id = ?, canonical_capture_id = ?, canonical_document_id = ?,
           canonical_operation_id = ?, updated_at = ?
       WHERE tenant_id = ? AND upload_id = ?`,
    ).bind(finalizationId, captureId, documentId, operationId, now, TENANT, reserved.uploadId),
  ])
  return {
    uploadId: reserved.uploadId, finalizationId, captureId, documentId, operationId,
  }
}

async function finalizationStatus(finalizationId: string): Promise<string | undefined> {
  const row = await env.D1_US.prepare(
    `SELECT status FROM artifact_intake_finalizations WHERE tenant_id = ? AND id = ?`,
  ).bind(TENANT, finalizationId).first<{ status: string }>()
  return row?.status
}

function repairArgs(split: Split) {
  return {
    tenantId: TENANT, finalizationId: split.finalizationId,
    uploadIds: [split.uploadId], captureId: split.captureId,
    documentId: split.documentId, operationId: split.operationId, now: Date.now(),
  }
}

describe('12.13 reaper-safe failed-parent/sealed-child repair', () => {
  it('atomically finalizes the child with the parent on a clean split', async () => {
    const split = await failedParentSealedChild(`clean-${SUITE_ID}`)
    expect(await repairFailedFinalizationWithProvenChildren(repairArgs(split), env)).toBe('repaired')
    expect(await finalizationStatus(split.finalizationId)).toBe('finalized')
    const child = await getArtifactIntakeOperation(env, TENANT, split.uploadId)
    expect(child).toMatchObject({
      status: 'finalized', expiry_claim_token: null, finalization_id: split.finalizationId,
    })
  })

  it('preserves state and retries while a reaper claim owns the child', async () => {
    const split = await failedParentSealedChild(`claimed-${SUITE_ID}`)
    await env.D1_US.prepare(
      `UPDATE artifact_intake_operations
       SET expiry_claim_token = ?, expiry_claim_expires_at = ?
       WHERE tenant_id = ? AND upload_id = ?`,
    ).bind(crypto.randomUUID(), Date.now() + 60_000, TENANT, split.uploadId).run()
    expect(await repairFailedFinalizationWithProvenChildren(repairArgs(split), env)).toBe('retry')
    // Nothing was forced: the parent stays failed and the claimed child keeps
    // its sealed state and claim for the owning reaper.
    expect(await finalizationStatus(split.finalizationId)).toBe('failed')
    const child = await getArtifactIntakeOperation(env, TENANT, split.uploadId)
    expect(child?.status).toBe('sealed')
    expect(child?.expiry_claim_token).not.toBeNull()
  })

  it('never finalizes the parent after the reaper already expired the child', async () => {
    const split = await failedParentSealedChild(`reaped-${SUITE_ID}`)
    await env.D1_US.prepare(
      `UPDATE artifact_intake_operations SET expires_at = 1 WHERE tenant_id = ? AND upload_id = ?`,
    ).bind(TENANT, split.uploadId).run()
    const child = await getArtifactIntakeOperation(env, TENANT, split.uploadId)
    // The parent is failed, so the child is reaper-eligible and its raw
    // object is deleted before the repair races in.
    expect((await reapExpiredArtifactUploads(env, Date.now(), 100)).reaped).toBeGreaterThanOrEqual(1)
    expect(await env.R2_ARTIFACTS.head(child!.r2_key)).toBeNull()
    expect(await repairFailedFinalizationWithProvenChildren(repairArgs(split), env)).toBe('retry')
    expect(await finalizationStatus(split.finalizationId)).toBe('failed')
    expect((await getArtifactIntakeOperation(env, TENANT, split.uploadId))?.status).toBe('expired')
  })

  it('generic reaper preserves an existing canonical document body on metadata mismatch', async () => {
    const reserved = await sealedOperation(`body-preserve-${SUITE_ID}`, 'body-preserve-secret')
    const documentId = crypto.randomUUID()
    const bodyKey = `canonical/${TENANT}/documents/${documentId}.enc`
    await env.R2_ARTIFACTS.put(bodyKey, new TextEncoder().encode('sealed canonical body'))
    // A stale canonical pointer on an otherwise unbound, expired operation.
    await env.D1_US.prepare(
      `UPDATE artifact_intake_operations
       SET canonical_document_id = ?, expires_at = 1
       WHERE tenant_id = ? AND upload_id = ?`,
    ).bind(documentId, TENANT, reserved.uploadId).run()
    const row = await getArtifactIntakeOperation(env, TENANT, reserved.uploadId)
    expect((await reapExpiredArtifactUploads(env, Date.now(), 100)).reaped).toBeGreaterThanOrEqual(1)
    expect((await getArtifactIntakeOperation(env, TENANT, reserved.uploadId))?.status).toBe('expired')
    // The managed ciphertext is proven and deleted; the canonical document
    // body is preserved because the stale pointer proves nothing.
    expect(await env.R2_ARTIFACTS.head(row!.r2_key)).toBeNull()
    expect(await env.R2_ARTIFACTS.head(bodyKey)).not.toBeNull()
  })
})
