import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { finalizeArtifactCapture } from '../src/services/artifact-intake/finalize'
import {
  acquireArtifactFinalizationLease,
  getArtifactIntakeOperation,
  getArtifactIntakeStatus,
  reserveArtifactUpload,
  uploadArtifactBytes,
} from '../src/services/artifact-intake/operations'
import { reapExpiredArtifactUploads } from '../src/services/artifact-intake/reaper'
import {
  ARTIFACT_FINALIZATION_LEASE_MS,
  ARTIFACT_FINALIZATION_RECOVERY_MS,
  ARTIFACT_MANIFEST_MAX_AGGREGATE_BYTES,
  ARTIFACT_MANIFEST_MAX_COUNT,
  ARTIFACT_MAX_BYTES,
} from '../src/services/artifact-intake/config'
import { sha256Bytes, unsealArtifactBytes } from '../src/services/artifact-intake/crypto'
import { getCanonicalDocument } from '../src/services/canonical-memory-query'
import {
  getCanonicalMemoryStore,
  installCanonicalMemoryStore,
} from '../src/services/canonical-postgres'
import type { CanonicalMemoryStore } from '../src/services/canonical-postgres-repository'
import type { FinalizeArtifactCaptureInput } from '../src/types/artifact-intake'
import { recoverOrFailStaleArtifactFinalizations } from '../src/services/artifact-intake/stale-finalization-recovery'
import { proveArtifactFinalizationCanonicalSuccess } from '../src/services/artifact-intake/finalization-proof'
import { artifactManifestIdentitySha256 } from '../src/services/artifact-intake/manifest-identity'
import {
  managedArtifactR2Key,
  proveManagedArtifactCiphertext,
} from '../src/services/artifact-intake/storage'
import { auditArtifactFinalizationMigrationOverlap } from '../src/services/artifact-intake/migration-overlap-audit'
import type { ArtifactFinalizationRow } from '../src/services/artifact-intake/finalize'
import type { Env } from '../src/types/env'

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

  it('reaps managed ciphertext but preserves the canonical document body after a permanent canonical failure', async () => {
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
    // The artifact operation's canonical pointer is not proof the body is
    // orphaned; the generic reaper must preserve canonical document bodies.
    expect(await env.R2_ARTIFACTS.head(canonicalBodyKey)).not.toBeNull()
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

  it('defers an R2 proof exception without mutation, then repairs on the next proof pass', async () => {
    const upload = await reserveAndUpload({
      idempotencyKey: `proof-throws-once-${SUITE_ID}`, text: 'proof-throws-once',
    })
    const receipt = await finalizeArtifactCapture({
      tenantId: TENANT_A, content: 'proof retry', scope: 'research', clientName: 'Codex',
      idempotencyKey: `proof-throws-once-finalize-${SUITE_ID}`,
      artifacts: [{
        uploadId: upload.sealed.uploadId, role: 'source', primary: true,
        detectedMimeType: 'text/plain', byteLength: upload.bytes.byteLength,
        plaintextSha256: upload.plaintextSha256,
      }],
    }, await testKey(), env)
    await env.D1_US.batch([
      env.D1_US.prepare(
        `UPDATE artifact_intake_finalizations
         SET status = 'reserved', recovery_expires_at = 1, lease_owner = NULL, lease_expires_at = NULL
         WHERE tenant_id = ? AND canonical_capture_id = ?`,
      ).bind(TENANT_A, receipt.captureId),
      env.D1_US.prepare(
        `UPDATE artifact_intake_operations
         SET status = 'sealed', expires_at = 1, finalization_protected_until = 1
         WHERE tenant_id = ? AND upload_id = ?`,
      ).bind(TENANT_A, upload.sealed.uploadId),
    ])
    const before = await env.D1_US.prepare(
      `SELECT f.status AS finalization_status, f.lease_owner, o.status AS operation_status,
              o.finalization_id, o.finalization_protected_until
       FROM artifact_intake_finalizations f JOIN artifact_intake_operations o
         ON o.finalization_id = f.id AND o.tenant_id = f.tenant_id
       WHERE f.tenant_id = ? AND f.canonical_capture_id = ?`,
    ).bind(TENANT_A, receipt.captureId).first<Record<string, unknown>>()
    const get = vi.spyOn(env.R2_ARTIFACTS, 'get').mockRejectedValueOnce(new Error('transient R2 outage'))
    const first = await reapExpiredArtifactUploads(env, Date.now(), 100)
    get.mockRestore()
    expect(first).toMatchObject({ failed: 0, reaped: 0 })
    expect(first.deferred).toBeGreaterThanOrEqual(1)
    expect(await env.D1_US.prepare(
      `SELECT f.status AS finalization_status, f.lease_owner, o.status AS operation_status,
              o.finalization_id, o.finalization_protected_until
       FROM artifact_intake_finalizations f JOIN artifact_intake_operations o
         ON o.finalization_id = f.id AND o.tenant_id = f.tenant_id
       WHERE f.tenant_id = ? AND f.canonical_capture_id = ?`,
    ).bind(TENANT_A, receipt.captureId).first<Record<string, unknown>>()).toEqual(before)
    expect((await reapExpiredArtifactUploads(env, Date.now(), 100)).repairedFinalized)
      .toBeGreaterThanOrEqual(1)
  })

  it.each(['neon', 'd1'] as const)(
    'keeps raw bytes and bindings protected when a %s proof query throws',
    async (failure) => {
      const upload = await reserveAndUpload({
        idempotencyKey: `proof-query-${failure}-${SUITE_ID}`, text: `proof-query-${failure}`,
      })
      const receipt = await finalizeArtifactCapture({
        tenantId: TENANT_A, content: `proof query ${failure}`, scope: 'research', clientName: 'Codex',
        idempotencyKey: `proof-query-finalize-${failure}-${SUITE_ID}`,
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
           SET status = 'reserved', recovery_expires_at = 1, lease_owner = NULL, lease_expires_at = NULL
           WHERE tenant_id = ? AND canonical_capture_id = ?`,
        ).bind(TENANT_A, receipt.captureId),
        env.D1_US.prepare(
          `UPDATE artifact_intake_operations
           SET status = 'sealed', expires_at = 1, finalization_protected_until = 1
           WHERE tenant_id = ? AND upload_id = ?`,
        ).bind(TENANT_A, upload.sealed.uploadId),
      ])
      const originalStore = getCanonicalMemoryStore(env)
      let proofEnv: Env = env
      if (failure === 'neon') {
        installCanonicalMemoryStore(env, new Proxy(originalStore, {
          get(target, property) {
            if (property === 'getCapture') return async () => { throw new Error('transient Neon outage') }
            const value = Reflect.get(target, property)
            return typeof value === 'function' ? value.bind(target) : value
          },
        }))
      } else {
        const originalD1 = env.D1_US
        const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement =>
          new Proxy(statement, {
            get(target, property) {
              if (property === 'bind') return (...values: unknown[]) => wrap(target.bind(...values), sql)
              if (property === 'all' && sql.includes('finalization_id = ? ORDER BY upload_id')) {
                return async () => { throw new Error('transient D1 outage') }
              }
              const value = Reflect.get(target, property)
              return typeof value === 'function' ? value.bind(target) : value
            },
          })
        const d1 = new Proxy(originalD1, {
          get(target, property) {
            if (property === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql)
            const value = Reflect.get(target, property)
            return typeof value === 'function' ? value.bind(target) : value
          },
        })
        proofEnv = { ...env, D1_US: d1 } as unknown as Env
      }
      try {
        const result = await reapExpiredArtifactUploads(proofEnv, Date.now(), 100)
        expect(result).toMatchObject({ failed: 0, reaped: 0 })
        expect(result.deferred).toBeGreaterThanOrEqual(1)
      } finally {
        installCanonicalMemoryStore(env, originalStore)
      }
      expect(await env.R2_ARTIFACTS.head(operation!.r2_key)).not.toBeNull()
      expect(await env.D1_US.prepare(
        `SELECT f.status AS finalization_status, o.status AS operation_status, o.finalization_id
         FROM artifact_intake_finalizations f JOIN artifact_intake_operations o
           ON o.finalization_id = f.id AND o.tenant_id = f.tenant_id
         WHERE f.tenant_id = ? AND f.canonical_capture_id = ?`,
      ).bind(TENANT_A, receipt.captureId).first()).toMatchObject({
        finalization_status: 'reserved', operation_status: 'sealed',
      })
    },
  )

  it('recovers after child finalization succeeds and the parent completion response fails', async () => {
    const upload = await reserveAndUpload({
      idempotencyKey: `split-completion-${SUITE_ID}`, text: 'split-completion',
    })
    const receipt = await finalizeArtifactCapture({
      tenantId: TENANT_A, content: 'split completion', scope: 'research', clientName: 'Codex',
      idempotencyKey: `split-completion-finalize-${SUITE_ID}`,
      artifacts: [{
        uploadId: upload.sealed.uploadId, role: 'source', primary: true,
        detectedMimeType: 'text/plain', byteLength: upload.bytes.byteLength,
        plaintextSha256: upload.plaintextSha256,
      }],
    }, await testKey(), env)
    await env.D1_US.batch([
      env.D1_US.prepare(
        `UPDATE artifact_intake_finalizations
         SET status = 'reserved', recovery_expires_at = 1, lease_owner = NULL, lease_expires_at = NULL
         WHERE tenant_id = ? AND canonical_capture_id = ?`,
      ).bind(TENANT_A, receipt.captureId),
      env.D1_US.prepare(
        `UPDATE artifact_intake_operations SET status = 'sealed', finalization_protected_until = 1
         WHERE tenant_id = ? AND upload_id = ?`,
      ).bind(TENANT_A, upload.sealed.uploadId),
    ])
    const targetFinalization = await env.D1_US.prepare(
      `SELECT id FROM artifact_intake_finalizations
       WHERE tenant_id = ? AND canonical_capture_id = ?`,
    ).bind(TENANT_A, receipt.captureId).first<{ id: string }>()
    const originalD1 = env.D1_US
    let injected = false
    const wrap = (
      statement: D1PreparedStatement, sql: string, bindings: unknown[] = [],
    ): D1PreparedStatement => new Proxy(statement, {
      get(target, property) {
        if (property === 'bind') return (...values: unknown[]) => wrap(target.bind(...values), sql, values)
        if (property === 'run' && !injected && sql.includes("SET status = 'finalized'") &&
            sql.trimStart().startsWith('UPDATE artifact_intake_finalizations') &&
            bindings.includes(targetFinalization!.id)) {
          return async () => { injected = true; throw new Error('lost parent completion acknowledgement') }
        }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const d1 = new Proxy(originalD1, {
      get(target, property) {
        if (property === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql)
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const firstNow = Date.now()
    const first = await recoverOrFailStaleArtifactFinalizations(
      { ...env, D1_US: d1 } as unknown as Env, firstNow, 100,
    )
    expect(first.deferred).toBeGreaterThanOrEqual(1)
    expect(await env.D1_US.prepare(
      `SELECT f.status AS finalization_status, o.status AS operation_status
       FROM artifact_intake_finalizations f JOIN artifact_intake_operations o
         ON o.finalization_id = f.id AND o.tenant_id = f.tenant_id
       WHERE f.tenant_id = ? AND f.canonical_capture_id = ?`,
    ).bind(TENANT_A, receipt.captureId).first()).toMatchObject({
      finalization_status: 'reserved', operation_status: 'finalized',
    })
    const second = await recoverOrFailStaleArtifactFinalizations(
      env, firstNow + ARTIFACT_FINALIZATION_LEASE_MS + 1, 100,
    )
    expect(second.repairedFinalized).toBeGreaterThanOrEqual(1)
    expect(await env.D1_US.prepare(
      `SELECT status FROM artifact_intake_finalizations
       WHERE tenant_id = ? AND canonical_capture_id = ?`,
    ).bind(TENANT_A, receipt.captureId).first()).toMatchObject({ status: 'finalized' })
  })

  it('rejects a lease that would cross recovery and keeps a corrupted live lease safe from reaping', async () => {
    const upload = await reserveAndUpload({
      idempotencyKey: `lease-deadline-${SUITE_ID}`, text: 'lease-deadline',
    })
    const receipt = await finalizeArtifactCapture({
      tenantId: TENANT_A, content: 'lease deadline', scope: 'research', clientName: 'Codex',
      idempotencyKey: `lease-deadline-finalize-${SUITE_ID}`,
      artifacts: [{
        uploadId: upload.sealed.uploadId, role: 'source', primary: true,
        detectedMimeType: 'text/plain', byteLength: upload.bytes.byteLength,
        plaintextSha256: upload.plaintextSha256,
      }],
    }, await testKey(), env)
    const finalization = await env.D1_US.prepare(
      `SELECT * FROM artifact_intake_finalizations
       WHERE tenant_id = ? AND canonical_capture_id = ?`,
    ).bind(TENANT_A, receipt.captureId).first<ArtifactFinalizationRow>()
    const now = Date.now()
    await env.D1_US.batch([
      env.D1_US.prepare(
        `UPDATE artifact_intake_finalizations SET status = 'reserved', lease_owner = NULL,
         lease_expires_at = NULL, recovery_expires_at = ? WHERE tenant_id = ? AND id = ?`,
      ).bind(now + ARTIFACT_FINALIZATION_LEASE_MS - 1, TENANT_A, finalization!.id),
      env.D1_US.prepare(
        `UPDATE artifact_intake_operations SET status = 'sealed', expires_at = 1
         WHERE tenant_id = ? AND upload_id = ?`,
      ).bind(TENANT_A, upload.sealed.uploadId),
    ])
    await expect(acquireArtifactFinalizationLease({
      tenantId: TENANT_A, finalizationId: finalization!.id, leaseOwner: 'too-late-owner',
      expectedOperationCount: 1, captureId: finalization!.canonical_capture_id,
      documentId: finalization!.canonical_document_id, operationId: finalization!.canonical_operation_id,
      now,
    }, env)).rejects.toMatchObject({ code: 'invalid_state' })
    expect((await reapExpiredArtifactUploads(env, now, 100)).reaped).toBe(0)

    await env.D1_US.prepare(
      `UPDATE artifact_intake_finalizations
       SET lease_owner = NULL, lease_expires_at = NULL, recovery_expires_at = NULL
       WHERE tenant_id = ? AND id = ?`,
    ).bind(TENANT_A, finalization!.id).run()
    await expect(acquireArtifactFinalizationLease({
      tenantId: TENANT_A, finalizationId: finalization!.id, leaseOwner: 'unsafe-null-owner',
      expectedOperationCount: 1, captureId: finalization!.canonical_capture_id,
      documentId: finalization!.canonical_document_id, operationId: finalization!.canonical_operation_id,
      now, leaseMs: 10, recoveryMs: 9,
    }, env)).rejects.toMatchObject({ code: 'invalid_state' })
    expect(await env.D1_US.prepare(
      `SELECT lease_owner, recovery_expires_at FROM artifact_intake_finalizations
       WHERE tenant_id = ? AND id = ?`,
    ).bind(TENANT_A, finalization!.id).first()).toEqual({
      lease_owner: null, recovery_expires_at: null,
    })

    const staleBoundary = now + ARTIFACT_FINALIZATION_LEASE_MS + 10
    await env.D1_US.prepare(
      `UPDATE artifact_intake_finalizations
       SET lease_owner = 'historical-corrupt-live-lease', lease_expires_at = ?, recovery_expires_at = ?
       WHERE tenant_id = ? AND id = ?`,
    ).bind(staleBoundary + 60_000, staleBoundary - 1, TENANT_A, finalization!.id).run()
    const raced = await reapExpiredArtifactUploads(env, staleBoundary, 100)
    expect(raced).toMatchObject({ failed: 0, reaped: 0 })
    expect(await env.D1_US.prepare(
      `SELECT status, lease_owner FROM artifact_intake_finalizations WHERE tenant_id = ? AND id = ?`,
    ).bind(TENANT_A, finalization!.id).first()).toMatchObject({
      status: 'reserved', lease_owner: 'historical-corrupt-live-lease',
    })
  })

  it('classifies corrupt upload identity as authoritative metadata mismatch', async () => {
    await expect(proveManagedArtifactCiphertext({
      env, tenantId: TENANT_A, uploadId: 'not-a-valid-upload-id', recordedKey: 'opaque',
      expectedCiphertextByteLength: 1, expectedCiphertextSha256: 'a'.repeat(64),
    })).resolves.toEqual({
      status: 'authoritative_mismatch', reason: 'operation_metadata_mismatch',
    })
  })

  it('reports a direct finalized replay mismatch without rewriting finalized history', async () => {
    const upload = await reserveAndUpload({
      idempotencyKey: `finalized-replay-incident-${SUITE_ID}`, text: 'finalized-replay-incident',
    })
    const input: FinalizeArtifactCaptureInput = {
      tenantId: TENANT_A, content: 'finalized replay incident', scope: 'research', clientName: 'Codex',
      idempotencyKey: `finalized-replay-incident-finalize-${SUITE_ID}`,
      artifacts: [{
        uploadId: upload.sealed.uploadId, role: 'source', primary: true,
        detectedMimeType: 'text/plain', byteLength: upload.bytes.byteLength,
        plaintextSha256: upload.plaintextSha256,
      }],
    }
    const receipt = await finalizeArtifactCapture(input, await testKey(), env)
    const operation = await getArtifactIntakeOperation(env, TENANT_A, upload.sealed.uploadId)
    await env.R2_ARTIFACTS.delete(operation!.r2_key)
    const incident = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await expect(finalizeArtifactCapture(input, await testKey(), env))
      .rejects.toMatchObject({ code: 'invalid_state' })
    expect(incident).toHaveBeenCalledWith('ARTIFACT_INTEGRITY_INCIDENT', { reason: 'object_missing' })
    expect(await env.D1_US.prepare(
      `SELECT f.status AS finalization_status, o.status AS operation_status
       FROM artifact_intake_finalizations f
       JOIN artifact_intake_operations o ON o.finalization_id = f.id AND o.tenant_id = f.tenant_id
       WHERE f.tenant_id = ? AND f.canonical_capture_id = ?`,
    ).bind(TENANT_A, receipt.captureId).first()).toEqual({
      finalization_status: 'finalized', operation_status: 'finalized',
    })
  })

  it('rejects manifest count and aggregate-byte overflow before any reservation', async () => {
    const before = await env.D1_US.prepare(
      `SELECT COUNT(*) AS count FROM artifact_intake_finalizations WHERE tenant_id = ?`,
    ).bind(TENANT_B).first<number>('count')
    const build = (count: number, byteLength: number): FinalizeArtifactCaptureInput => {
      const ids = Array.from({ length: count }, () => crypto.randomUUID())
      return {
        tenantId: TENANT_B, content: 'bounded manifest', scope: 'research', clientName: 'Codex',
        idempotencyKey: `bounded-manifest-${count}-${byteLength}-${SUITE_ID}`,
        declaredDerivativeUploadIds: ids.slice(1),
        artifacts: ids.map((uploadId, index) => ({
          uploadId, role: index === 0 ? 'source' : 'derivative', primary: index === 0,
          parentUploadId: index === 0 ? null : ids[index - 1],
          detectedMimeType: 'application/octet-stream', byteLength, plaintextSha256: 'a'.repeat(64),
        })),
      }
    }
    await expect(finalizeArtifactCapture(
      build(ARTIFACT_MANIFEST_MAX_COUNT + 1, 1), await testKey(), env,
    )).rejects.toMatchObject({ code: 'bulk_import_required' })
    const aggregateEntryBytes = Math.floor(ARTIFACT_MANIFEST_MAX_AGGREGATE_BYTES / 3) + 1
    expect(aggregateEntryBytes).toBeLessThanOrEqual(ARTIFACT_MAX_BYTES)
    await expect(finalizeArtifactCapture(
      build(3, aggregateEntryBytes), await testKey(), env,
    )).rejects.toMatchObject({ code: 'bulk_import_required' })
    expect(await env.D1_US.prepare(
      `SELECT COUNT(*) AS count FROM artifact_intake_finalizations WHERE tenant_id = ?`,
    ).bind(TENANT_B).first<number>('count')).toBe(before)
  })

  it('proves two maximum-sized ciphertexts with concurrency exactly one', async () => {
    const uploadIds = [crypto.randomUUID(), crypto.randomUUID()]
    const artifactIds = [crypto.randomUUID(), crypto.randomUUID()]
    const bytes = new Uint8Array(ARTIFACT_MAX_BYTES)
    const cipherHash = await sha256Bytes(bytes)
    const keys = await Promise.all(uploadIds.map(uploadId => managedArtifactR2Key(TENANT_A, uploadId)))
    const captureId = crypto.randomUUID()
    const documentId = crypto.randomUUID()
    const operationId = crypto.randomUUID()
    const finalizationId = crypto.randomUUID()
    const identity = [
      { uploadId: uploadIds[0]!, role: 'source' as const, parentUploadId: null, primary: true },
      { uploadId: uploadIds[1]!, role: 'derivative' as const, parentUploadId: uploadIds[0]!, primary: false },
    ].map(item => ({
      ...item, mediaType: 'application/octet-stream', byteLength: ARTIFACT_MAX_BYTES,
      plaintextSha256: 'b'.repeat(64),
    }))
    const finalization: ArtifactFinalizationRow = {
      id: finalizationId, tenant_id: TENANT_A, idempotency_hash: 'c'.repeat(64),
      manifest_sha256: 'd'.repeat(64), artifact_manifest_sha256: await artifactManifestIdentitySha256(identity),
      status: 'finalized', error_code: null, canonical_capture_id: captureId,
      canonical_document_id: documentId, canonical_operation_id: operationId,
      expected_operation_count: 2, lease_owner: null, lease_expires_at: null,
      recovery_expires_at: null, created_at: 1, updated_at: 1,
    }
    const operations = uploadIds.map((uploadId, index) => ({
      id: crypto.randomUUID(), tenant_id: TENANT_A, upload_id: uploadId,
      idempotency_hash: crypto.randomUUID(), status: 'finalized' as const, error_code: null,
      artifact_id: artifactIds[index]!, r2_key: keys[index]!, declared_mime_category: null,
      detected_mime_category: 'application', byte_length: ARTIFACT_MAX_BYTES,
      plaintext_sha256: 'b'.repeat(64), ciphertext_sha256: cipherHash,
      ciphertext_byte_length: ARTIFACT_MAX_BYTES, encryption_family: 'tmk' as const,
      finalization_id: finalizationId, finalization_protected_until: null,
      expiry_claim_token: null, expiry_claim_expires_at: null, canonical_capture_id: captureId,
      canonical_document_id: documentId, canonical_operation_id: operationId,
      created_at: 1, updated_at: 1, expires_at: 1,
    }))
    let active = 0
    let maximumActive = 0
    const proofEnv = {
      ...env,
      R2_ARTIFACTS: {
        get: async () => ({
          arrayBuffer: async () => {
            active += 1
            maximumActive = Math.max(maximumActive, active)
            await Promise.resolve()
            active -= 1
            return bytes.buffer
          },
        }),
      },
    } as unknown as Env
    const originalStore = getCanonicalMemoryStore(env)
    installCanonicalMemoryStore(proofEnv, new Proxy(originalStore, {
      get(target, property) {
        if (property === 'getCapture') return async () => ({
          id: captureId, artifact_id: artifactIds[0], body_r2_key: 'body',
        })
        if (property === 'getDocument') return async () => ({
          capture_id: captureId, artifact_id: artifactIds[0], body_r2_key: 'body',
          artifact_manifest: operations.map((row, index) => ({
            artifact_id: row.artifact_id, role: index === 0 ? 'source' : 'derivative',
            parent_artifact_id: index === 0 ? null : artifactIds[0], storage_kind: 'managed_r2',
            r2_key: row.r2_key, media_type: 'application/octet-stream', byte_length: ARTIFACT_MAX_BYTES,
            sha256: row.plaintext_sha256, cipher_sha256: row.ciphertext_sha256,
            encryption_family: row.encryption_family, ordinal: index, primary: index === 0,
          })),
        })
        if (property === 'getOperationById') return async () => ({
          capture_id: captureId, status: 'accepted',
        })
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    }))
    expect(await proveArtifactFinalizationCanonicalSuccess({
      finalization, operations, env: proofEnv,
    })).toMatchObject({ status: 'verified' })
    expect(maximumActive).toBe(1)
  })

  it('detects an old-writer row created after the one-time 1032 backfill', async () => {
    const upload = await reserveAndUpload({
      tenantId: TENANT_B, idempotencyKey: `old-writer-${SUITE_ID}`, text: 'old-writer',
    })
    const start = Date.now() - 10
    const createdAt = Date.now()
    const captureId = crypto.randomUUID()
    const documentId = crypto.randomUUID()
    const canonicalOperationId = crypto.randomUUID()
    await env.D1_US.batch([
      env.D1_US.prepare(
        `INSERT INTO artifact_intake_finalizations
         (id, tenant_id, idempotency_hash, manifest_sha256, status, error_code,
          canonical_capture_id, canonical_document_id, canonical_operation_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'reserved', NULL, ?, ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(), TENANT_B, crypto.randomUUID(), crypto.randomUUID(),
        captureId, documentId, canonicalOperationId, createdAt, createdAt,
      ),
      env.D1_US.prepare(
        `UPDATE artifact_intake_operations
         SET canonical_capture_id = ?, canonical_document_id = ?, canonical_operation_id = ?,
             finalization_id = NULL, updated_at = ?
         WHERE tenant_id = ? AND upload_id = ?`,
      ).bind(captureId, documentId, canonicalOperationId, createdAt, TENANT_B, upload.sealed.uploadId),
    ])
    expect(await auditArtifactFinalizationMigrationOverlap({
      migrationAppliedAt: start, boundary: { kind: 'audit_time', auditedAt: createdAt + 10 },
    }, env)).toMatchObject({
      affectedFinalizationCount: 1, zeroExpectedOperationCount: 1,
      missingManifestHashCount: 1, missingOperationBindingCount: 1,
    })
  })

  it('finds an old-version write that commits after the Worker deployment timestamp', async () => {
    const tenant = `test-tenant-straggler-${SUITE_ID}`
    await ensureTenant(tenant)
    const migrationAppliedAt = Date.now() - 50
    const workerDeployedAt = Date.now() - 20
    // An isolate started before the route switch commits after deployment.
    const stragglerCommittedAt = workerDeployedAt + 10
    await env.D1_US.prepare(
      `INSERT INTO artifact_intake_finalizations
       (id, tenant_id, idempotency_hash, manifest_sha256, status, error_code,
        canonical_capture_id, canonical_document_id, canonical_operation_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'reserved', NULL, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(), tenant, crypto.randomUUID(), crypto.randomUUID(),
      crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(),
      stragglerCommittedAt, stragglerCommittedAt,
    ).run()
    // A deployment timestamp is not a drain boundary: bounded there, the
    // straggler escapes. The durable contract audits through the audit time.
    const boundedAtDeploy = await auditArtifactFinalizationMigrationOverlap({
      migrationAppliedAt, boundary: { kind: 'verified_drain', drainVerifiedAt: workerDeployedAt },
    }, env)
    expect(boundedAtDeploy.affectedFinalizationCount).toBe(0)
    const invariantWide = await auditArtifactFinalizationMigrationOverlap({
      migrationAppliedAt, boundary: { kind: 'audit_time', auditedAt: Date.now() + 1 },
    }, env)
    expect(invariantWide.affectedFinalizationCount).toBeGreaterThanOrEqual(1)
    expect(invariantWide.zeroExpectedOperationCount).toBeGreaterThanOrEqual(1)
    await expect(auditArtifactFinalizationMigrationOverlap({
      migrationAppliedAt, boundary: { kind: 'audit_time', auditedAt: migrationAppliedAt },
    }, env)).rejects.toThrow('boundary invalid')
  })
})
