import type { Env } from '../../types/env'
import { ArtifactIntakeContractError, ARTIFACT_INTAKE_ERROR } from './contracts'
import { convergeSealedCiphertextIdentity } from './sealed-convergence'
import {
  getArtifactIntakeOperation,
  type ArtifactIntakeOperationRow,
} from './operations'
import { proveManagedArtifactCiphertext } from './storage'

/** Repairs old-Worker metadata clobber, then proves the immutable identity. */
export async function repairAndProveImmutableArtifact(args: {
  env: Env
  row: ArtifactIntakeOperationRow
  finalizationId: string
  leaseOwner: string
  key: CryptoKey
}): Promise<ArtifactIntakeOperationRow> {
  let row = args.row
  let proof = await prove(row, args.env)
  if (proof !== 'verified' && row.encryption_family) {
    await convergeSealedCiphertextIdentity(
      args.env, row, args.key, row.encryption_family, args.finalizationId,
    )
    row = await getArtifactIntakeOperation(args.env, row.tenant_id, row.upload_id) ?? row
    proof = await prove(row, args.env)
  }
  if (proof !== 'verified' || !row.adopted_attempt_token) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.CIPHERTEXT_INVALID)
  }
  return row
}

async function prove(row: ArtifactIntakeOperationRow, env: Env): Promise<string> {
  return (await proveManagedArtifactCiphertext({
    env, tenantId: row.tenant_id, uploadId: row.upload_id,
    recordedKey: row.r2_key, adoptedAttemptToken: row.adopted_attempt_token,
    expectedCiphertextByteLength: Number(row.ciphertext_byte_length),
    expectedCiphertextSha256: row.ciphertext_sha256 ?? '',
  })).status
}
