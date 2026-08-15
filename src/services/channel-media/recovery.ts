import type { Env } from '../../types/env'
import type { PreparedChannelMediaCapture } from '../../types/channel-media'
import {
  CHANNEL_MEDIA_DESCRIPTION_MAX_CHARS,
  CHANNEL_MEDIA_RECOVERY_MAX_BYTES,
} from '../artifact-intake/config'
import { ArtifactIntakeContractError, ARTIFACT_INTAKE_ERROR } from '../artifact-intake/contracts'
import { sealArtifactBytes, sha256Text, unsealArtifactBytes } from '../artifact-intake/crypto'

const OPERATION_ID = /^[a-f0-9-]{36}$/i
const SHA256 = /^[a-f0-9]{64}$/i

export async function channelMediaRecoveryKey(tenantId: string, operationId: string): Promise<string> {
  if (!OPERATION_ID.test(operationId)) throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_STATE)
  const scope = (await sha256Text(`haetsal-channel-recovery:${tenantId}`)).slice(0, 32)
  return `artifact-intake/recovery/v1/${scope}/${operationId}.enc`
}

function validateRecovery(value: Partial<PreparedChannelMediaCapture>): PreparedChannelMediaCapture {
  const valid = value.version === 1 && typeof value.uploadId === 'string' && OPERATION_ID.test(value.uploadId) &&
    typeof value.description === 'string' && value.description.length > 0 &&
    value.description.length <= CHANNEL_MEDIA_DESCRIPTION_MAX_CHARS &&
    typeof value.detectedMimeType === 'string' && value.detectedMimeType.length <= 120 &&
    (value.declaredMimeType === undefined || (
      typeof value.declaredMimeType === 'string' && value.declaredMimeType.length <= 120
    )) && typeof value.byteLength === 'number' && Number.isSafeInteger(value.byteLength) && value.byteLength > 0 &&
    typeof value.plaintextSha256 === 'string' && SHA256.test(value.plaintextSha256)
  if (!valid) throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_STATE)
  return value as PreparedChannelMediaCapture
}

export async function readChannelMediaRecovery(args: {
  tenantId: string; operationId: string; tmk: CryptoKey
}, env: Env): Promise<PreparedChannelMediaCapture | null> {
  const object = await env.R2_ARTIFACTS.get(await channelMediaRecoveryKey(args.tenantId, args.operationId))
  if (!object) return null
  try {
    const envelope = new Uint8Array(await object.arrayBuffer())
    const plaintext = await unsealArtifactBytes(envelope, args.tmk, 'tmk')
    if (plaintext.byteLength > CHANNEL_MEDIA_RECOVERY_MAX_BYTES) throw new Error('oversize')
    return validateRecovery(JSON.parse(new TextDecoder().decode(plaintext)) as Partial<PreparedChannelMediaCapture>)
  } catch (error) {
    if (error instanceof ArtifactIntakeContractError) throw error
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.CIPHERTEXT_INVALID)
  }
}

export async function writeChannelMediaRecovery(args: {
  tenantId: string; operationId: string; prepared: PreparedChannelMediaCapture; tmk: CryptoKey
}, env: Env): Promise<PreparedChannelMediaCapture> {
  const prepared = validateRecovery(args.prepared)
  const key = await channelMediaRecoveryKey(args.tenantId, args.operationId)
  const plaintext = new TextEncoder().encode(JSON.stringify(prepared))
  if (plaintext.byteLength > CHANNEL_MEDIA_RECOVERY_MAX_BYTES) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_STATE)
  }
  const sealed = await sealArtifactBytes(plaintext, args.tmk, 'tmk')
  const written = await env.R2_ARTIFACTS.put(key, sealed.envelope, {
    onlyIf: { etagDoesNotMatch: '*' },
  })
  if (written) return prepared
  const existing = await readChannelMediaRecovery(args, env)
  if (!existing) throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_STATE)
  return existing
}

export async function deleteChannelMediaRecovery(
  tenantId: string, operationId: string, env: Env,
): Promise<void> {
  await env.R2_ARTIFACTS.delete(await channelMediaRecoveryKey(tenantId, operationId))
}
