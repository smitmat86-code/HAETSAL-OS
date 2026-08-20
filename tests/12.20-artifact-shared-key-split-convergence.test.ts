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
const TENANT = `test-tenant-split-convergence-${SUITE_ID}`

// The EXACT old-Worker (1e4d3a6) seal SQL: unconditional except status.
const OLD_WORKER_SEAL_SQL = `UPDATE artifact_intake_operations
     SET status = 'sealed', error_code = NULL, detected_mime_category = ?, ciphertext_sha256 = ?,
         ciphertext_byte_length = ?,
         encryption_family = ?, updated_at = ?
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

/** One writer's isolated R2 put: independently randomized AES-GCM ciphertext. */
async function isolatedPut(key: string, bytes: Uint8Array) {
  const sealed = await sealArtifactBytes(bytes, await testKey(), 'tmk')
  await env.R2_ARTIFACTS.put(key, sealed.envelope)
  return sealed
}

/** One writer's isolated D1 seal via the exact shipped old-Worker SQL. */
async function oldWorkerSealD1(uploadId: string, ciphertextSha256: string, byteLength: number) {
  await env.D1_US.prepare(OLD_WORKER_SEAL_SQL).bind(
    'text', ciphertextSha256, byteLength, 'tmk', Date.now(), TENANT, uploadId,
  ).run()
}

/** D1 and R2 agree: the object at the recorded key hashes to the recorded hash. */
async function expectNoSplit(uploadId: string): Promise<void> {
  const row = await getArtifactIntakeOperation(env, TENANT, uploadId)
  expect(row?.status).toBe('sealed')
  expect(row?.ciphertext_sha256).toBeTruthy()
  const object = await env.R2_ARTIFACTS.get(row!.r2_key)
  expect(object).not.toBeNull()
  const bytes = new Uint8Array(await object!.arrayBuffer())
  expect(bytes.byteLength).toBe(Number(row!.ciphertext_byte_length))
  expect(await sha256Bytes(bytes)).toBe(row!.ciphertext_sha256)
}

describe('12.20 overlapping-writer shared-key split convergence', () => {
  it('resolves the exact adverse ordering: old put, compat put, old D1 seal, compat adoption loss', async () => {
    const { bytes, reserved } = await reserveOperation(
      withPhase(env as Env, 'compat'), 'adverse-ordering-secret', `adverse-${SUITE_ID}`,
    )
    const legacyKey = await managedArtifactR2Key(TENANT, reserved.uploadId)
    // Step 1: the old writer's R2 put lands (ciphertext A). Its D1 seal has
    // NOT happened yet — the put and the D1 mutation are separate operations.
    const cipherA = await isolatedPut(legacyKey, bytes)
    // Step 2: the compat writer's R2 put lands (ciphertext B, same key).
    const cipherB = await isolatedPut(legacyKey, bytes)
    expect(cipherB.ciphertextSha256).not.toBe(cipherA.ciphertextSha256)
    // Step 3: the old writer's D1 seal commits hash A. R2 now holds B: split.
    await oldWorkerSealD1(reserved.uploadId, cipherA.ciphertextSha256, cipherA.envelope.byteLength)
    const split = await getArtifactIntakeOperation(env, TENANT, reserved.uploadId)
    expect(split?.ciphertext_sha256).toBe(cipherA.ciphertextSha256)
    // Step 4: the compat writer's adoption path runs against the now-sealed
    // row (its CAS loses). The corrected protocol must detect the recorded
    // identity no longer matches the object and converge onto the actual
    // stored ciphertext instead of dead-ending, because both writers proved
    // the same plaintext hash before writing.
    const receipt = await upload(withPhase(env as Env, 'compat'), reserved.uploadId, bytes)
    expect(receipt.status).toBe('sealed')
    expect(receipt.ciphertextSha256).toBe(cipherB.ciphertextSha256)
    await expectNoSplit(reserved.uploadId)
  })

  it('resolves the reverse ordering: compat adoption commits, then a late old put overwrites the key', async () => {
    const { bytes, reserved } = await reserveOperation(
      withPhase(env as Env, 'compat'), 'late-old-put-secret', `late-put-${SUITE_ID}`,
    )
    const sealedReceipt = await upload(withPhase(env as Env, 'compat'), reserved.uploadId, bytes)
    expect(sealedReceipt.status).toBe('sealed')
    // A resumed old request's R2 put lands after the compat adoption; the old
    // isolate dies before its D1 seal. D1 records B, R2 holds A: split.
    const legacyKey = await managedArtifactR2Key(TENANT, reserved.uploadId)
    const cipherA = await isolatedPut(legacyKey, bytes)
    expect(cipherA.ciphertextSha256).not.toBe(sealedReceipt.ciphertextSha256)
    // The next replay must converge D1 onto the actual object.
    const replay = await upload(withPhase(env as Env, 'active'), reserved.uploadId, bytes)
    expect(replay.status).toBe('sealed')
    expect(replay.ciphertextSha256).toBe(cipherA.ciphertextSha256)
    await expectNoSplit(reserved.uploadId)
  })

  it('restores a fenced row whose D1 hash was clobbered by a resumed old writer', async () => {
    const { bytes, reserved } = await reserveOperation(
      withPhase(env as Env, 'active'), 'fenced-clobber-secret', `fenced-clobber-${SUITE_ID}`,
    )
    const adoptedReceipt = await upload(env as Env, reserved.uploadId, bytes)
    expect(adoptedReceipt.status).toBe('sealed')
    const adopted = await getArtifactIntakeOperation(env, TENANT, reserved.uploadId)
    expect(adopted?.adopted_attempt_token).toBeTruthy()
    // A resumed old request puts to the legacy key and commits its
    // unconditional seal: D1 now records the old hash while r2_key still
    // points at the immutable adopted attempt object.
    const legacyKey = await managedArtifactR2Key(TENANT, reserved.uploadId)
    const cipherOld = await isolatedPut(legacyKey, bytes)
    await oldWorkerSealD1(reserved.uploadId, cipherOld.ciphertextSha256, cipherOld.envelope.byteLength)
    // The corrected protocol re-proves against the immutable attempt object
    // and restores the true adopted identity.
    const replay = await upload(env as Env, reserved.uploadId, bytes)
    expect(replay.status).toBe('sealed')
    expect(replay.ciphertextSha256).toBe(adoptedReceipt.ciphertextSha256)
    await expectNoSplit(reserved.uploadId)
  })
})
