import type { Env } from '../../types/env'
import { ARTIFACT_MAX_CIPHERTEXT_BYTES } from './config'
import { ArtifactIntakeContractError, ARTIFACT_INTAKE_ERROR } from './contracts'
import { sha256Bytes } from './crypto'
import { expectedManagedArtifactKey } from './storage-keys'

/**
 * Deletes only the exact proven object: the recorded key must equal the key
 * derived from the operation's adopted/legacy identity, and when a ciphertext
 * identity was recorded the object must match it in size before any bytes are
 * materialized, then in hash. Rows that never recorded a ciphertext identity
 * (crashed pre-seal writers) are deleted by exact derived key with zero body
 * reads, since no expectation exists to prove against.
 */
export async function deleteProvenManagedArtifact(args: {
  env: Env
  tenantId: string
  uploadId: string
  recordedKey: string
  adoptedAttemptToken?: string | null
  expectedCiphertextSha256?: string | null
  expectedCiphertextByteLength?: number | null
}): Promise<boolean> {
  const expectedKey = await expectedManagedArtifactKey(args.tenantId, args.uploadId, args.adoptedAttemptToken)
  if (args.recordedKey !== expectedKey) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_STATE)
  }
  const object = await args.env.R2_ARTIFACTS.get(expectedKey)
  if (!object) return false
  if (args.expectedCiphertextSha256) {
    const expectedLength = Number(args.expectedCiphertextByteLength)
    if (
      !Number.isInteger(expectedLength) ||
      expectedLength <= 0 ||
      expectedLength > ARTIFACT_MAX_CIPHERTEXT_BYTES
    ) {
      throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_STATE)
    }
    if (object.size !== expectedLength) {
      throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.HASH_MISMATCH)
    }
    const actualHash = await sha256Bytes(await object.arrayBuffer())
    if (actualHash !== args.expectedCiphertextSha256) {
      throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.HASH_MISMATCH)
    }
  }
  await args.env.R2_ARTIFACTS.delete(expectedKey)
  return true
}
