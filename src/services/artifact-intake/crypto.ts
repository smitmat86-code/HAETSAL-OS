import type { ArtifactEncryptionFamily } from '../../types/artifact-intake'
import {
  ArtifactIntakeContractError,
  ARTIFACT_INTAKE_ERROR,
} from './contracts'

const IV_BYTES = 12
const FAMILY_PREFIX = Object.freeze({
  tmk: new TextEncoder().encode('TMK1:'),
  kek: new TextEncoder().encode('KEK1:'),
})

type SealedFamily = Exclude<ArtifactEncryptionFamily, 'legacy_unsealed'>

function prefixFor(family: SealedFamily): Uint8Array {
  return FAMILY_PREFIX[family]
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  let difference = 0
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index]! ^ right[index]!
  }
  return difference === 0
}

function ownedBuffer(value: Uint8Array | ArrayBuffer): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value
  return value.slice().buffer as ArrayBuffer
}

export async function sha256Bytes(value: Uint8Array | ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', ownedBuffer(value))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function sha256Text(value: string): Promise<string> {
  return sha256Bytes(new TextEncoder().encode(value))
}

export interface SealedArtifactBytes {
  family: SealedFamily
  envelope: Uint8Array
  plaintextSha256: string
  ciphertextSha256: string
}

export async function sealArtifactBytes(
  plaintext: Uint8Array,
  key: CryptoKey,
  family: SealedFamily,
): Promise<SealedArtifactBytes> {
  const prefix = prefixFor(family)
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: ownedBuffer(iv), additionalData: ownedBuffer(prefix) },
    key,
    ownedBuffer(plaintext),
  )
  const envelope = new Uint8Array(prefix.byteLength + iv.byteLength + encrypted.byteLength)
  envelope.set(prefix, 0)
  envelope.set(iv, prefix.byteLength)
  envelope.set(new Uint8Array(encrypted), prefix.byteLength + iv.byteLength)
  return {
    family,
    envelope,
    plaintextSha256: await sha256Bytes(plaintext),
    ciphertextSha256: await sha256Bytes(envelope),
  }
}

export function detectArtifactEnvelopeFamily(envelope: Uint8Array): SealedFamily {
  for (const family of ['tmk', 'kek'] as const) {
    const prefix = prefixFor(family)
    if (envelope.byteLength >= prefix.byteLength && bytesEqual(envelope.subarray(0, prefix.byteLength), prefix)) {
      return family
    }
  }
  throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.CIPHERTEXT_INVALID)
}

export async function unsealArtifactBytes(
  envelope: Uint8Array,
  key: CryptoKey,
  expectedFamily: SealedFamily,
): Promise<Uint8Array> {
  const actualFamily = detectArtifactEnvelopeFamily(envelope)
  if (actualFamily !== expectedFamily) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.ENCRYPTION_FAMILY_MISMATCH)
  }
  const prefix = prefixFor(expectedFamily)
  if (envelope.byteLength <= prefix.byteLength + IV_BYTES) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.CIPHERTEXT_INVALID)
  }
  const iv = envelope.subarray(prefix.byteLength, prefix.byteLength + IV_BYTES)
  const ciphertext = envelope.subarray(prefix.byteLength + IV_BYTES)
  try {
    return new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: ownedBuffer(iv), additionalData: ownedBuffer(prefix) },
      key,
      ownedBuffer(ciphertext),
    ))
  } catch {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.CIPHERTEXT_INVALID)
  }
}
