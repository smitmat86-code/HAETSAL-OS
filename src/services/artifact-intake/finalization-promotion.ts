import type { Env } from '../../types/env'
import {
  ARTIFACT_CIPHERTEXT_ENVELOPE_OVERHEAD_BYTES,
  ARTIFACT_UPLOAD_ATTEMPT_LEASE_MS,
} from './config'
import { ArtifactIntakeContractError, ARTIFACT_INTAKE_ERROR } from './contracts'
import { sha256Bytes, unsealArtifactBytes } from './crypto'
import {
  clearUploadAttemptIntent,
  recordUploadAttemptIntent,
} from './attempt-orphans'
import {
  getArtifactIntakeOperation,
  type ArtifactIntakeOperationRow,
} from './operations'
import {
  managedArtifactAttemptR2Key,
  expectedManagedArtifactKey,
  putManagedArtifactCiphertext,
  readManagedArtifactCiphertext,
} from './storage'
import { ARTIFACT_UPLOAD_PROTOCOL_FENCED } from './upload-protocol'
import { repairAndProveImmutableArtifact } from './finalization-immutable-proof'
import { recordLegacyKeyTombstone } from './legacy-key-sweep'
import { cleanupAmbiguousPromotion } from './promotion-cleanup'

/**
 * Makes a finalization-bound artifact immutable before canonical write. A
 * legacy shared-key envelope is plaintext-proved, copied to a unique attempt
 * key, then adopted by an exact ownership CAS. Once switched, an indefinitely
 * delayed old Worker can mutate only the abandoned legacy key.
 */
export async function stabilizeArtifactForFinalization(args: {
  env: Env
  row: ArtifactIntakeOperationRow
  finalizationId: string
  leaseOwner: string
  key: CryptoKey
}): Promise<ArtifactIntakeOperationRow> {
  if (args.row.adopted_attempt_token) {
    return repairAndProveImmutableArtifact(args)
  }
  if (args.row.r2_key !== await expectedManagedArtifactKey(
    args.row.tenant_id, args.row.upload_id, null,
  )) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.CIPHERTEXT_INVALID)
  }
  const token = crypto.randomUUID()
  const now = Date.now()
  const claimed = await args.env.D1_US.prepare(
    `UPDATE artifact_intake_operations
     SET upload_attempt_token = ?, upload_attempt_expires_at = ?, updated_at = ?
     WHERE tenant_id = ? AND upload_id = ? AND status = 'sealed'
       AND (finalization_id IS NULL OR finalization_id = ?)
       AND adopted_attempt_token IS NULL
       AND expiry_claim_token IS NULL
       AND (upload_attempt_token IS NULL OR upload_attempt_expires_at <= ?)
       AND EXISTS (
         SELECT 1 FROM artifact_intake_finalizations f
         WHERE f.tenant_id = ? AND f.id = ? AND f.status = 'reserved'
           AND f.lease_owner = ? AND f.lease_expires_at > ?
       )`,
  ).bind(
    token, now + ARTIFACT_UPLOAD_ATTEMPT_LEASE_MS, now,
    args.row.tenant_id, args.row.upload_id, args.finalizationId, now,
    args.row.tenant_id, args.finalizationId, args.leaseOwner, now,
  ).run()
  if (Number(claimed.meta.changes ?? 0) !== 1) {
    throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_STATE)
  }

  await recordUploadAttemptIntent(args.env, {
    tenantId: args.row.tenant_id,
    uploadId: args.row.upload_id,
    attemptToken: token,
    leaseExpiresAt: now + ARTIFACT_UPLOAD_ATTEMPT_LEASE_MS,
    now,
  })
  await recordLegacyKeyTombstone(args.env, {
    tenantId: args.row.tenant_id, uploadId: args.row.upload_id, now,
  })
  let putAttempted = false
  let putSucceeded = false
  try {
    const envelope = await readManagedArtifactCiphertext(
      args.env,
      args.row.r2_key,
      Number(args.row.byte_length) + ARTIFACT_CIPHERTEXT_ENVELOPE_OVERHEAD_BYTES,
    )
    if (!envelope || !args.row.encryption_family) {
      throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.CIPHERTEXT_INVALID)
    }
    const plaintext = await unsealArtifactBytes(envelope, args.key, args.row.encryption_family)
    if (await sha256Bytes(plaintext) !== args.row.plaintext_sha256) {
      throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.HASH_MISMATCH)
    }
    const targetKey = await managedArtifactAttemptR2Key(
      args.row.tenant_id, args.row.upload_id, token,
    )
    putAttempted = true
    await putManagedArtifactCiphertext(args.env, targetKey, envelope)
    putSucceeded = true
    const ciphertextSha256 = await sha256Bytes(envelope)
    const adoptionNow = Date.now()
    const adopted = await args.env.D1_US.prepare(
      `UPDATE artifact_intake_operations
       SET r2_key = ?, adopted_attempt_token = ?, upload_protocol = ?,
           ciphertext_sha256 = ?, ciphertext_byte_length = ?,
           upload_attempt_token = NULL, upload_attempt_expires_at = NULL, updated_at = ?
       WHERE tenant_id = ? AND upload_id = ? AND status = 'sealed'
         AND (finalization_id IS NULL OR finalization_id = ?)
         AND upload_attempt_token = ? AND upload_attempt_expires_at > ?
         AND expiry_claim_token IS NULL
         AND EXISTS (
           SELECT 1 FROM artifact_intake_finalizations f
           WHERE f.tenant_id = ? AND f.id = ? AND f.status = 'reserved'
             AND f.lease_owner = ? AND f.lease_expires_at > ?
         )`,
    ).bind(
      targetKey, token, ARTIFACT_UPLOAD_PROTOCOL_FENCED,
      ciphertextSha256, envelope.byteLength, adoptionNow,
      args.row.tenant_id, args.row.upload_id, args.finalizationId,
      token, adoptionNow, args.row.tenant_id, args.finalizationId,
      args.leaseOwner, adoptionNow,
    ).run()
    if (Number(adopted.meta.changes ?? 0) !== 1) {
      throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_STATE)
    }
    await clearUploadAttemptIntent(args.env, args.row.tenant_id, args.row.upload_id, token)
    const current = await getArtifactIntakeOperation(args.env, args.row.tenant_id, args.row.upload_id)
    if (!current) throw new ArtifactIntakeContractError(ARTIFACT_INTAKE_ERROR.INVALID_STATE)
    return repairAndProveImmutableArtifact({ ...args, row: current })
  } catch (error) {
    if (putSucceeded) {
      await cleanupAmbiguousPromotion(args.env, args.row, token).catch(() => undefined)
    } else if (!putAttempted) {
      await args.env.D1_US.prepare(
        `UPDATE artifact_intake_operations
         SET upload_attempt_token = NULL, upload_attempt_expires_at = NULL, updated_at = ?
         WHERE tenant_id = ? AND upload_id = ? AND upload_attempt_token = ?`,
      ).bind(Date.now(), args.row.tenant_id, args.row.upload_id, token).run().catch(() => undefined)
      await clearUploadAttemptIntent(args.env, args.row.tenant_id, args.row.upload_id, token)
        .catch(() => undefined)
    }
  // A put that threw may still commit. Preserve the exact D1 token and journal so the sweeper can fence adoption
    // and repeatedly clean the unique key after the ambiguity resolves.
    throw error
  }
}
