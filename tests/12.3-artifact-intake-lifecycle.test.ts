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
import { ARTIFACT_FINALIZATION_RECOVERY_MS } from '../src/services/artifact-intake/config'
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
          role: 'source', primary: true, filename: 'private-source-name.txt',
          detectedMimeType: 'text/plain; charset=utf-8',
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

    // A process can also die after canonical commit and remain absent beyond the
    // recovery window. The artifact reaper must prove and repair that success,
    // never delete the raw sources or leave the reservation stuck forever.
    await env.D1_US.batch([
      env.D1_US.prepare(
        `UPDATE artifact_intake_finalizations
         SET status = 'reserved', recovery_expires_at = 1, lease_owner = NULL, lease_expires_at = 1
         WHERE tenant_id = ? AND canonical_capture_id = ?`,
      ).bind(TENANT_A, receipt.captureId),
      env.D1_US.prepare(
        `UPDATE artifact_intake_operations
         SET status = 'sealed', expires_at = 1, finalization_protected_until = 1
         WHERE tenant_id = ? AND canonical_capture_id = ?`,
      ).bind(TENANT_A, receipt.captureId),
    ])
    const staleRepair = await reapExpiredArtifactUploads(env, Date.now(), 100)
    expect(staleRepair.repairedFinalized).toBeGreaterThanOrEqual(1)
    expect(staleRepair.reaped).toBe(0)
    expect(await env.D1_US.prepare(
      `SELECT status FROM artifact_intake_finalizations
       WHERE tenant_id = ? AND canonical_capture_id = ?`,
    ).bind(TENANT_A, receipt.captureId).first<{ status: string }>()).toMatchObject({ status: 'finalized' })
    for (const row of rows.results) {
      expect(await env.R2_ARTIFACTS.head(String(row.r2_key))).not.toBeNull()
    }

    // Capture presence alone is not proof. If one raw source disappears, the
    // same stale boundary fails/releases the reservation and cleans every
    // remaining managed object instead of protecting it forever.
    await env.R2_ARTIFACTS.delete(String(rows.results[0]!.r2_key))
    await env.D1_US.batch([
      env.D1_US.prepare(
        `UPDATE artifact_intake_finalizations
         SET status = 'reserved', recovery_expires_at = 1, lease_owner = NULL, lease_expires_at = 1
         WHERE tenant_id = ? AND canonical_capture_id = ?`,
      ).bind(TENANT_A, receipt.captureId),
      env.D1_US.prepare(
        `UPDATE artifact_intake_operations
         SET status = 'sealed', expires_at = 1, finalization_protected_until = 1
         WHERE tenant_id = ? AND canonical_capture_id = ?`,
      ).bind(TENANT_A, receipt.captureId),
    ])
    const failedProof = await reapExpiredArtifactUploads(env, Date.now(), 100)
    expect(failedProof.reaped).toBeGreaterThanOrEqual(3)
    expect(await env.D1_US.prepare(
      `SELECT status FROM artifact_intake_finalizations
       WHERE tenant_id = ? AND canonical_capture_id = ?`,
    ).bind(TENANT_A, receipt.captureId).first<{ status: string }>()).toMatchObject({ status: 'failed' })
    for (const row of rows.results) {
      expect(await env.R2_ARTIFACTS.head(String(row.r2_key))).toBeNull()
    }
  })

  it.each(['role', 'parent', 'media'] as const)(
    'fails and cleans a stale canonical reservation with mismatched manifest %s identity',
    async (tamper) => {
      const upload = await reserveAndUpload({
        idempotencyKey: `stale-manifest-${tamper}-${SUITE_ID}`,
        text: `stale-manifest-${tamper}`,
      })
      const receipt = await finalizeArtifactCapture({
        tenantId: TENANT_A, content: `stale manifest ${tamper}`, scope: 'research', clientName: 'Codex',
        idempotencyKey: `stale-manifest-finalize-${tamper}-${SUITE_ID}`,
        artifacts: [{
          uploadId: upload.sealed.uploadId, role: 'source', primary: true,
          detectedMimeType: 'text/plain', byteLength: upload.bytes.byteLength,
          plaintextSha256: upload.plaintextSha256,
        }],
      }, await testKey(), env)
      const operation = await getArtifactIntakeOperation(env, TENANT_A, upload.sealed.uploadId)
      await env.D1_US.batch([
        env.D1_US.prepare(
          `UPDATE artifact_intake_finalizations
           SET status = 'reserved', recovery_expires_at = 1, lease_owner = NULL, lease_expires_at = 1
           WHERE tenant_id = ? AND canonical_capture_id = ?`,
        ).bind(TENANT_A, receipt.captureId),
        env.D1_US.prepare(
          `UPDATE artifact_intake_operations SET status = 'sealed', expires_at = 1
           WHERE tenant_id = ? AND upload_id = ?`,
        ).bind(TENANT_A, upload.sealed.uploadId),
      ])
      const originalStore = getCanonicalMemoryStore(env)
      const tamperedStore = new Proxy(originalStore, {
        get(target, property) {
          if (property === 'getDocument') return async (...args: [string, string]) => {
            const document = await target.getDocument(...args)
            if (!document || args[1] !== receipt.documentId) return document
            const artifact = { ...document.artifact_manifest[0]! }
            if (tamper === 'role') artifact.role = 'derivative'
            if (tamper === 'parent') artifact.parent_artifact_id = artifact.artifact_id
            if (tamper === 'media') artifact.media_type = 'application/pdf'
            return { ...document, artifact_manifest: [artifact] }
          }
          const value = Reflect.get(target, property)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
      installCanonicalMemoryStore(env, tamperedStore)
      try {
        await reapExpiredArtifactUploads(env, Date.now(), 100)
      } finally {
        installCanonicalMemoryStore(env, originalStore)
      }
      expect(await env.D1_US.prepare(
        `SELECT status FROM artifact_intake_finalizations
         WHERE tenant_id = ? AND canonical_capture_id = ?`,
      ).bind(TENANT_A, receipt.captureId).first<{ status: string }>()).toMatchObject({ status: 'failed' })
      expect(await env.R2_ARTIFACTS.head(operation!.r2_key)).toBeNull()
    },
  )

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
    const finalization = await env.D1_US.prepare(
      `SELECT id, recovery_expires_at FROM artifact_intake_finalizations
       WHERE tenant_id = ? AND canonical_capture_id = ?`,
    ).bind(TENANT_A, operation!.canonical_capture_id)
      .first<{ id: string; recovery_expires_at: number | null }>()
    expect(finalization?.recovery_expires_at).toBeGreaterThan(Date.now())
    expect((await reapExpiredArtifactUploads(env, Date.now(), 100)).reaped).toBe(0)
    expect(await env.R2_ARTIFACTS.head(operation!.r2_key)).not.toBeNull()

    const staleBoundary = Number(finalization!.recovery_expires_at ??
      (Date.now() + ARTIFACT_FINALIZATION_RECOVERY_MS)) + 1
    const reaped = await reapExpiredArtifactUploads(env, staleBoundary, 100)
    expect(reaped.reaped).toBeGreaterThanOrEqual(1)
    expect(await env.D1_US.prepare(
      `SELECT status FROM artifact_intake_finalizations WHERE tenant_id = ? AND id = ?`,
    ).bind(TENANT_A, finalization!.id).first<{ status: string }>()).toMatchObject({ status: 'failed' })
    expect(await env.R2_ARTIFACTS.head(operation!.r2_key)).toBeNull()
    expect(await env.R2_ARTIFACTS.head(canonicalBodyKey)).toBeNull()
  })

  it('gives expiry ownership the race and aborts finalization before canonical write', async () => {
    const expired = await reserveAndUpload({
      idempotencyKey: `expiry-wins-${SUITE_ID}`,
      text: 'expiry-wins-secret',
    })
    const row = await getArtifactIntakeOperation(env, TENANT_A, expired.sealed.uploadId)
    const store = getCanonicalMemoryStore(env)
    const before = await store.getStats(TENANT_A)
    await env.D1_US.prepare(
      `UPDATE artifact_intake_operations SET expires_at = 1 WHERE tenant_id = ? AND upload_id = ?`,
    ).bind(TENANT_A, expired.sealed.uploadId).run()
    expect((await reapExpiredArtifactUploads(env, Date.now(), 100)).reaped).toBeGreaterThanOrEqual(1)
    expect(await env.R2_ARTIFACTS.head(row!.r2_key)).toBeNull()

    await expect(finalizeArtifactCapture({
      tenantId: TENANT_A, content: 'must not be captured', scope: 'research', clientName: 'Codex',
      idempotencyKey: `expiry-wins-finalize-${SUITE_ID}`,
      artifacts: [{
        uploadId: expired.sealed.uploadId, role: 'source', primary: true,
        detectedMimeType: 'text/plain', byteLength: expired.bytes.byteLength,
        plaintextSha256: expired.plaintextSha256,
      }],
    }, await testKey(), env)).rejects.toMatchObject({ code: 'invalid_state' })
    expect(await store.getStats(TENANT_A)).toMatchObject({
      captureCount: before.captureCount, documentCount: before.documentCount,
    })
  })

  it('protects a finalization-owned object while the reaper races canonical write', async () => {
    const protectedUpload = await reserveAndUpload({
      idempotencyKey: `finalization-wins-${SUITE_ID}`,
      text: 'finalization-wins-secret',
    })
    const row = await getArtifactIntakeOperation(env, TENANT_A, protectedUpload.sealed.uploadId)
    let reached!: () => void
    let release!: () => void
    const protectedReached = new Promise<void>(resolve => { reached = resolve })
    const releaseCanonical = new Promise<void>(resolve => { release = resolve })
    const finalizing = finalizeArtifactCapture({
      tenantId: TENANT_A, content: 'protected canonical extraction', scope: 'research', clientName: 'Codex',
      idempotencyKey: `finalization-wins-finalize-${SUITE_ID}`,
      artifacts: [{
        uploadId: protectedUpload.sealed.uploadId, role: 'source', primary: true,
        detectedMimeType: 'text/plain', byteLength: protectedUpload.bytes.byteLength,
        plaintextSha256: protectedUpload.plaintextSha256,
      }],
    }, await testKey(), env, {
      afterOperationsProtected: async () => {
        reached()
        await releaseCanonical
      },
    })
    await protectedReached
    await env.D1_US.prepare(
      `UPDATE artifact_intake_operations SET expires_at = 1 WHERE tenant_id = ? AND upload_id = ?`,
    ).bind(TENANT_A, protectedUpload.sealed.uploadId).run()
    expect((await reapExpiredArtifactUploads(
      env, Date.now() + Math.floor(ARTIFACT_FINALIZATION_RECOVERY_MS / 2), 100,
    )).reaped).toBe(0)
    expect(await env.R2_ARTIFACTS.head(row!.r2_key)).not.toBeNull()
    release()
    const receipt = await finalizing
    expect(receipt.status).toBe('finalized')
    expect(await env.R2_ARTIFACTS.head(row!.r2_key)).not.toBeNull()
  })

  it('makes a multi-artifact eligibility failure all-or-none with no canonical write', async () => {
    const source = await reserveAndUpload({ idempotencyKey: `cas-source-${SUITE_ID}`, text: 'cas-source' })
    const derivative = await reserveAndUpload({ idempotencyKey: `cas-derivative-${SUITE_ID}`, text: 'cas-derivative' })
    await env.D1_US.prepare(
      `UPDATE artifact_intake_operations
       SET expiry_claim_token = 'reaper-race-winner', expiry_claim_expires_at = ?
       WHERE tenant_id = ? AND upload_id = ?`,
    ).bind(Date.now() + 60_000, TENANT_A, derivative.sealed.uploadId).run()
    const store = getCanonicalMemoryStore(env)
    const before = await store.getStats(TENANT_A)
    await expect(finalizeArtifactCapture({
      tenantId: TENANT_A, content: 'must not partially capture', scope: 'research', clientName: 'Codex',
      idempotencyKey: `cas-finalize-${SUITE_ID}`,
      declaredDerivativeUploadIds: [derivative.sealed.uploadId],
      artifacts: [
        {
          uploadId: source.sealed.uploadId, role: 'source', primary: true,
          detectedMimeType: 'text/plain', byteLength: source.bytes.byteLength,
          plaintextSha256: source.plaintextSha256,
        },
        {
          uploadId: derivative.sealed.uploadId, role: 'derivative', primary: false,
          parentUploadId: source.sealed.uploadId, detectedMimeType: 'text/plain',
          byteLength: derivative.bytes.byteLength, plaintextSha256: derivative.plaintextSha256,
        },
      ],
    }, await testKey(), env)).rejects.toMatchObject({ code: 'invalid_state' })
    const rows = await env.D1_US.prepare(
      `SELECT finalization_id, canonical_capture_id FROM artifact_intake_operations
       WHERE tenant_id = ? AND upload_id IN (?, ?) ORDER BY upload_id`,
    ).bind(TENANT_A, source.sealed.uploadId, derivative.sealed.uploadId).all<{
      finalization_id: string | null; canonical_capture_id: string | null
    }>()
    expect(rows.results).toHaveLength(2)
    expect(rows.results.every(item => item.finalization_id === null && item.canonical_capture_id === null)).toBe(true)
    expect(await store.getStats(TENANT_A)).toMatchObject({
      captureCount: before.captureCount, documentCount: before.documentCount,
    })
  })
})
