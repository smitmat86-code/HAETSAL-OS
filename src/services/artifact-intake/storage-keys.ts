import { ArtifactIntakeContractError, ARTIFACT_INTAKE_ERROR } from './contracts'
import { sha256Text } from './crypto'

const UPLOAD_ID_PATTERN = /^[a-f0-9-]{36}$/i

async function tenantScopeFor(tenantId: string): Promise<string> {
  return (await sha256Text(`haetsal-artifact-tenant:${tenantId}`)).slice(0, 32)
}

export async function managedArtifactR2Key(tenantId: string, uploadId: string): Promise<string> {
  if (!UPLOAD_ID_PATTERN.test(uploadId)) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_MANIFEST)
  }
  return `artifact-intake/v1/${await tenantScopeFor(tenantId)}/${uploadId}.enc`
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
  return `artifact-intake/v1/${await tenantScopeFor(tenantId)}/${uploadId}/${attemptToken}.enc`
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
