import type { Env } from '../../types/env'
import { ARTIFACT_MAX_CIPHERTEXT_BYTES } from './config'
import { ArtifactIntakeContractError, ARTIFACT_INTAKE_ERROR } from './contracts'
import { sha256Bytes } from './crypto'
import {
  artifactProofIndeterminate,
  artifactProofMismatch,
  type ArtifactProofResult,
  verifiedArtifactProof,
} from './proof-result'

import {
  expectedManagedArtifactKey,
  managedArtifactAttemptR2Key,
  managedArtifactR2Key,
} from './storage-keys'

export {
  expectedManagedArtifactKey,
  managedArtifactAttemptR2Key,
  managedArtifactR2Key,
} from './storage-keys'

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
  if (
    !Number.isInteger(args.expectedCiphertextByteLength) ||
    args.expectedCiphertextByteLength <= 0 ||
    args.expectedCiphertextByteLength > ARTIFACT_MAX_CIPHERTEXT_BYTES
  ) {
    return artifactProofIndeterminate('bounds_exceeded')
  }
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
  // Reject on the recorded object size before materializing any bytes, so a
  // corrupt oversized object can never be pulled into Worker memory.
  if (object.size !== args.expectedCiphertextByteLength) {
    return artifactProofMismatch('ciphertext_byte_length_mismatch')
  }
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
