import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { finalizeArtifactCapture } from '../src/services/artifact-intake/finalize'
import {
  getArtifactIntakeOperation,
  getArtifactIntakeStatus,
  reserveArtifactUpload,
  uploadArtifactBytes,
} from '../src/services/artifact-intake/operations'
import { reapExpiredArtifactUploads } from '../src/services/artifact-intake/reaper'
import { sha256Bytes, unsealArtifactBytes } from '../src/services/artifact-intake/crypto'
import { getCanonicalDocument } from '../src/services/canonical-memory-query'
import {
  getCanonicalMemoryStore,
  installCanonicalMemoryStore,
} from '../src/services/canonical-postgres'
import type { CanonicalMemoryStore } from '../src/services/canonical-postgres-repository'
import type { FinalizeArtifactCaptureInput } from '../src/types/artifact-intake'

const SUITE_ID = crypto.randomUUID()
const TENANT_A = `test-tenant-artifact-123-a-${SUITE_ID}`
const TENANT_B = `test-tenant-artifact-123-b-${SUITE_ID}`

async function ensureTenant(tenantId: string): Promise<void> {
  const now = Date.now()
  await env.D1_US.prepare(
    `INSERT OR IGNORE INTO tenants
     (id, created_at, updated_at, data_region, primary_channel, hindsight_tenant_id, ai_cost_reset_at)
     VALUES (?, ?, ?, 'us', 'sms', ?, ?)`,
  ).bind(tenantId, now, now, `hindsight-${tenantId}`, now).run()
}

async function testKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode('session-two-artifact-test-key!!!'),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  )
}

async function reserveAndUpload(args: {
  tenantId?: string
  idempotencyKey: string
  text: string
  mimeType?: string
  now?: number
}) {
  const tenantId = args.tenantId ?? TENANT_A
  const bytes = new TextEncoder().encode(args.text)
  const plaintextSha256 = await sha256Bytes(bytes)
  const reserved = await reserveArtifactUpload({
    tenantId,
    idempotencyKey: args.idempotencyKey,
    byteLength: bytes.byteLength,
    plaintextSha256,
    declaredMimeType: args.mimeType ?? 'text/plain',
    now: args.now,
  }, env)
  const sealed = await uploadArtifactBytes({
    tenantId,
    uploadId: reserved.uploadId,
    bytes,
    declaredMimeType: args.mimeType ?? 'text/plain',
    detectedMimeType: args.mimeType ?? 'text/plain',
    encryptionFamily: 'tmk',
    key: await testKey(),
  }, env)
  return { bytes, reserved, sealed, plaintextSha256 }
}

beforeAll(async () => { await Promise.all([ensureTenant(TENANT_A), ensureTenant(TENANT_B)]) })
beforeEach(() => { vi.restoreAllMocks() })

describe('12.3 managed artifact intake lifecycle', () => {
  it('recovers an R2 write failure and every retry reuses one upload and one ciphertext object', async () => {
    const bytes = new TextEncoder().encode('r2-write-failure-fixture')
    const hash = await sha256Bytes(bytes)
    const reserved = await reserveArtifactUpload({
      tenantId: TENANT_A,
      idempotencyKey: `r2-failure-${SUITE_ID}`,
      byteLength: bytes.byteLength,
      plaintextSha256: hash,
      declaredMimeType: 'text/plain',
    }, env)
    const reservedRetry = await reserveArtifactUpload({
      tenantId: TENANT_A,
      idempotencyKey: `r2-failure-${SUITE_ID}`,
      byteLength: bytes.byteLength,
      plaintextSha256: hash,
      declaredMimeType: 'text/plain',
    }, env)
    expect(reservedRetry.operationId).toBe(reserved.operationId)
    expect(reservedRetry.uploadId).toBe(reserved.uploadId)

    const put = vi.spyOn(env.R2_ARTIFACTS, 'put').mockRejectedValueOnce(new Error('injected R2 failure'))
    await expect(uploadArtifactBytes({
      tenantId: TENANT_A,
      uploadId: reserved.uploadId,
      bytes,
      declaredMimeType: 'text/plain',
      detectedMimeType: 'text/plain',
      encryptionFamily: 'tmk',
      key: await testKey(),
    }, env)).rejects.toMatchObject({ code: 'storage_write_failed' })
    expect((await getArtifactIntakeStatus({ tenantId: TENANT_A, uploadId: reserved.uploadId }, env)).status).toBe('failed')

    const sealed = await uploadArtifactBytes({
      tenantId: TENANT_A,
      uploadId: reserved.uploadId,
      bytes,
      declaredMimeType: 'text/plain',
      detectedMimeType: 'text/plain',
      encryptionFamily: 'tmk',
      key: await testKey(),
    }, env)
    const cipherHash = sealed.ciphertextSha256
    const sealedRetry = await uploadArtifactBytes({
      tenantId: TENANT_A,
      uploadId: reserved.uploadId,
      bytes,
      declaredMimeType: 'text/plain',
      detectedMimeType: 'text/plain',
      encryptionFamily: 'tmk',
      key: await testKey(),
    }, env)
    expect(sealedRetry.ciphertextSha256).toBe(cipherHash)
    expect(put).toHaveBeenCalledTimes(2)
    const row = await getArtifactIntakeOperation(env, TENANT_A, reserved.uploadId)
    const object = await env.R2_ARTIFACTS.get(row!.r2_key)
    const ciphertext = new Uint8Array(await object!.arrayBuffer())
    expect(new TextDecoder().decode(ciphertext)).not.toContain('r2-write-failure-fixture')
    expect(await unsealArtifactBytes(ciphertext, await testKey(), 'tmk')).toEqual(bytes)
  })

  it('round-trips one source and two derivatives, repairs a Neon failure, and makes finalize idempotent', async () => {
    const source = await reserveAndUpload({ idempotencyKey: `source-${SUITE_ID}`, text: 'source-raw-secret' })
    const firstDerivative = await reserveAndUpload({ idempotencyKey: `derivative-one-${SUITE_ID}`, text: 'derivative-one-secret' })
    const secondDerivative = await reserveAndUpload({ idempotencyKey: `derivative-two-${SUITE_ID}`, text: 'derivative-two-secret' })
    const extraction = 'searchable extraction must live only in canonical Neon content'
    const finalizeInput: FinalizeArtifactCaptureInput = {
      tenantId: TENANT_A,
      content: extraction,
      title: 'Managed artifact manifest',
      scope: 'research',
      provenance: 'session_2_failure_injection',
      clientName: 'Codex',
      sourceRef: `session-2-${SUITE_ID}`,
      idempotencyKey: `finalize-${SUITE_ID}`,
      declaredDerivativeUploadIds: [firstDerivative.sealed.uploadId, secondDerivative.sealed.uploadId],
      artifacts: [
        {
          uploadId: source.sealed.uploadId,
          role: 'source', primary: true, filename: 'private-source-name.txt', detectedMimeType: 'text/plain',
          byteLength: source.bytes.byteLength, plaintextSha256: source.plaintextSha256,
        },
        {
          uploadId: firstDerivative.sealed.uploadId,
          role: 'derivative', parentUploadId: source.sealed.uploadId, primary: false,
          filename: 'private-derivative-one.txt', detectedMimeType: 'text/plain',
          byteLength: firstDerivative.bytes.byteLength, plaintextSha256: firstDerivative.plaintextSha256,
        },
        {
          uploadId: secondDerivative.sealed.uploadId,
          role: 'derivative', parentUploadId: firstDerivative.sealed.uploadId, primary: false,
          filename: 'private-derivative-two.txt', detectedMimeType: 'text/plain',
          byteLength: secondDerivative.bytes.byteLength, plaintextSha256: secondDerivative.plaintextSha256,
        },
      ],
    }

    const originalStore = getCanonicalMemoryStore(env)
    let injected = false
    const failingStore = new Proxy(originalStore, {
      get(target, property) {
        if (property === 'writeCapture') {
          return async (...args: Parameters<CanonicalMemoryStore['writeCapture']>) => {
            if (!injected) {
              injected = true
              throw new Error('injected Neon transaction failure')
            }
            return target.writeCapture(...args)
          }
        }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    installCanonicalMemoryStore(env, failingStore)
    try {
      await expect(finalizeArtifactCapture(finalizeInput, await testKey(), env)).rejects.toMatchObject({
        code: 'canonical_write_failed',
      })
    } finally {
      installCanonicalMemoryStore(env, originalStore)
    }

    const receipt = await finalizeArtifactCapture(finalizeInput, await testKey(), env)
    const managedBeforeDuplicate = await env.R2_ARTIFACTS.list({ prefix: 'artifact-intake/v1/' })
    const duplicate = await finalizeArtifactCapture(finalizeInput, await testKey(), env)
    expect(duplicate).toEqual(receipt)
    expect((await env.R2_ARTIFACTS.list({ prefix: 'artifact-intake/v1/' })).objects.map((object: { key: string }) => object.key))
      .toEqual(managedBeforeDuplicate.objects.map((object: { key: string }) => object.key))
    expect(receipt.artifacts).toHaveLength(3)

    const stored = await originalStore.getDocument(TENANT_A, receipt.documentId)
    expect(stored?.artifact_id).toBe(receipt.primaryArtifactId)
    expect(stored?.artifact_manifest.map(artifact => ({
      role: artifact.role,
      parent: artifact.parent_artifact_id,
      primary: artifact.primary,
    }))).toEqual([
      { role: 'source', parent: null, primary: true },
      { role: 'derivative', parent: receipt.artifacts[0]!.artifactId, primary: false },
      { role: 'derivative', parent: receipt.artifacts[1]!.artifactId, primary: false },
    ])
    const document = await getCanonicalDocument(
      { tenantId: TENANT_A, documentId: receipt.documentId },
      env,
      TENANT_A,
      { tmk: await testKey() },
    )
    expect(document.body).toBe(extraction)
    expect(document.artifact?.artifactId).toBe(receipt.primaryArtifactId)
    expect(document.artifacts.map(artifact => artifact.parentArtifactId)).toEqual([
      null,
      receipt.artifacts[0]!.artifactId,
      receipt.artifacts[1]!.artifactId,
    ])

    const rows = await env.D1_US.prepare(
      `SELECT * FROM artifact_intake_operations WHERE tenant_id = ? AND canonical_capture_id = ?`,
    ).bind(TENANT_A, receipt.captureId).all<Record<string, unknown>>()
    expect(rows.results).toHaveLength(3)
    expect(rows.results.every((row: Record<string, unknown>) => row.status === 'finalized')).toBe(true)

    // Inject the other cross-store boundary: Neon committed, but D1 completion
    // state was lost. A duplicate finalize repairs D1 without another capture.
    await env.D1_US.batch([
      env.D1_US.prepare(
        `UPDATE artifact_intake_finalizations SET status = 'reserved' WHERE tenant_id = ? AND canonical_capture_id = ?`,
      ).bind(TENANT_A, receipt.captureId),
      env.D1_US.prepare(
        `UPDATE artifact_intake_operations SET status = 'sealed' WHERE tenant_id = ? AND canonical_capture_id = ?`,
      ).bind(TENANT_A, receipt.captureId),
    ])
    expect(await finalizeArtifactCapture(finalizeInput, await testKey(), env)).toEqual(receipt)
    const repaired = await env.D1_US.prepare(
      `SELECT status FROM artifact_intake_operations WHERE tenant_id = ? AND canonical_capture_id = ?`,
    ).bind(TENANT_A, receipt.captureId).all<{ status: string }>()
    expect(repaired.results.every((row: { status: string }) => row.status === 'finalized')).toBe(true)
  })

  it('reaps only the exact expired tenant-scoped orphan', async () => {
    const expired = await reserveAndUpload({
      idempotencyKey: `expired-${SUITE_ID}`,
      text: 'expired-orphan-secret',
    })
    const row = await getArtifactIntakeOperation(env, TENANT_A, expired.sealed.uploadId)
    await env.D1_US.prepare(
      `UPDATE artifact_intake_operations SET expires_at = 1 WHERE tenant_id = ? AND upload_id = ?`,
    ).bind(TENANT_A, expired.sealed.uploadId).run()
    expect(await env.R2_ARTIFACTS.head(row!.r2_key)).not.toBeNull()
    const result = await reapExpiredArtifactUploads(env, Date.now(), 100)
    expect(result.reaped).toBeGreaterThanOrEqual(1)
    expect(await env.R2_ARTIFACTS.head(row!.r2_key)).toBeNull()
    expect((await getArtifactIntakeStatus({ tenantId: TENANT_A, uploadId: expired.sealed.uploadId }, env)).status).toBe('expired')
  })

  it('reaps both managed ciphertext and the deterministic canonical-body orphan after a permanent canonical failure', async () => {
    const orphan = await reserveAndUpload({
      idempotencyKey: `canonical-orphan-${SUITE_ID}`,
      text: 'canonical-failure-orphan-secret',
    })
    const input: FinalizeArtifactCaptureInput = {
      tenantId: TENANT_A,
      content: 'canonical failure extraction',
      scope: 'research',
      clientName: 'Codex',
      idempotencyKey: `canonical-orphan-finalize-${SUITE_ID}`,
      artifacts: [{
        uploadId: orphan.sealed.uploadId,
        role: 'source', primary: true, detectedMimeType: 'text/plain',
        byteLength: orphan.bytes.byteLength, plaintextSha256: orphan.plaintextSha256,
      }],
    }
    const originalStore = getCanonicalMemoryStore(env)
    const failingStore = new Proxy(originalStore, {
      get(target, property) {
        if (property === 'writeCapture') return async () => { throw new Error('permanent canonical failure') }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    installCanonicalMemoryStore(env, failingStore)
    try {
      await expect(finalizeArtifactCapture(input, await testKey(), env)).rejects.toMatchObject({ code: 'canonical_write_failed' })
    } finally {
      installCanonicalMemoryStore(env, originalStore)
    }

    const operation = await getArtifactIntakeOperation(env, TENANT_A, orphan.sealed.uploadId)
    const canonicalBodyKey = `canonical/${TENANT_A}/documents/${operation!.canonical_document_id}.enc`
    expect(await env.R2_ARTIFACTS.head(operation!.r2_key)).not.toBeNull()
    expect(await env.R2_ARTIFACTS.head(canonicalBodyKey)).not.toBeNull()
    await env.D1_US.prepare(
      `UPDATE artifact_intake_operations SET expires_at = 1 WHERE tenant_id = ? AND upload_id = ?`,
    ).bind(TENANT_A, orphan.sealed.uploadId).run()
    const reaped = await reapExpiredArtifactUploads(env, Date.now(), 100)
    expect(reaped.reaped).toBeGreaterThanOrEqual(1)
    expect(await env.R2_ARTIFACTS.head(operation!.r2_key)).toBeNull()
    expect(await env.R2_ARTIFACTS.head(canonicalBodyKey)).toBeNull()
  })
})
