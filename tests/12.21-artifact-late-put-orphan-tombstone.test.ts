import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'
import {
  recordUploadAttemptIntent,
} from '../src/services/artifact-intake/attempt-orphans'
import { sweepAbandonedArtifactUploadAttempts } from '../src/services/artifact-intake/attempt-sweep'
import {
  getArtifactIntakeOperation,
  reserveArtifactUpload,
  uploadArtifactBytes,
} from '../src/services/artifact-intake/operations'
import { sealArtifactBytes, sha256Bytes } from '../src/services/artifact-intake/crypto'
import { managedArtifactAttemptR2Key } from '../src/services/artifact-intake/storage-keys'
import { ARTIFACT_UPLOAD_ATTEMPT_ORPHAN_GRACE_MS } from '../src/services/artifact-intake/config'
import type { Env } from '../src/types/env'

const SUITE_ID = crypto.randomUUID()
const TENANT = `test-tenant-late-put-${SUITE_ID}`

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

/** Journals an attempt intent whose R2 put has NOT happened yet. */
async function journalOnly(uploadId: string, leaseExpiresAt: number) {
  const attemptToken = crypto.randomUUID()
  await recordUploadAttemptIntent(env as Env, {
    tenantId: TENANT, uploadId, attemptToken, leaseExpiresAt, now: Date.now(),
  })
  return {
    attemptToken,
    key: await managedArtifactAttemptR2Key(TENANT, uploadId, attemptToken),
  }
}

/** The journalled attempt's R2 put finally lands, arbitrarily late. */
async function latePut(key: string, bytes: Uint8Array) {
  const sealed = await sealArtifactBytes(bytes, await testKey(), 'tmk')
  await env.R2_ARTIFACTS.put(key, sealed.envelope)
}

async function journalCount(uploadId: string): Promise<number> {
  const row = await env.D1_US.prepare(
    `SELECT COUNT(*) AS count FROM artifact_upload_attempts WHERE tenant_id = ? AND upload_id = ?`,
  ).bind(TENANT, uploadId).first<{ count: number }>()
  return Number(row?.count ?? 0)
}

const wellPastGrace = () => Date.now() + ARTIFACT_UPLOAD_ATTEMPT_ORPHAN_GRACE_MS * 4

describe('12.21 late R2 puts can never become permanently untracked', () => {
  it('fences an expired attempt before deletion so a delayed adoption cannot commit afterward', async () => {
    const { bytes, reserved } = await reserveOperation('delayed-adoption', `delayed-adopt-${SUITE_ID}`)
    const attempt = await journalOnly(reserved.uploadId, 2)
    await latePut(attempt.key, bytes)
    await env.D1_US.prepare(
      `UPDATE artifact_intake_operations
       SET upload_attempt_token = ?, upload_attempt_expires_at = ?
       WHERE tenant_id = ? AND upload_id = ?`,
    ).bind(attempt.attemptToken, 2, TENANT, reserved.uploadId).run()

    // This statement represents an adoption request issued while the lease
    // was live but delayed inside D1 until after cleanup. Its bound timestamp
    // remains old, so only clearing the ownership token can make it lose.
    const delayedAdoption = env.D1_US.prepare(
      `UPDATE artifact_intake_operations
       SET status = 'sealed', ciphertext_sha256 = ?, ciphertext_byte_length = ?,
           encryption_family = 'tmk', r2_key = ?, adopted_attempt_token = ?,
           upload_attempt_token = NULL, upload_attempt_expires_at = NULL
       WHERE tenant_id = ? AND upload_id = ? AND status IN ('reserved', 'failed')
         AND upload_attempt_token = ? AND upload_attempt_expires_at > ?`,
    ).bind(
      'a'.repeat(64), bytes.byteLength + 33, attempt.key, attempt.attemptToken,
      TENANT, reserved.uploadId, attempt.attemptToken, 1,
    )

    const swept = await sweepAbandonedArtifactUploadAttempts(env as Env, wellPastGrace(), 100)
    expect(swept.deleted).toBe(1)
    const adoption = await delayedAdoption.run()
    expect(Number(adoption.meta.changes ?? 0)).toBe(0)
    const row = await getArtifactIntakeOperation(env, TENANT, reserved.uploadId)
    expect(row?.status).toBe('reserved')
    expect(row?.upload_attempt_token).toBeNull()
    expect(await env.R2_ARTIFACTS.head(attempt.key)).toBeNull()
  })

  it('keeps the journal pointer through an absent-object sweep and deletes the late put on a later sweep', async () => {
    const { bytes, reserved } = await reserveOperation('late-put-after-sweep', `late-${SUITE_ID}`)
    const attempt = await journalOnly(reserved.uploadId, Date.now() - 1)
    // Sweep 1: eligible, but no object has landed yet. Absence during one
    // check is NOT proof the put is dead — the durable pointer must survive.
    const first = await sweepAbandonedArtifactUploadAttempts(env as Env, wellPastGrace(), 100)
    expect(first.deleted).toBe(0)
    expect(await journalCount(reserved.uploadId)).toBe(1)
    // The pending R2 put lands only now, arbitrarily later, and the process
    // dies before any immediate cleanup.
    await latePut(attempt.key, bytes)
    expect(await env.R2_ARTIFACTS.head(attempt.key)).not.toBeNull()
    // A later sweep must still find the object via the retained pointer.
    const second = await sweepAbandonedArtifactUploadAttempts(env as Env, wellPastGrace(), 100)
    expect(second.deleted).toBe(1)
    expect(await env.R2_ARTIFACTS.head(attempt.key)).toBeNull()
  })

  it('retires the tombstone only after a confirmed observed-and-deleted object', async () => {
    const { bytes, reserved } = await reserveOperation('tombstone-retire', `retire-${SUITE_ID}`)
    const attempt = await journalOnly(reserved.uploadId, Date.now() - 1)
    await latePut(attempt.key, bytes)
    // Process death immediately after the late put: the very next sweep
    // observes and deletes the object.
    const observed = await sweepAbandonedArtifactUploadAttempts(env as Env, wellPastGrace(), 100)
    expect(observed.deleted).toBe(1)
    expect(await env.R2_ARTIFACTS.head(attempt.key)).toBeNull()
    // Repeated sweeps stay idempotent and eventually retire the record; the
    // record must never outlive confirmation as the only cleanup requirement.
    await sweepAbandonedArtifactUploadAttempts(env as Env, wellPastGrace(), 100)
    expect(await journalCount(reserved.uploadId)).toBe(0)
    const idle = await sweepAbandonedArtifactUploadAttempts(env as Env, wellPastGrace(), 100)
    expect(idle.deleted).toBe(0)
  })

  it('never deletes the adopted attempt object regardless of journal state', async () => {
    const { bytes, reserved } = await reserveOperation('adopted-safe', `adopted-${SUITE_ID}`)
    await uploadArtifactBytes({
      tenantId: TENANT, uploadId: reserved.uploadId, bytes,
      detectedMimeType: 'text/plain', declaredMimeType: 'text/plain',
      encryptionFamily: 'tmk', key: await testKey(),
    }, env as Env)
    const row = await getArtifactIntakeOperation(env, TENANT, reserved.uploadId)
    expect(row?.adopted_attempt_token).toBeTruthy()
    await recordUploadAttemptIntent(env as Env, {
      tenantId: TENANT, uploadId: reserved.uploadId,
      attemptToken: row!.adopted_attempt_token!, leaseExpiresAt: 1, now: 1,
    })
    for (let pass = 0; pass < 3; pass += 1) {
      await sweepAbandonedArtifactUploadAttempts(env as Env, wellPastGrace(), 100)
      expect(await env.R2_ARTIFACTS.head(row!.r2_key)).not.toBeNull()
    }
    expect(await journalCount(reserved.uploadId)).toBe(0)
  })

  it('retains cleanup state when D1 ownership reads are ambiguous', async () => {
    const { reserved } = await reserveOperation('ambiguous-d1', `ambiguous-${SUITE_ID}`)
    const attempt = await journalOnly(reserved.uploadId, Date.now() - 1)
    const failingEnv = new Proxy(env as Env, {
      get: (inner, property) => {
        if (property !== 'D1_US') return Reflect.get(inner, property)
        return new Proxy(inner.D1_US, {
          get: (d1, d1Property) => {
            if (d1Property !== 'prepare') return Reflect.get(d1, d1Property)
            return (sql: string) => {
              if (sql.includes('FROM artifact_intake_operations')) {
                throw new Error('d1 unavailable')
              }
              return inner.D1_US.prepare(sql)
            }
          },
        })
      },
    })
    const sweep = await sweepAbandonedArtifactUploadAttempts(failingEnv, wellPastGrace(), 100)
    expect(sweep.deleted).toBe(0)
    expect(sweep.indeterminate).toBeGreaterThanOrEqual(1)
    expect(await journalCount(reserved.uploadId)).toBe(1)
    void attempt
  })

  it('performs bounded work per invocation', async () => {
    const { reserved } = await reserveOperation('bounded-work', `bounded-${SUITE_ID}`)
    for (let index = 0; index < 5; index += 1) {
      await journalOnly(reserved.uploadId, Date.now() - 1)
    }
    const sweep = await sweepAbandonedArtifactUploadAttempts(env as Env, wellPastGrace(), 2)
    expect(sweep.inspected).toBeLessThanOrEqual(2)
  })

  it('keeps journal and tombstone records content-free', async () => {
    const { reserved } = await reserveOperation('tombstone-privacy', `privacy-${SUITE_ID}`)
    await journalOnly(reserved.uploadId, Date.now() - 1)
    await sweepAbandonedArtifactUploadAttempts(env as Env, wellPastGrace(), 100)
    const row = await env.D1_US.prepare(
      `SELECT * FROM artifact_upload_attempts WHERE tenant_id = ? AND upload_id = ?`,
    ).bind(TENANT, reserved.uploadId).first<Record<string, unknown>>()
    expect(row).toBeTruthy()
    const serialized = JSON.stringify(row)
    expect(serialized).not.toMatch(/https?:|file:|[A-Za-z]:\\|\.jpe?g|\.png|\.pdf|caption|body|secret/i)
  })
})
