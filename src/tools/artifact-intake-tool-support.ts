import { z } from 'zod'
import {
  ArtifactIntakeContractError,
  ARTIFACT_INTAKE_ERROR,
  type ArtifactIntakeErrorCode,
} from '../services/artifact-intake/contracts'
import { sha256Text } from '../services/artifact-intake/crypto'
import type { ArtifactIntakeToolContext } from './artifact-intake-tool-contracts'

export function artifactToolText(value: unknown, isError = false) {
  return { isError, content: [{ type: 'text' as const, text: JSON.stringify(value) }] }
}

export function artifactToolErrorCode(error: unknown): ArtifactIntakeErrorCode {
  if (error instanceof z.ZodError) {
    const known = new Set<string>(Object.values(ARTIFACT_INTAKE_ERROR))
    const issueCode = error.issues.map(issue => issue.message).find(message => known.has(message))
    return (issueCode as ArtifactIntakeErrorCode | undefined) ?? ARTIFACT_INTAKE_ERROR.INVALID_MANIFEST
  }
  return error instanceof ArtifactIntakeContractError
    ? error.code
    : ARTIFACT_INTAKE_ERROR.INVALID_STATE
}

export function requireArtifactToolContext(ctx: ArtifactIntakeToolContext): {
  tenantId: string
  tmk: CryptoKey
  clientName: string
  agentIdentity: string
} {
  const tmk = ctx.getTmk()
  if (!tmk) throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.ENCRYPTION_KEY_UNAVAILABLE)
  const identity = ctx.getClientIdentity()
  if (!identity.clientName || !identity.agentIdentity) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.CLIENT_IDENTITY_UNAVAILABLE)
  }
  return {
    tenantId: ctx.getTenantId(),
    tmk,
    clientName: identity.clientName,
    agentIdentity: identity.agentIdentity,
  }
}

export async function artifactProvenanceReceipt(
  tenantId: string,
  clientName: string,
  agentIdentity: string,
): Promise<Record<string, string>> {
  return {
    tenant_binding: (await sha256Text(`artifact-intake-tenant:${tenantId}`)).slice(0, 24),
    client_name: clientName,
    agent_identity: agentIdentity,
  }
}
