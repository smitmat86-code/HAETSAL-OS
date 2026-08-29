import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'
import {
  getArtifactIntakeOperation,
  reserveArtifactUpload,
  uploadArtifactBytes,
} from '../src/services/artifact-intake/operations'
import { reapExpiredArtifactUploads } from '../src/services/artifact-intake/reaper'
import { deleteProvenManagedArtifact } from '../src/services/artifact-intake/storage'
import { sha256Bytes } from '../src/services/artifact-intake/crypto'
import type { Env } from '../src/types/env'

const SUITE_ID = crypto.randomUUID()
const TENANT = `test-tenant-bounded-reads-${SUITE_ID}`

interface FakeR2State {
  reads: number
  deletes: string[]
}

/**
 * Every R2 get/head answers with an object of the given size whose
 * arrayBuffer() increments a counter: the tests prove the counter stays at
 * zero whenever the recorded expectation and the object size disagree.
 */
function withFakeR2(target: Env, size: number, state: FakeR2State): Env {
  const fake = {
    get: async () => ({
      size,
      arrayBuffer: async () => {
        state.reads += 1
        return new ArrayBuffer(size)
      },
    }),
    head: async () => ({ size }),
    put: async () => undefined,
    delete: async (key: string) => { state.deletes.push(key) },
    list: async () => ({ objects: [] }),
  }
  return new Proxy(target, {
    get: (inner, property) =>
      property === 'R2_ARTIFACTS' ? fake : Reflect.get(inner, property),
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

async function reserveAndMaybeUpload(text: string, idempotencyKey: string, seal: boolean) {
  await ensureTenant()
  const bytes = new TextEncoder().encode(text)
  const plaintextSha256 = await sha256Bytes(bytes)
  const reserved = await reserveArtifactUpload({
    tenantId: TENANT, idempotencyKey, byteLength: bytes.byteLength,
    plaintextSha256, declaredMimeType: 'text/plain',
  }, env)
  if (seal) {
    await uploadArtifactBytes({
      tenantId: TENANT, uploadId: reserved.uploadId, bytes,
      detectedMimeType: 'text/plain', declaredMimeType: 'text/plain',
      encryptionFamily: 'tmk', key: await testKey(),
    }, env as Env)
  }
  return { bytes, reserved }
}

function uploadWith(target: Env, uploadId: string, bytes: Uint8Array) {
  return (async () => uploadArtifactBytes({
    tenantId: TENANT, uploadId, bytes,
    detectedMimeType: 'text/plain', declaredMimeType: 'text/plain',
    encryptionFamily: 'tmk', key: await testKey(),
  }, target))()
}

describe('12.19 bounded R2 body reads and proven deletion', () => {
  it('sealed replay never materializes an object whose size disagrees with the record', async () => {
    const { bytes, reserved } = await reserveAndMaybeUpload('replay-bound', `replay-${SUITE_ID}`, true)
    const row = await getArtifactIntakeOperation(env, TENANT, reserved.uploadId)
    const state: FakeR2State = { reads: 0, deletes: [] }
    const oversized = withFakeR2(env as Env, Number(row!.ciphertext_byte_length) + 1, state)
    await expect(uploadWith(oversized, reserved.uploadId, bytes))
      .rejects.toMatchObject({ code: 'ciphertext_invalid' })
    expect(state.reads).toBe(0)
    // The sealed record itself is untouched by the failed replay proof.
    expect(await getArtifactIntakeOperation(env, TENANT, reserved.uploadId)).toMatchObject({
      status: 'sealed', ciphertext_sha256: row!.ciphertext_sha256,
    })
  })

  it('legacy ciphertext recovery rejects a wrong-size legacy object before reading its body', async () => {
    const { bytes, reserved } = await reserveAndMaybeUpload('recovery-bound', `recovery-${SUITE_ID}`, false)
    const state: FakeR2State = { reads: 0, deletes: [] }
    // The object at the legacy key is not plaintext-length + envelope
    // overhead, so it cannot be this operation's genuine ciphertext.
    const oversized = withFakeR2(env as Env, bytes.byteLength + 34, state)
    await expect(uploadWith(oversized, reserved.uploadId, bytes))
      .rejects.toMatchObject({ code: 'ciphertext_invalid' })
    expect(state.reads).toBe(0)
    expect(await getArtifactIntakeOperation(env, TENANT, reserved.uploadId)).toMatchObject({
      status: 'failed', error_code: 'ciphertext_invalid',
    })
  })

  it('adopted-object deletion requires exact size and hash and never reads an oversized object', async () => {
    const { reserved } = await reserveAndMaybeUpload('delete-bound', `delete-${SUITE_ID}`, true)
    const row = await getArtifactIntakeOperation(env, TENANT, reserved.uploadId)
    const state: FakeR2State = { reads: 0, deletes: [] }
    const oversized = withFakeR2(env as Env, Number(row!.ciphertext_byte_length) + 1, state)
    await expect(deleteProvenManagedArtifact({
      env: oversized, tenantId: TENANT, uploadId: reserved.uploadId,
      recordedKey: row!.r2_key, adoptedAttemptToken: row!.adopted_attempt_token,
      expectedCiphertextSha256: row!.ciphertext_sha256,
      expectedCiphertextByteLength: row!.ciphertext_byte_length,
    })).rejects.toMatchObject({ code: 'hash_mismatch' })
    expect(state.reads).toBe(0)
    expect(state.deletes).toEqual([])
    // A recorded hash without a recorded length can never authorize a read.
    await expect(deleteProvenManagedArtifact({
      env: oversized, tenantId: TENANT, uploadId: reserved.uploadId,
      recordedKey: row!.r2_key, adoptedAttemptToken: row!.adopted_attempt_token,
      expectedCiphertextSha256: row!.ciphertext_sha256,
      expectedCiphertextByteLength: null,
    })).rejects.toMatchObject({ code: 'invalid_state' })
    expect(state.reads).toBe(0)
  })

  it('expired-operation reaping refuses an unproven object without materializing it', async () => {
    const { reserved } = await reserveAndMaybeUpload('reap-bound', `reap-${SUITE_ID}`, true)
    const row = await getArtifactIntakeOperation(env, TENANT, reserved.uploadId)
    await env.D1_US.prepare(
      `UPDATE artifact_intake_operations SET expires_at = 1 WHERE tenant_id = ? AND upload_id = ?`,
    ).bind(TENANT, reserved.uploadId).run()
    const state: FakeR2State = { reads: 0, deletes: [] }
    const oversized = withFakeR2(env as Env, Number(row!.ciphertext_byte_length) + 1, state)
    const result = await reapExpiredArtifactUploads(oversized, Date.now(), 100)
    expect(result.failed).toBeGreaterThanOrEqual(1)
    expect(state.reads).toBe(0)
    expect(state.deletes).toEqual([])
    // The row is preserved for manual review instead of being expired over an
    // unproven object.
    expect((await getArtifactIntakeOperation(env, TENANT, reserved.uploadId))?.status).toBe('sealed')
  })
})
