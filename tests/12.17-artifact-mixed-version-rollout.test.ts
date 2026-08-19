import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'
import {
  getArtifactIntakeOperation,
  reserveArtifactUpload,
  uploadArtifactBytes,
} from '../src/services/artifact-intake/operations'
import { sealArtifactBytes, sha256Bytes } from '../src/services/artifact-intake/crypto'
import { managedArtifactR2Key } from '../src/services/artifact-intake/storage-keys'
import type { Env } from '../src/types/env'

const SUITE_ID = crypto.randomUUID()
const TENANT = `test-tenant-mixed-rollout-${SUITE_ID}`

// The EXACT mutations the old Worker at 1e4d3a6 can still run during a
// gradual deployment. They are guarded only by status != 'finalized' and
// carry no attempt ownership, which is why attempt-key adoption must never be
// enabled on a row an old request could hold (migration 1033).
const OLD_WORKER_SEAL_SQL = `UPDATE artifact_intake_operations
     SET status = 'sealed', error_code = NULL, detected_mime_category = ?, ciphertext_sha256 = ?,
         ciphertext_byte_length = ?,
         encryption_family = ?, updated_at = ?
     WHERE tenant_id = ? AND upload_id = ? AND status != 'finalized'`
const OLD_WORKER_MARK_FAILED_SQL = `UPDATE artifact_intake_operations
     SET status = 'failed', error_code = ?, updated_at = ?
     WHERE tenant_id = ? AND upload_id = ? AND status != 'finalized'`

function withPhase(target: Env, phase: 'compat' | 'active'): Env {
  return new Proxy(target, {
    get: (inner, property) =>
      property === 'ARTIFACT_UPLOAD_PROTOCOL_PHASE' ? phase : Reflect.get(inner, property),
  })
}

async function ensureTenant(): Promise<void> {
  const now = Date.now()
  await env.D1_US.prepare(
    `INSERT OR IGNORE INTO tenants
     (id, created_at, updated_at, data_region, primary_channel, hindsight_tenant_id, ai_cost_reset_at)
     VALUES (?, ?, ?, 'us', 'sms', ?, ?)`,
  ).bind(TENANT, now, now, `hindsight-${TENANT}`, now).run()
}

async function testKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw', new TextEncoder().encode('session-two-artifact-test-key!!!'),
    { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'],
  )
}

async function reserveOperation(target: Env, text: string, idempotencyKey: string) {
  await ensureTenant()
  const bytes = new TextEncoder().encode(text)
  const plaintextSha256 = await sha256Bytes(bytes)
  const reserved = await reserveArtifactUpload({
    tenantId: TENANT, idempotencyKey, byteLength: bytes.byteLength,
    plaintextSha256, declaredMimeType: 'text/plain',
  }, target)
  return { bytes, reserved }
}

async function upload(target: Env, uploadId: string, bytes: Uint8Array) {
  return uploadArtifactBytes({
    tenantId: TENANT, uploadId, bytes,
    detectedMimeType: 'text/plain', declaredMimeType: 'text/plain',
    encryptionFamily: 'tmk', key: await testKey(),
  }, target)
}

/** The old Worker writes the legacy key, then commits its unconditional seal. */
async function oldWorkerPutAndSeal(uploadId: string, bytes: Uint8Array) {
  const legacyKey = await managedArtifactR2Key(TENANT, uploadId)
  const sealed = await sealArtifactBytes(bytes, await testKey(), 'tmk')
  await env.R2_ARTIFACTS.put(legacyKey, sealed.envelope)
  await env.D1_US.prepare(OLD_WORKER_SEAL_SQL).bind(
    'text', sealed.ciphertextSha256, sealed.envelope.byteLength, 'tmk',
    Date.now(), TENANT, uploadId,
  ).run()
  return { legacyKey, ciphertextSha256: sealed.ciphertextSha256 }
}

/** D1 and R2 agree: the object at the recorded key hashes to the recorded hash. */
async function expectNoSplit(uploadId: string): Promise<void> {
  const row = await getArtifactIntakeOperation(env, TENANT, uploadId)
  expect(row?.ciphertext_sha256).toBeTruthy()
  const object = await env.R2_ARTIFACTS.get(row!.r2_key)
  expect(object).not.toBeNull()
  const bytes = new Uint8Array(await object!.arrayBuffer())
  expect(bytes.byteLength).toBe(Number(row!.ciphertext_byte_length))
  expect(await sha256Bytes(bytes)).toBe(row!.ciphertext_sha256)
}

describe('12.17 mixed old/new Worker rollout protocol', () => {
  it('compat-phase reserve records the legacy protocol and uploads through the legacy key even on an active Worker', async () => {
    const { bytes, reserved } = await reserveOperation(
      withPhase(env as Env, 'compat'), 'compat-legacy-secret', `compat-${SUITE_ID}`,
    )
    const before = await getArtifactIntakeOperation(env, TENANT, reserved.uploadId)
    expect(before?.upload_protocol).toBeNull()
    // Dispatch follows the row's recorded protocol, never the Worker's phase:
    // an activated Worker must still treat an old-reachable row as legacy.
    const receipt = await upload(withPhase(env as Env, 'active'), reserved.uploadId, bytes)
    expect(receipt.status).toBe('sealed')
    const row = await getArtifactIntakeOperation(env, TENANT, reserved.uploadId)
    expect(row?.r2_key).toBe(await managedArtifactR2Key(TENANT, reserved.uploadId))
    expect(row?.adopted_attempt_token).toBeNull()
    await expectNoSplit(reserved.uploadId)
  })

  it('active-phase reserve creates a fenced row that adopts an immutable attempt key', async () => {
    const { bytes, reserved } = await reserveOperation(
      withPhase(env as Env, 'active'), 'active-fenced-secret', `active-${SUITE_ID}`,
    )
    const before = await getArtifactIntakeOperation(env, TENANT, reserved.uploadId)
    expect(before?.upload_protocol).toBe('fenced_v2')
    const receipt = await upload(env as Env, reserved.uploadId, bytes)
    expect(receipt.status).toBe('sealed')
    const row = await getArtifactIntakeOperation(env, TENANT, reserved.uploadId)
    expect(row?.adopted_attempt_token).toBeTruthy()
    expect(row?.r2_key.endsWith(`/${row?.adopted_attempt_token}.enc`)).toBe(true)
    await expectNoSplit(reserved.uploadId)
  })

  it('a row reserved by the exact old Worker INSERT is always handled as legacy', async () => {
    await ensureTenant()
    const bytes = new TextEncoder().encode('old-reserve-secret')
    const uploadId = crypto.randomUUID()
    const now = Date.now()
    // The old Worker's reserve INSERT names explicit columns and cannot set
    // upload_protocol, so every row it creates stays legacy forever.
    await env.D1_US.prepare(
      `INSERT OR IGNORE INTO artifact_intake_operations
       (id, tenant_id, upload_id, idempotency_hash, status, error_code, artifact_id, r2_key,
        declared_mime_category, detected_mime_category, byte_length, plaintext_sha256,
        ciphertext_sha256, encryption_family, canonical_capture_id, canonical_document_id,
        canonical_operation_id, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, 'reserved', NULL, ?, ?, ?, NULL, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(), TENANT, uploadId, crypto.randomUUID(), crypto.randomUUID(),
      await managedArtifactR2Key(TENANT, uploadId), 'text',
      bytes.byteLength, await sha256Bytes(bytes), now, now, now + 60_000,
    ).run()
    const receipt = await upload(withPhase(env as Env, 'active'), uploadId, bytes)
    expect(receipt.status).toBe('sealed')
    const row = await getArtifactIntakeOperation(env, TENANT, uploadId)
    expect(row?.upload_protocol).toBeNull()
    expect(row?.adopted_attempt_token).toBeNull()
    expect(row?.r2_key).toBe(await managedArtifactR2Key(TENANT, uploadId))
    await expectNoSplit(uploadId)
  })

  it('the exact old seal committing after a compat adoption cannot split D1 from R2', async () => {
    const { bytes, reserved } = await reserveOperation(
      withPhase(env as Env, 'compat'), 'old-seal-race-secret', `old-seal-${SUITE_ID}`,
    )
    const newReceipt = await upload(withPhase(env as Env, 'compat'), reserved.uploadId, bytes)
    expect(newReceipt.status).toBe('sealed')
    // The old writer resumes after the new adoption: it writes the shared
    // legacy key and commits its unconditional seal. Because legacy rows
    // never move r2_key to an attempt key, the recorded hash always refers to
    // the object the old writer just wrote — the state converges instead of
    // splitting into "new key, old hash".
    const old = await oldWorkerPutAndSeal(reserved.uploadId, bytes)
    const row = await getArtifactIntakeOperation(env, TENANT, reserved.uploadId)
    expect(row?.r2_key).toBe(old.legacyKey)
    expect(row?.ciphertext_sha256).toBe(old.ciphertextSha256)
    expect(row?.adopted_attempt_token).toBeNull()
    await expectNoSplit(reserved.uploadId)
    // A replay on the new Worker proves the converged identity end to end.
    const replay = await upload(withPhase(env as Env, 'active'), reserved.uploadId, bytes)
    expect(replay.ciphertextSha256).toBe(old.ciphertextSha256)
  })

  it('the exact old mark-failed committing after a compat adoption never strands the ciphertext', async () => {
    const { bytes, reserved } = await reserveOperation(
      withPhase(env as Env, 'compat'), 'old-fail-race-secret', `old-fail-${SUITE_ID}`,
    )
    await upload(withPhase(env as Env, 'compat'), reserved.uploadId, bytes)
    await env.D1_US.prepare(OLD_WORKER_MARK_FAILED_SQL).bind(
      'ciphertext_invalid', Date.now(), TENANT, reserved.uploadId,
    ).run()
    const failed = await getArtifactIntakeOperation(env, TENANT, reserved.uploadId)
    expect(failed?.status).toBe('failed')
    // The legacy object is untouched; the new Worker's bounded recovery
    // re-adopts it and D1 converges back onto the exact stored ciphertext.
    const recovered = await upload(withPhase(env as Env, 'active'), reserved.uploadId, bytes)
    expect(recovered.status).toBe('sealed')
    await expectNoSplit(reserved.uploadId)
  })

  it('the exact old legacy-recovery commit after a compat adoption converges on the legacy object', async () => {
    const { bytes, reserved } = await reserveOperation(
      withPhase(env as Env, 'compat'), 'old-recovery-race-secret', `old-recovery-${SUITE_ID}`,
    )
    await upload(withPhase(env as Env, 'compat'), reserved.uploadId, bytes)
    // The old recovery path re-hashes the object it finds at the legacy key
    // and commits the same unconditional update shape as its seal.
    const row = await getArtifactIntakeOperation(env, TENANT, reserved.uploadId)
    const object = await env.R2_ARTIFACTS.get(row!.r2_key)
    const existing = new Uint8Array(await object!.arrayBuffer())
    await env.D1_US.prepare(OLD_WORKER_SEAL_SQL).bind(
      'text', await sha256Bytes(existing), existing.byteLength, 'tmk',
      Date.now(), TENANT, reserved.uploadId,
    ).run()
    await expectNoSplit(reserved.uploadId)
    const replay = await upload(withPhase(env as Env, 'active'), reserved.uploadId, bytes)
    expect(replay.status).toBe('sealed')
  })
})
