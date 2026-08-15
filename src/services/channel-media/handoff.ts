import type { Env } from '../../types/env'
import type { ChannelMediaDescriptor } from '../../types/channel-media'
import { ArtifactIntakeContractError, ARTIFACT_INTAKE_ERROR } from '../artifact-intake/contracts'
import { sealArtifactBytes, sha256Text, unsealArtifactBytes } from '../artifact-intake/crypto'

const OPERATION_ID = /^[a-f0-9-]{36}$/i

export async function channelMediaHandoffKey(tenantId: string, operationId: string): Promise<string> {
  if (!OPERATION_ID.test(operationId)) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_STATE)
  }
  const scope = (await sha256Text(`haetsal-channel-handoff:${tenantId}`)).slice(0, 32)
  return `artifact-intake/handoff/v1/${scope}/${operationId}.enc`
}

export async function writeChannelMediaHandoff(args: {
  tenantId: string
  operationId: string
  descriptor: ChannelMediaDescriptor
  kek: CryptoKey
}, env: Env): Promise<void> {
  const key = await channelMediaHandoffKey(args.tenantId, args.operationId)
  const existing = await env.R2_ARTIFACTS.get(key)
  if (existing) {
    await unsealArtifactBytes(new Uint8Array(await existing.arrayBuffer()), args.kek, 'kek')
    return
  }
  const plaintext = new TextEncoder().encode(JSON.stringify(args.descriptor))
  const sealed = await sealArtifactBytes(plaintext, args.kek, 'kek')
  await env.R2_ARTIFACTS.put(key, sealed.envelope)
}

export async function readChannelMediaHandoff(args: {
  tenantId: string
  operationId: string
  kek: CryptoKey
}, env: Env): Promise<ChannelMediaDescriptor> {
  const key = await channelMediaHandoffKey(args.tenantId, args.operationId)
  const object = await env.R2_ARTIFACTS.get(key)
  if (!object) throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.RAW_BYTES_UNAVAILABLE)
  try {
    const plaintext = await unsealArtifactBytes(new Uint8Array(await object.arrayBuffer()), args.kek, 'kek')
    const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as Partial<ChannelMediaDescriptor>
    if (
      parsed.version !== 1 ||
      (parsed.provider !== 'telegram' && parsed.provider !== 'sendblue') ||
      typeof parsed.locator !== 'string' || !parsed.locator ||
      typeof parsed.replyTarget !== 'string' || !parsed.replyTarget ||
      typeof parsed.occurredAt !== 'number'
    ) throw new Error('invalid')
    return parsed as ChannelMediaDescriptor
  } catch (error) {
    if (error instanceof ArtifactIntakeContractError) throw error
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.PROVIDER_LOCATOR_INVALID)
  }
}

export async function deleteChannelMediaHandoff(
  tenantId: string,
  operationId: string,
  env: Env,
): Promise<void> {
  await env.R2_ARTIFACTS.delete(await channelMediaHandoffKey(tenantId, operationId))
}
