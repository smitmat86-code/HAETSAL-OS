import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'
import {
  getArtifactIntakeOperation,
  reserveArtifactUpload,
  uploadArtifactBytes,
} from '../src/services/artifact-intake/operations'
import { reapExpiredArtifactUploads } from '../src/services/artifact-intake/reaper'
import { sha256Bytes } from '../src/services/artifact-intake/crypto'
import type { Env } from '../src/types/env'

const SUITE_ID = crypto.randomUUID()
const TENANT = `test-tenant-upload-races-${SUITE_ID}`

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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

interface PutGate {
  arrived: { promise: Promise<void>; resolve: () => void }
  release: { promise: Promise<void>; resolve: () => void }
  failPut?: boolean
}

/** Deterministic interleaving: the gated writer parks at its R2 put. */
function gatedEnv(gate: PutGate): Env {
  const r2 = new Proxy(env.R2_ARTIFACTS, {
    get(target, property) {
      if (property === 'put') {
        return async (...putArgs: Parameters<typeof target.put>) => {
          gate.arrived.resolve()
          await gate.release.promise
          if (gate.failPut) throw new Error('injected storage failure')
          return target.put(...putArgs)
        }
      }
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return new Proxy(env as Env, {
    get: (target, property) =>
      property === 'R2_ARTIFACTS' ? r2 : Reflect.get(target, property),
  })
}

async function reserveOperation(text: string, idempotencyKey: string) {
  await ensureTenant()
  const bytes = new TextEncoder().encode(text)
  const plaintextSha256 = await sha256Bytes(bytes)
  const reserved = await reserveArtifactUpload({
    tenantId: TENANT, idempotencyKey, byteLength: bytes.byteLength,
    plaintextSha256, declaredMimeType: 'text/plain',
  }, env)
  return { bytes, reserved, plaintextSha256 }
}

function uploadWith(target: Env, uploadId: string, bytes: Uint8Array) {
  return (async () => uploadArtifactBytes({
    tenantId: TENANT, uploadId, bytes,
    detectedMimeType: 'text/plain', declaredMimeType: 'text/plain',
    encryptionFamily: 'tmk', key: await testKey(),
  }, target))()
}

async function expireUploadAttempt(uploadId: string): Promise<void> {
  await env.D1_US.prepare(
    `UPDATE artifact_intake_operations SET upload_attempt_expires_at = 1
     WHERE tenant_id = ? AND upload_id = ?`,
  ).bind(TENANT, uploadId).run()
}

async function attemptObjectKeys(row: { r2_key: string }): Promise<string[]> {
  const prefix = row.r2_key.replace(/\/[^/]*$/, '/')
  const listed = await env.R2_ARTIFACTS.list({ prefix })
  return listed.objects.map((object: { key: string }) => object.key)
}

describe('12.12 fenced artifact upload ownership', () => {
  it('adopts exactly one immutable ciphertext object when two uploaders race', async () => {
    const { bytes, reserved } = await reserveOperation('dual-uploader-secret', `dual-${SUITE_ID}`)
    const gate: PutGate = { arrived: deferred(), release: deferred() }
    const stale = uploadWith(gatedEnv(gate), reserved.uploadId, bytes)
    await gate.arrived.promise

    // The first uploader's bounded attempt lease expires mid-flight; a second
    // uploader claims, seals, and is adopted.
    await expireUploadAttempt(reserved.uploadId)
    const winner = await uploadWith(env as Env, reserved.uploadId, bytes)
    expect(winner.status).toBe('sealed')
    const adopted = await getArtifactIntakeOperation(env, TENANT, reserved.uploadId)
    expect(adopted?.adopted_attempt_token).toBeTruthy()
    expect(adopted?.r2_key.endsWith(`/${adopted?.adopted_attempt_token}.enc`)).toBe(true)

    // The stale writer resumes: it may only write its own immutable attempt
    // key, its adoption loses, and it acknowledges the winner only after
    // exact proof of the adopted key, token, object, size, and hash.
    gate.release.resolve()
    const staleReceipt = await stale
    expect(staleReceipt.ciphertextSha256).toBe(adopted!.ciphertext_sha256)

    const final = await getArtifactIntakeOperation(env, TENANT, reserved.uploadId)
    expect(final).toMatchObject({
      status: 'sealed',
      r2_key: adopted!.r2_key,
      ciphertext_sha256: adopted!.ciphertext_sha256,
      adopted_attempt_token: adopted!.adopted_attempt_token,
    })
    const object = await env.R2_ARTIFACTS.get(final!.r2_key)
    expect(object).not.toBeNull()
    expect(await sha256Bytes(new Uint8Array(await object!.arrayBuffer())))
      .toBe(final!.ciphertext_sha256)
    // Exactly one adopted object survives: the loser proved it was not
    // adopted and deleted its own never-canonical orphan immediately.
    const keys = await attemptObjectKeys(final!)
    expect(keys).toEqual([final!.r2_key])
  })

  it('rejects a stale writer after its lease expired and cannot resurrect reaped state', async () => {
    const { bytes, reserved } = await reserveOperation('reaper-race-secret', `reaper-${SUITE_ID}`)
    const gate: PutGate = { arrived: deferred(), release: deferred() }
    const stale = uploadWith(gatedEnv(gate), reserved.uploadId, bytes)
    await gate.arrived.promise

    // The operation expires and the attempt lease lapses while the uploader
    // is parked at its R2 write; the reaper claims and expires the operation.
    await expireUploadAttempt(reserved.uploadId)
    await env.D1_US.prepare(
      `UPDATE artifact_intake_operations SET expires_at = 1
       WHERE tenant_id = ? AND upload_id = ?`,
    ).bind(TENANT, reserved.uploadId).run()
    const reaperResult = await reapExpiredArtifactUploads(env, Date.now(), 100)
    expect(reaperResult.reaped).toBeGreaterThanOrEqual(1)
    const reapedRow = await getArtifactIntakeOperation(env, TENANT, reserved.uploadId)
    expect(reapedRow?.status).toBe('expired')

    // The late writer lands its attempt object but can never adopt it or
    // resurrect the reaped operation.
    gate.release.resolve()
    await expect(stale).rejects.toMatchObject({ code: 'invalid_state' })
    const final = await getArtifactIntakeOperation(env, TENANT, reserved.uploadId)
    expect(final).toMatchObject({
      status: 'expired', ciphertext_sha256: null, adopted_attempt_token: null,
    })
    expect(await env.R2_ARTIFACTS.head(final!.r2_key)).toBeNull()
  })

  it('reaper defers while a live upload attempt owns an expired operation', async () => {
    const { bytes, reserved } = await reserveOperation('live-attempt-secret', `live-attempt-${SUITE_ID}`)
    const gate: PutGate = { arrived: deferred(), release: deferred() }
    const inFlight = uploadWith(gatedEnv(gate), reserved.uploadId, bytes)
    await gate.arrived.promise
    await env.D1_US.prepare(
      `UPDATE artifact_intake_operations SET expires_at = 1
       WHERE tenant_id = ? AND upload_id = ?`,
    ).bind(TENANT, reserved.uploadId).run()
    // The attempt lease is still live, so the reaper must not claim the row.
    expect((await reapExpiredArtifactUploads(env, Date.now(), 100)).reaped).toBe(0)
    const row = await getArtifactIntakeOperation(env, TENANT, reserved.uploadId)
    expect(row?.status).toBe('reserved')
    expect(row?.expiry_claim_token).toBeNull()
    gate.release.resolve()
    // Adoption still fails afterwards because the operation itself expired.
    await expect(inFlight).rejects.toMatchObject({ code: 'invalid_state' })
  })

  it('never downgrades a sealed finalization-bound operation from a stale failure writer', async () => {
    const { bytes, reserved } = await reserveOperation('bound-downgrade-secret', `bound-fail-${SUITE_ID}`)
    const gate: PutGate = { arrived: deferred(), release: deferred(), failPut: true }
    const stale = uploadWith(gatedEnv(gate), reserved.uploadId, bytes)
    await gate.arrived.promise

    // While the writer is parked, the operation is sealed and bound to a
    // finalization by a competing owner.
    const forgedHash = 'f'.repeat(64)
    await env.D1_US.prepare(
      `UPDATE artifact_intake_operations
       SET status = 'sealed', error_code = NULL, ciphertext_sha256 = ?,
           ciphertext_byte_length = ?, encryption_family = 'tmk',
           finalization_id = 'finalization-binding', upload_attempt_token = NULL,
           upload_attempt_expires_at = NULL
       WHERE tenant_id = ? AND upload_id = ?`,
    ).bind(forgedHash, bytes.byteLength + 33, TENANT, reserved.uploadId).run()

    gate.release.resolve()
    await expect(stale).rejects.toMatchObject({ code: 'storage_write_failed' })
    const row = await getArtifactIntakeOperation(env, TENANT, reserved.uploadId)
    expect(row).toMatchObject({
      status: 'sealed', error_code: null,
      finalization_id: 'finalization-binding', ciphertext_sha256: forgedHash,
    })
  })

  it('never lets a late adoption rewrite a sealed finalization-bound operation', async () => {
    const { bytes, reserved } = await reserveOperation('bound-adopt-secret', `bound-adopt-${SUITE_ID}`)
    const gate: PutGate = { arrived: deferred(), release: deferred() }
    const stale = uploadWith(gatedEnv(gate), reserved.uploadId, bytes)
    await gate.arrived.promise

    const forgedHash = 'e'.repeat(64)
    const forgedKey = `forged/${SUITE_ID}.enc`
    await env.D1_US.prepare(
      `UPDATE artifact_intake_operations
       SET status = 'sealed', error_code = NULL, ciphertext_sha256 = ?,
           ciphertext_byte_length = ?, encryption_family = 'tmk', r2_key = ?,
           finalization_id = 'finalization-binding', upload_attempt_token = NULL,
           upload_attempt_expires_at = NULL
       WHERE tenant_id = ? AND upload_id = ?`,
    ).bind(forgedHash, bytes.byteLength + 33, forgedKey, TENANT, reserved.uploadId).run()

    gate.release.resolve()
    // Adoption changes zero rows, and the loser must not acknowledge the
    // forged identity: the recorded key does not derive from this operation
    // and no object backs the recorded hash, so exact proof fails closed as
    // an integrity rejection while the sealed row is left untouched.
    await expect(stale).rejects.toMatchObject({ code: 'ciphertext_invalid' })
    const row = await getArtifactIntakeOperation(env, TENANT, reserved.uploadId)
    expect(row).toMatchObject({
      status: 'sealed', r2_key: forgedKey,
      ciphertext_sha256: forgedHash, finalization_id: 'finalization-binding',
      adopted_attempt_token: null,
    })
  })
})
