import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'
import {
  getArtifactIntakeOperation,
  reserveArtifactUpload,
  uploadArtifactBytes,
} from '../src/services/artifact-intake/operations'
import { sealArtifactBytes, sha256Bytes } from '../src/services/artifact-intake/crypto'
import {
  managedArtifactAttemptR2Key,
  managedArtifactR2Key,
} from '../src/services/artifact-intake/storage-keys'
import { finalizeArtifactCapture } from '../src/services/artifact-intake/finalize'
import { sweepRetiredLegacyArtifactKeys } from '../src/services/artifact-intake/legacy-key-sweep'
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

function promotionPutCommitsThenThrows(target: Env): Env {
  let injected = false
  const r2 = new Proxy(target.R2_ARTIFACTS, {
    get(bucket, property) {
      if (property === 'put') return async (...args: Parameters<typeof bucket.put>) => {
        const result = await bucket.put(...args)
        if (!injected && String(args[0]).split('/').length === 5) {
          injected = true
          throw new Error('ambiguous promotion put')
        }
        return result
      }
      const value = Reflect.get(bucket, property)
      return typeof value === 'function' ? value.bind(bucket) : value
    },
  })
  return new Proxy(target, {
    get: (inner, property) => property === 'R2_ARTIFACTS' ? r2 : Reflect.get(inner, property),
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
  it('promotes a legacy object to an immutable key before finalization so a late old put is harmless', async () => {
    const { bytes, reserved } = await reserveOperation(
      withPhase(env as Env, 'compat'), 'finalized-late-put-secret', `finalized-late-${SUITE_ID}`,
    )
    await upload(withPhase(env as Env, 'compat'), reserved.uploadId, bytes)
    const legacyKey = await managedArtifactR2Key(TENANT, reserved.uploadId)

    const receipt = await finalizeArtifactCapture({
      tenantId: TENANT,
      content: 'searchable finalized late-put extraction',
      scope: 'general',
      clientName: 'codex-test',
      idempotencyKey: `finalize-late-${SUITE_ID}`,
      artifacts: [{
        uploadId: reserved.uploadId,
        role: 'source',
        primary: true,
        detectedMimeType: 'text/plain',
        byteLength: bytes.byteLength,
        plaintextSha256: await sha256Bytes(bytes),
      }],
    }, await testKey(), env as Env)

    const finalized = await getArtifactIntakeOperation(env, TENANT, reserved.uploadId)
    expect(finalized?.status).toBe('finalized')
    expect(finalized?.adopted_attempt_token).toBeTruthy()
    expect(finalized?.r2_key).not.toBe(legacyKey)

    // The indefinitely delayed old request can still write its known legacy
    // key, but that key is no longer canonical and cannot corrupt raw proof.
    await isolatedPut(legacyKey, bytes)
    await oldWorkerSealD1(reserved.uploadId, '0'.repeat(64), bytes.byteLength + 33)
    const swept = await sweepRetiredLegacyArtifactKeys(env as Env, Date.now(), 100)
    expect(swept.deleted).toBe(1)
    expect(await env.R2_ARTIFACTS.head(legacyKey)).toBeNull()
    const tombstone = await env.D1_US.prepare(
      `SELECT sweep_count FROM artifact_legacy_key_tombstones
       WHERE tenant_id = ? AND upload_id = ?`,
    ).bind(TENANT, reserved.uploadId).first<{ sweep_count: number }>()
    expect(Number(tombstone?.sweep_count ?? 0)).toBeGreaterThan(0)

    const duplicate = await finalizeArtifactCapture({
      tenantId: TENANT,
      content: 'searchable finalized late-put extraction',
      scope: 'general',
      clientName: 'codex-test',
      idempotencyKey: `finalize-late-${SUITE_ID}`,
      artifacts: [{
        uploadId: reserved.uploadId,
        role: 'source',
        primary: true,
        detectedMimeType: 'text/plain',
        byteLength: bytes.byteLength,
        plaintextSha256: await sha256Bytes(bytes),
      }],
    }, await testKey(), env as Env)
    expect(duplicate).toEqual(receipt)
  })

  it('the D1 enforcement trigger rejects an indefinitely delayed old legacy finalization', async () => {
    const { bytes, reserved } = await reserveOperation(
      withPhase(env as Env, 'compat'), 'old-finalize-secret', `old-finalize-${SUITE_ID}`,
    )
    await upload(withPhase(env as Env, 'compat'), reserved.uploadId, bytes)
    await expect(env.D1_US.prepare(
      `UPDATE artifact_intake_operations SET finalization_id = ?
       WHERE tenant_id = ? AND upload_id = ? AND finalization_id IS NULL`,
    ).bind(crypto.randomUUID(), TENANT, reserved.uploadId).run())
      .rejects.toThrow(/immutable artifact identity required before binding/)
    const row = await getArtifactIntakeOperation(env, TENANT, reserved.uploadId)
    expect(row?.status).toBe('sealed')
    expect(row?.finalization_id).toBeNull()
  })

  it('retains exact ownership and the cleanup journal when a promotion put is ambiguous', async () => {
    const compat = withPhase(env as Env, 'compat')
    const { bytes, reserved } = await reserveOperation(
      compat, 'ambiguous-promotion-secret', `ambiguous-promotion-${SUITE_ID}`,
    )
    await upload(compat, reserved.uploadId, bytes)
    const input = {
      tenantId: TENANT, content: 'searchable ambiguous promotion extraction',
      scope: 'general', clientName: 'codex-test',
      idempotencyKey: `ambiguous-finalize-${SUITE_ID}`,
      artifacts: [{
        uploadId: reserved.uploadId, role: 'source' as const, primary: true,
        detectedMimeType: 'text/plain', byteLength: bytes.byteLength,
        plaintextSha256: await sha256Bytes(bytes),
      }],
    }
    await expect(finalizeArtifactCapture(
      input, await testKey(), promotionPutCommitsThenThrows(compat),
    )).rejects.toBeTruthy()
    const row = await getArtifactIntakeOperation(env, TENANT, reserved.uploadId)
    expect(row?.upload_attempt_token).toBeTruthy()
    expect(row?.adopted_attempt_token).toBeNull()
    const attemptKey = await managedArtifactAttemptR2Key(
      TENANT, reserved.uploadId, row!.upload_attempt_token!,
    )
    expect(await env.R2_ARTIFACTS.head(attemptKey)).not.toBeNull()
    const journal = await env.D1_US.prepare(
      `SELECT 1 AS present FROM artifact_upload_attempts
       WHERE tenant_id = ? AND upload_id = ? AND attempt_token = ?`,
    ).bind(TENANT, reserved.uploadId, row!.upload_attempt_token).first<{ present: number }>()
    expect(journal?.present).toBe(1)
  })

  it('rejects a late old D1 seal after final proof and repairs it on retry before finalizing', async () => {
    const { bytes, reserved } = await reserveOperation(
      withPhase(env as Env, 'compat'), 'final-proof-race-secret', `final-proof-${SUITE_ID}`,
    )
    await upload(withPhase(env as Env, 'compat'), reserved.uploadId, bytes)
    const legacyKey = await managedArtifactR2Key(TENANT, reserved.uploadId)
    const input = {
      tenantId: TENANT,
      content: 'searchable final-proof race extraction',
      scope: 'general',
      clientName: 'codex-test',
      idempotencyKey: `final-proof-${SUITE_ID}`,
      artifacts: [{
        uploadId: reserved.uploadId,
        role: 'source' as const,
        primary: true,
        detectedMimeType: 'text/plain',
        byteLength: bytes.byteLength,
        plaintextSha256: await sha256Bytes(bytes),
      }],
    }
    let injected = false
    await expect(finalizeArtifactCapture(input, await testKey(), env as Env, {
      afterFinalRawProof: async () => {
        if (injected) return
        injected = true
        const old = await isolatedPut(legacyKey, bytes)
        await oldWorkerSealD1(reserved.uploadId, old.ciphertextSha256, old.envelope.byteLength)
      },
    })).rejects.toMatchObject({ code: 'invalid_state' })

    const split = await getArtifactIntakeOperation(env, TENANT, reserved.uploadId)
    expect(split?.status).toBe('sealed')
    expect(split?.adopted_attempt_token).toBeTruthy()
    const receipt = await finalizeArtifactCapture(input, await testKey(), env as Env)
    expect(receipt.status).toBe('finalized')
    const finalized = await getArtifactIntakeOperation(env, TENANT, reserved.uploadId)
    expect(finalized?.status).toBe('finalized')
    expect(finalized?.r2_key).not.toBe(legacyKey)
  })

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
