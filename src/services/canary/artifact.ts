import type { Env } from '../../types/env'
import { getCanonicalDocument, searchCanonicalMemory } from '../canonical-memory-query'
import { ARTIFACT_UPLOAD_EXPIRY_MS } from '../artifact-intake/config'
import { sha256Bytes, sha256Text } from '../artifact-intake/crypto'
import { finalizeArtifactCapture } from '../artifact-intake/finalize'
import {
  getArtifactIntakeOperation,
  getArtifactIntakeStatus,
  reserveArtifactUpload,
  uploadArtifactBytes,
} from '../artifact-intake/operations'
import { reapExpiredArtifactUploads } from '../artifact-intake/reaper'
import { proveManagedArtifactCiphertext } from '../artifact-intake/storage'

export type ArtifactCanaryStage = 'upload' | 'seal' | 'finalize' | 'r2' | 'manifest' | 'query' | 'isolation' | 'cleanup'

export class ArtifactCanaryFailure extends Error {
  constructor(readonly stage: ArtifactCanaryStage) {
    super(`artifact_${stage}_failed`)
    this.name = 'ArtifactCanaryFailure'
  }
}

function fail(stage: ArtifactCanaryStage): never {
  throw new ArtifactCanaryFailure(stage)
}

export async function runArtifactCanary(
  env: Env,
  tenantId: string,
  key: CryptoKey,
  now = Date.now(),
): Promise<string> {
  const day = new Date(now).toISOString().slice(0, 10)
  const tenantMark = (await sha256Text(`artifact-canary:${tenantId}`)).slice(0, 12)
  const marker = `artifact-canary-${day}-${tenantMark}`
  const bytes = new TextEncoder().encode(`Synthetic artifact health fixture ${marker}`)
  const plaintextSha256 = await sha256Bytes(bytes)
  let upload
  try {
    upload = await reserveArtifactUpload({
      tenantId, idempotencyKey: `artifact-canary-source:${tenantMark}:${day}`,
      byteLength: bytes.byteLength, plaintextSha256, declaredMimeType: 'text/plain',
    }, env)
  } catch { fail('upload') }
  try {
    await uploadArtifactBytes({
      tenantId, uploadId: upload.uploadId, bytes, declaredMimeType: 'text/plain',
      detectedMimeType: 'text/plain', encryptionFamily: 'kek', key,
    }, env)
  } catch { fail('seal') }
  let receipt
  try {
    receipt = await finalizeArtifactCapture({
      tenantId, content: marker, title: 'Artifact canary', scope: 'canary',
      provenance: 'artifact_canary', clientName: 'system-canary',
      sourceRef: `artifact-canary:${day}`, idempotencyKey: `artifact-canary-finalize:${tenantMark}:${day}`,
      artifacts: [{
        uploadId: upload.uploadId, role: 'source', primary: true,
        detectedMimeType: 'text/plain', byteLength: bytes.byteLength, plaintextSha256,
      }],
    }, key, env)
  } catch { fail('finalize') }
  const operation = await getArtifactIntakeOperation(env, tenantId, upload.uploadId)
  if (!operation?.ciphertext_sha256 || !operation.ciphertext_byte_length) fail('r2')
  const proof = await proveManagedArtifactCiphertext({
    env, tenantId, uploadId: upload.uploadId, recordedKey: operation.r2_key,
    adoptedAttemptToken: operation.adopted_attempt_token,
    expectedCiphertextByteLength: operation.ciphertext_byte_length,
    expectedCiphertextSha256: operation.ciphertext_sha256,
  })
  if (proof.status !== 'verified') fail('r2')
  const document = await getCanonicalDocument(
    { tenantId, documentId: receipt.documentId }, env, tenantId, { tmk: key },
  ).catch(() => null)
  if (document?.body !== marker || document.artifacts.length !== 1) fail('manifest')
  const found = await searchCanonicalMemory(
    { tenantId, query: marker, mode: 'lexical', limit: 3 }, env, tenantId, { tmk: key },
  ).catch(() => null)
  if (!found?.items.some(item => item.captureId === receipt.captureId)) fail('query')
  const isolatedTenant = `canary-isolation-${tenantMark}`
  const isolated = await searchCanonicalMemory(
    { tenantId: isolatedTenant, query: marker, mode: 'lexical', limit: 3 },
    env, isolatedTenant, { tmk: key },
  ).catch(() => null)
  if (!isolated || isolated.items.length !== 0) fail('isolation')
  try {
    const stale = await reserveArtifactUpload({
      tenantId, idempotencyKey: `artifact-canary-cleanup:${tenantMark}:${day}`,
      byteLength: bytes.byteLength, plaintextSha256, declaredMimeType: 'text/plain',
      now: now - ARTIFACT_UPLOAD_EXPIRY_MS - 1,
    }, env)
    if (stale.status !== 'expired') await reapExpiredArtifactUploads(env, now, 10)
    if ((await getArtifactIntakeStatus({ tenantId, uploadId: stale.uploadId }, env)).status !== 'expired') fail('cleanup')
  } catch (error) {
    if (error instanceof ArtifactCanaryFailure) throw error
    fail('cleanup')
  }
  return 'artifact_ok'
}
