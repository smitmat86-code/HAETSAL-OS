import type { Env } from '../../types/env'
import { ArtifactIntakeContractError, ARTIFACT_INTAKE_ERROR } from './contracts'
import { sha256Bytes, sha256Text } from './crypto'

const UPLOAD_ID_PATTERN = /^[a-f0-9-]{36}$/i

export async function managedArtifactR2Key(tenantId: string, uploadId: string): Promise<string> {
  if (!UPLOAD_ID_PATTERN.test(uploadId)) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_MANIFEST)
  }
  const tenantScope = (await sha256Text(`haetsal-artifact-tenant:${tenantId}`)).slice(0, 32)
  return `artifact-intake/v1/${tenantScope}/${uploadId}.enc`
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
  expectedCiphertextByteLength: number
  expectedCiphertextSha256: string
}): Promise<ManagedArtifactCiphertextProof> {
  const expectedKey = await managedArtifactR2Key(args.tenantId, args.uploadId)
  if (args.recordedKey !== expectedKey) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_STATE)
  }
  const object = await args.env.R2_ARTIFACTS.get(expectedKey)
  if (!object) throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_STATE)
  const bytes = new Uint8Array(await object.arrayBuffer())
  if (bytes.byteLength !== args.expectedCiphertextByteLength) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.HASH_MISMATCH)
  }
  const ciphertextSha256 = await sha256Bytes(bytes)
  if (ciphertextSha256 !== args.expectedCiphertextSha256) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.HASH_MISMATCH)
  }
  return { key: expectedKey, byteLength: bytes.byteLength, ciphertextSha256 }
}

export async function deleteProvenManagedArtifact(args: {
  env: Env
  tenantId: string
  uploadId: string
  recordedKey: string
  expectedCiphertextSha256?: string | null
}): Promise<boolean> {
  const expectedKey = await managedArtifactR2Key(args.tenantId, args.uploadId)
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
