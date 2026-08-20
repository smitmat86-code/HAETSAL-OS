import { afterEach, describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'
import {
  reserveArtifactUpload,
  uploadArtifactBytes,
} from '../src/services/artifact-intake/operations'
import { sha256Bytes } from '../src/services/artifact-intake/crypto'
import type { Env } from '../src/types/env'

const SUITE_ID = crypto.randomUUID()
const TENANT = `test-tenant-admission-${SUITE_ID}`

async function ensureTenant(): Promise<void> {
  const now = Date.now()
  await env.D1_US.prepare(
    `INSERT OR IGNORE INTO tenants
     (id, created_at, updated_at, data_region, primary_channel, hindsight_tenant_id, ai_cost_reset_at)
     VALUES (?, ?, ?, 'us', 'sms', ?, ?)`,
  ).bind(TENANT, now, now, `hindsight-${TENANT}`, now).run()
}

async function setGate(state: 'open' | 'closed'): Promise<void> {
  await env.D1_US.prepare(
    `INSERT INTO artifact_intake_admission (id, state, updated_at) VALUES (1, ?, ?)
     ON CONFLICT (id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
  ).bind(state, Date.now()).run()
}

async function clearGate(): Promise<void> {
  await env.D1_US.prepare(`DELETE FROM artifact_intake_admission WHERE id = 1`).run()
}

async function testKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw', new TextEncoder().encode('session-two-artifact-test-key!!!'),
    { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'],
  )
}

async function reserve(text: string, idempotencyKey: string, target: Env = env as Env) {
  await ensureTenant()
  const bytes = new TextEncoder().encode(text)
  return {
    bytes,
    reserved: await reserveArtifactUpload({
      tenantId: TENANT, idempotencyKey, byteLength: bytes.byteLength,
      plaintextSha256: await sha256Bytes(bytes), declaredMimeType: 'text/plain',
    }, target),
  }
}

describe('12.23 operator upload admission gate', () => {
  afterEach(clearGate)

  it('refuses every reserve and upload mutation while the gate is closed, then admits after reopening', async () => {
    const { bytes, reserved } = await reserve('gate-secret', `gate-${SUITE_ID}`)
    await setGate('closed')
    await expect(reserve('gate-secret-2', `gate2-${SUITE_ID}`))
      .rejects.toMatchObject({ code: 'upload_admission_closed' })
    await expect(uploadArtifactBytes({
      tenantId: TENANT, uploadId: reserved.uploadId, bytes,
      detectedMimeType: 'text/plain', declaredMimeType: 'text/plain',
      encryptionFamily: 'tmk', key: await testKey(),
    }, env as Env)).rejects.toMatchObject({ code: 'upload_admission_closed' })
    await setGate('open')
    const receipt = await uploadArtifactBytes({
      tenantId: TENANT, uploadId: reserved.uploadId, bytes,
      detectedMimeType: 'text/plain', declaredMimeType: 'text/plain',
      encryptionFamily: 'tmk', key: await testKey(),
    }, env as Env)
    expect(receipt.status).toBe('sealed')
  })

  it('fails closed when the gate cannot be read', async () => {
    await ensureTenant()
    const failingEnv = new Proxy(env as Env, {
      get: (inner, property) => {
        if (property !== 'D1_US') return Reflect.get(inner, property)
        return new Proxy(inner.D1_US, {
          get: (d1, d1Property) => {
            if (d1Property !== 'prepare') return Reflect.get(d1, d1Property)
            return (sql: string) => {
              if (sql.includes('artifact_intake_admission')) throw new Error('d1 unavailable')
              return inner.D1_US.prepare(sql)
            }
          },
        })
      },
    })
    await expect(reserve('fail-closed-secret', `fail-closed-${SUITE_ID}`, failingEnv))
      .rejects.toMatchObject({ code: 'upload_admission_closed' })
  })

  it('treats an absent gate row as open', async () => {
    await clearGate()
    const { reserved } = await reserve('absent-gate-secret', `absent-${SUITE_ID}`)
    expect(reserved.status).toBe('reserved')
  })
})
