import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'
import {
  cleanupLosingUploadAttempt,
  recordUploadAttemptIntent,
} from '../src/services/artifact-intake/attempt-orphans'
import { sweepAbandonedArtifactUploadAttempts } from '../src/services/artifact-intake/attempt-sweep'
import {
  getArtifactIntakeOperation,
  markUploadFailed,
  reserveArtifactUpload,
  uploadArtifactBytes,
} from '../src/services/artifact-intake/operations'
import { reapExpiredArtifactUploads } from '../src/services/artifact-intake/reaper'
import { sealArtifactBytes, sha256Bytes } from '../src/services/artifact-intake/crypto'
import { managedArtifactAttemptR2Key } from '../src/services/artifact-intake/storage-keys'
import { ARTIFACT_UPLOAD_ATTEMPT_ORPHAN_GRACE_MS } from '../src/services/artifact-intake/config'
import type { Env } from '../src/types/env'

const SUITE_ID = crypto.randomUUID()
const TENANT = `test-tenant-orphan-cleanup-${SUITE_ID}`

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

async function reserveOperation(text: string, idempotencyKey: string) {
  await ensureTenant()
  const bytes = new TextEncoder().encode(text)
  const plaintextSha256 = await sha256Bytes(bytes)
  const reserved = await reserveArtifactUpload({
    tenantId: TENANT, idempotencyKey, byteLength: bytes.byteLength,
    plaintextSha256, declaredMimeType: 'text/plain',
  }, env)
  return { bytes, reserved }
}

async function upload(uploadId: string, bytes: Uint8Array) {
  return uploadArtifactBytes({
    tenantId: TENANT, uploadId, bytes,
    detectedMimeType: 'text/plain', declaredMimeType: 'text/plain',
    encryptionFamily: 'tmk', key: await testKey(),
  }, env as Env)
}

/** Simulates a fenced attempt that journalled, put its object, then died. */
async function crashAttempt(uploadId: string, bytes: Uint8Array, leaseExpiresAt: number) {
  const attemptToken = crypto.randomUUID()
  const now = Date.now()
  await recordUploadAttemptIntent(env as Env, {
    tenantId: TENANT, uploadId, attemptToken, leaseExpiresAt, now,
  })
  const key = await managedArtifactAttemptR2Key(TENANT, uploadId, attemptToken)
  const sealed = await sealArtifactBytes(bytes, await testKey(), 'tmk')
  await env.R2_ARTIFACTS.put(key, sealed.envelope)
  return { attemptToken, key }
}

async function journalCount(uploadId: string): Promise<number> {
  const row = await env.D1_US.prepare(
    `SELECT COUNT(*) AS count FROM artifact_upload_attempts WHERE tenant_id = ? AND upload_id = ?`,
  ).bind(TENANT, uploadId).first<{ count: number }>()
  return Number(row?.count ?? 0)
}

describe('12.18 crash-safe orphan attempt governance', () => {
  it('deletes an attempt orphaned by a crash after its R2 put but before adoption', async () => {
    const { bytes, reserved } = await reserveOperation('crash-after-put', `crash-${SUITE_ID}`)
    const crashed = await crashAttempt(reserved.uploadId, bytes, Date.now() - 1)
    // Before the grace boundary the attempt could still be writing: kept.
    const early = await sweepAbandonedArtifactUploadAttempts(env as Env, Date.now(), 100)
    expect(early.deleted).toBe(0)
    expect(await env.R2_ARTIFACTS.head(crashed.key)).not.toBeNull()
    // Past lease expiry plus the full write-lifetime grace window: deleted.
    const late = await sweepAbandonedArtifactUploadAttempts(
      env as Env, Date.now() + ARTIFACT_UPLOAD_ATTEMPT_ORPHAN_GRACE_MS + 1, 100,
    )
    expect(late.deleted).toBe(1)
    expect(await env.R2_ARTIFACTS.head(crashed.key)).toBeNull()
    // The tombstone survives until a later sweep confirms the deletion stuck.
    expect(await journalCount(reserved.uploadId)).toBe(1)
    await sweepAbandonedArtifactUploadAttempts(
      env as Env, Date.now() + ARTIFACT_UPLOAD_ATTEMPT_ORPHAN_GRACE_MS + 1, 100,
    )
    expect(await journalCount(reserved.uploadId)).toBe(0)
  })

  it('deletes a stale attempt that put its object after the parent operation was reaped', async () => {
    const { bytes, reserved } = await reserveOperation('stale-after-reap', `reaped-${SUITE_ID}`)
    await env.D1_US.prepare(
      `UPDATE artifact_intake_operations SET expires_at = 1 WHERE tenant_id = ? AND upload_id = ?`,
    ).bind(TENANT, reserved.uploadId).run()
    expect((await reapExpiredArtifactUploads(env, Date.now(), 100)).reaped).toBeGreaterThanOrEqual(1)
    expect((await getArtifactIntakeOperation(env, TENANT, reserved.uploadId))?.status).toBe('expired')
    // The stale writer's put lands only now, against an already-reaped parent.
    const stale = await crashAttempt(reserved.uploadId, bytes, Date.now() - 1)
    const sweep = await sweepAbandonedArtifactUploadAttempts(
      env as Env, Date.now() + ARTIFACT_UPLOAD_ATTEMPT_ORPHAN_GRACE_MS + 1, 100,
    )
    expect(sweep.deleted).toBe(1)
    expect(await env.R2_ARTIFACTS.head(stale.key)).toBeNull()
    await sweepAbandonedArtifactUploadAttempts(
      env as Env, Date.now() + ARTIFACT_UPLOAD_ATTEMPT_ORPHAN_GRACE_MS + 1, 100,
    )
    expect(await journalCount(reserved.uploadId)).toBe(0)
  })

  it('preserves the adopted object through D1 ambiguity after a successful adoption', async () => {
    const { bytes, reserved } = await reserveOperation('ambiguous-won', `ambiguous-won-${SUITE_ID}`)
    await upload(reserved.uploadId, bytes)
    const row = await getArtifactIntakeOperation(env, TENANT, reserved.uploadId)
    expect(row?.adopted_attempt_token).toBeTruthy()
    // The adoption response was lost, but the reread proves this attempt won:
    // nothing may be deleted.
    const outcome = await cleanupLosingUploadAttempt(env as Env, {
      tenantId: TENANT, uploadId: reserved.uploadId,
      attemptToken: row!.adopted_attempt_token!, mode: 'ambiguous',
    })
    expect(outcome).toBe('kept_adopted')
    expect(await env.R2_ARTIFACTS.head(row!.r2_key)).not.toBeNull()
  })

  it('never deletes while cleanup races an undecided adoption', async () => {
    const { reserved } = await reserveOperation('ambiguous-open', `ambiguous-open-${SUITE_ID}`)
    const attemptToken = crypto.randomUUID()
    // The operation is still reserved and undecided; an ambiguous adoption
    // outcome must keep the object and journal row for the sweeper.
    const outcome = await cleanupLosingUploadAttempt(env as Env, {
      tenantId: TENANT, uploadId: reserved.uploadId, attemptToken, mode: 'ambiguous',
    })
    expect(outcome).toBe('kept_indeterminate')
  })

  it('never deletes an attempt that could still be writing', async () => {
    const { bytes, reserved } = await reserveOperation('live-attempt', `live-${SUITE_ID}`)
    // The journal row is old enough to be eligible, but D1 still shows the
    // same token as the live upload attempt with an unexpired lease.
    const live = await crashAttempt(reserved.uploadId, bytes, Date.now() - 1)
    const sweepNow = Date.now() + ARTIFACT_UPLOAD_ATTEMPT_ORPHAN_GRACE_MS + 1
    await env.D1_US.prepare(
      `UPDATE artifact_intake_operations
       SET upload_attempt_token = ?, upload_attempt_expires_at = ?
       WHERE tenant_id = ? AND upload_id = ?`,
    ).bind(live.attemptToken, sweepNow + 60_000, TENANT, reserved.uploadId).run()
    const sweep = await sweepAbandonedArtifactUploadAttempts(env as Env, sweepNow, 100)
    expect(sweep.keptLive).toBe(1)
    expect(sweep.deleted).toBe(0)
    expect(await env.R2_ARTIFACTS.head(live.key)).not.toBeNull()
    expect(await journalCount(reserved.uploadId)).toBe(1)
  })

  it('always preserves the adopted attempt object and retires only its journal row', async () => {
    const { bytes, reserved } = await reserveOperation('adopted-preserved', `adopted-${SUITE_ID}`)
    await upload(reserved.uploadId, bytes)
    const row = await getArtifactIntakeOperation(env, TENANT, reserved.uploadId)
    // Reinstate a journal row for the adopted attempt as if the clear after
    // adoption had crashed; the sweeper must never touch the adopted object.
    await recordUploadAttemptIntent(env as Env, {
      tenantId: TENANT, uploadId: reserved.uploadId,
      attemptToken: row!.adopted_attempt_token!, leaseExpiresAt: 1, now: 1,
    })
    const sweep = await sweepAbandonedArtifactUploadAttempts(
      env as Env, Date.now() + ARTIFACT_UPLOAD_ATTEMPT_ORPHAN_GRACE_MS + 1, 100,
    )
    expect(sweep.keptAdopted).toBe(1)
    expect(await env.R2_ARTIFACTS.head(row!.r2_key)).not.toBeNull()
    expect(await journalCount(reserved.uploadId)).toBe(0)
  })

  it('records failure only for the exact live attempt owner and reports lost ownership otherwise', async () => {
    const { reserved } = await reserveOperation('fenced-failure', `failure-${SUITE_ID}`)
    const row = await getArtifactIntakeOperation(env, TENANT, reserved.uploadId)
    const owner = crypto.randomUUID()
    const now = Date.now()
    await env.D1_US.prepare(
      `UPDATE artifact_intake_operations
       SET upload_attempt_token = ?, upload_attempt_expires_at = ?
       WHERE tenant_id = ? AND upload_id = ?`,
    ).bind(owner, now + 60_000, TENANT, reserved.uploadId).run()
    // Wrong token, expired lease, and expired operation all lose ownership.
    expect(await markUploadFailed(env, row!, crypto.randomUUID(), 'hash_mismatch')).toBe('ownership_lost')
    await env.D1_US.prepare(
      `UPDATE artifact_intake_operations SET upload_attempt_expires_at = 1
       WHERE tenant_id = ? AND upload_id = ?`,
    ).bind(TENANT, reserved.uploadId).run()
    expect(await markUploadFailed(env, row!, owner, 'hash_mismatch')).toBe('ownership_lost')
    await env.D1_US.prepare(
      `UPDATE artifact_intake_operations SET upload_attempt_expires_at = ?, expires_at = 1
       WHERE tenant_id = ? AND upload_id = ?`,
    ).bind(now + 60_000, TENANT, reserved.uploadId).run()
    expect(await markUploadFailed(env, row!, owner, 'hash_mismatch')).toBe('ownership_lost')
    const unchanged = await getArtifactIntakeOperation(env, TENANT, reserved.uploadId)
    expect(unchanged).toMatchObject({ status: 'reserved', error_code: null })
    // Restore a live lease and unexpired operation: the exact owner succeeds
    // with exactly one changed row.
    await env.D1_US.prepare(
      `UPDATE artifact_intake_operations SET expires_at = ?
       WHERE tenant_id = ? AND upload_id = ?`,
    ).bind(now + 60_000, TENANT, reserved.uploadId).run()
    expect(await markUploadFailed(env, row!, owner, 'hash_mismatch')).toBe('failed_recorded')
    expect(await getArtifactIntakeOperation(env, TENANT, reserved.uploadId)).toMatchObject({
      status: 'failed', error_code: 'hash_mismatch',
      upload_attempt_token: null, upload_attempt_expires_at: null,
    })
  })

  it('keeps the attempt journal content-free', async () => {
    const { bytes, reserved } = await reserveOperation('journal-privacy', `privacy-${SUITE_ID}`)
    await crashAttempt(reserved.uploadId, bytes, Date.now() - 1)
    const row = await env.D1_US.prepare(
      `SELECT * FROM artifact_upload_attempts WHERE tenant_id = ? AND upload_id = ?`,
    ).bind(TENANT, reserved.uploadId).first<Record<string, unknown>>()
    const serialized = JSON.stringify(row)
    expect(serialized).not.toMatch(/https?:|file:|[A-Za-z]:\\|\.jpe?g|\.png|\.pdf|caption|body|secret/i)
  })
})
