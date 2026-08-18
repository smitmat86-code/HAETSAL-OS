import type { Env } from '../../types/env'
import { ArtifactIntakeContractError, ARTIFACT_INTAKE_ERROR } from './contracts'
import { sha256Bytes, sha256Text } from './crypto'
import {
  artifactProofIndeterminate,
  artifactProofMismatch,
  type ArtifactProofResult,
  verifiedArtifactProof,
} from './proof-result'

const UPLOAD_ID_PATTERN = /^[a-f0-9-]{36}$/i

export async function managedArtifactR2Key(tenantId: string, uploadId: string): Promise<string> {
  if (!UPLOAD_ID_PATTERN.test(uploadId)) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_MANIFEST)
  }
  const tenantScope = (await sha256Text(`haetsal-artifact-tenant:${tenantId}`)).slice(0, 32)
  return `artifact-intake/v1/${tenantScope}/${uploadId}.enc`
}

/**
 * Each upload attempt writes to its own immutable key. Attempts never share a
 * mutable object, so a stale writer can never overwrite an adopted ciphertext.
 */
export async function managedArtifactAttemptR2Key(
  tenantId: string,
  uploadId: string,
  attemptToken: string,
): Promise<string> {
  if (!UPLOAD_ID_PATTERN.test(uploadId) || !UPLOAD_ID_PATTERN.test(attemptToken)) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_MANIFEST)
  }
  const tenantScope = (await sha256Text(`haetsal-artifact-tenant:${tenantId}`)).slice(0, 32)
  return `artifact-intake/v1/${tenantScope}/${uploadId}/${attemptToken}.enc`
}

/** The only key D1 may legitimately record for this operation's ciphertext. */
export async function expectedManagedArtifactKey(
  tenantId: string,
  uploadId: string,
  adoptedAttemptToken: string | null | undefined,
): Promise<string> {
  return adoptedAttemptToken
    ? await managedArtifactAttemptR2Key(tenantId, uploadId, adoptedAttemptToken)
    : await managedArtifactR2Key(tenantId, uploadId)
}

export async function putManagedArtifactCiphertext(
  env: Env,
  key: string,
  ciphertext: Uint8Array,
): Promise<void> {
  await env.R2_ARTIFACTS.put(key, ciphertext)
}

export async function readManagedArtifactCiphertext(env: Env, key: string): Promise<Uint8Array | null> {
  const object = await env.R2_ARTIFACTS.get(key)
  return object ? new Uint8Array(await object.arrayBuffer()) : null
}

export async function managedArtifactExists(env: Env, key: string): Promise<boolean> {
  return Boolean(await env.R2_ARTIFACTS.head(key))
}

export interface ManagedArtifactCiphertextProof {
  key: string
  byteLength: number
  ciphertextSha256: string
}

/** Proves the exact managed object, not merely that some object exists at a recorded key. */
export async function proveManagedArtifactCiphertext(args: {
  env: Env
  tenantId: string
  uploadId: string
  recordedKey: string
  adoptedAttemptToken?: string | null
  expectedCiphertextByteLength: number
  expectedCiphertextSha256: string
}): Promise<ArtifactProofResult<ManagedArtifactCiphertextProof>> {
  let expectedKey: string
  try {
    expectedKey = await expectedManagedArtifactKey(args.tenantId, args.uploadId, args.adoptedAttemptToken)
  } catch (error) {
    if (error instanceof ArtifactIntakeContractError) {
      return artifactProofMismatch('operation_metadata_mismatch')
    }
    return artifactProofIndeterminate('crypto_unavailable')
  }
  if (args.recordedKey !== expectedKey) {
    return artifactProofMismatch('storage_key_mismatch')
  }
  let object: R2ObjectBody | null
  try {
    object = await args.env.R2_ARTIFACTS.get(expectedKey)
  } catch {
    return artifactProofIndeterminate('r2_unavailable')
  }
  if (!object) return artifactProofMismatch('object_missing')
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await object.arrayBuffer())
  } catch {
    return artifactProofIndeterminate('r2_unavailable')
  }
  if (bytes.byteLength !== args.expectedCiphertextByteLength) {
    return artifactProofMismatch('ciphertext_byte_length_mismatch')
  }
  let ciphertextSha256: string
  try {
    ciphertextSha256 = await sha256Bytes(bytes)
  } catch {
    return artifactProofIndeterminate('crypto_unavailable')
  }
  if (ciphertextSha256 !== args.expectedCiphertextSha256) {
    return artifactProofMismatch('ciphertext_hash_mismatch')
  }
  return verifiedArtifactProof({ key: expectedKey, byteLength: bytes.byteLength, ciphertextSha256 })
}

export async function deleteProvenManagedArtifact(args: {
  env: Env
  tenantId: string
  uploadId: string
  recordedKey: string
  adoptedAttemptToken?: string | null
  expectedCiphertextSha256?: string | null
}): Promise<boolean> {
  const expectedKey = await expectedManagedArtifactKey(args.tenantId, args.uploadId, args.adoptedAttemptToken)
  if (args.recordedKey !== expectedKey) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_STATE)
  }
  const object = await args.env.R2_ARTIFACTS.get(expectedKey)
  if (!object) return false
  if (args.expectedCiphertextSha256) {
    const actualHash = await sha256Bytes(await object.arrayBuffer())
    if (actualHash !== args.expectedCiphertextSha256) {
      throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.HASH_MISMATCH)
    }
  }
  await args.env.R2_ARTIFACTS.delete(expectedKey)
  return true
}
