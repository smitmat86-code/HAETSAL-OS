import type { Env } from '../../types/env'
import { ARTIFACT_CIPHERTEXT_ENVELOPE_OVERHEAD_BYTES } from './config'
import { sha256Bytes, unsealArtifactBytes } from './crypto'
import type { ArtifactIntakeOperationRow } from './operations'
import { readManagedArtifactCiphertext } from './storage'
import { expectedManagedArtifactKey } from './storage-keys'

/**
 * Plaintext-verified convergence repair for a sealed row whose recorded
 * ciphertext identity authoritatively disagrees with the object at its one
 * legitimate key. During the mixed old/new rollout window, the shipped old
 * Worker's put and unconditional D1 seal are separate operations with no
 * bounded lifetime, so a shared legacy key can end up holding one writer's
 * independently randomized ciphertext while D1 records the other's hash.
 * Every writer proves the row's exact plaintext hash before writing, so any
 * genuine object at the expected key decrypts to the same plaintext; this
 * repair re-reads the bounded object, proves that plaintext identity, and
 * CAS-updates D1 onto the object's actual ciphertext identity. It can never
 * converge onto wrong content, never touches finalized/bound/claimed rows,
 * and works for fenced rows too (their adopted attempt object is immutable,
 * so a clobbered D1 hash is restored from the true object). Safety therefore
 * does not depend on any assumption about when old requests end.
 */
export async function convergeSealedCiphertextIdentity(
  env: Env,
  row: ArtifactIntakeOperationRow,
  key: CryptoKey,
  family: 'tmk' | 'kek',
  allowedFinalizationId: string | null = null,
): Promise<boolean> {
  if (
    row.status !== 'sealed' || row.finalization_id !== allowedFinalizationId ||
    row.expiry_claim_token !== null || !row.ciphertext_sha256
  ) {
    return false
  }
  const expectedKey = await expectedManagedArtifactKey(
    row.tenant_id, row.upload_id, row.adopted_attempt_token,
  )
  if (row.r2_key !== expectedKey) return false
  try {
    // Both writers sealed the identical plaintext, so a genuine object is
    // exactly the plaintext length plus the sealed-envelope overhead;
    // anything else is rejected before a single body byte is materialized.
    // Peak transient allocation is one bounded ciphertext plus its plaintext
    // (~2x ARTIFACT_MAX_BYTES), sequential with the upload path's own body.
    const envelope = await readManagedArtifactCiphertext(
      env, expectedKey,
      Number(row.byte_length) + ARTIFACT_CIPHERTEXT_ENVELOPE_OVERHEAD_BYTES,
    )
    if (!envelope) return false
    const plaintext = await unsealArtifactBytes(envelope, key, family)
    if (await sha256Bytes(plaintext) !== row.plaintext_sha256) return false
    const actualCiphertextSha256 = await sha256Bytes(envelope)
    const now = Date.now()
    const result = await env.D1_US.prepare(
      `UPDATE artifact_intake_operations
       SET ciphertext_sha256 = ?, ciphertext_byte_length = ?, encryption_family = ?, updated_at = ?
       WHERE tenant_id = ? AND upload_id = ? AND status = 'sealed'
         AND ciphertext_sha256 = ? AND r2_key = ?
         AND finalization_id IS ? AND expiry_claim_token IS NULL`,
    ).bind(
      actualCiphertextSha256, envelope.byteLength, family, now,
      row.tenant_id, row.upload_id, row.ciphertext_sha256, row.r2_key,
      allowedFinalizationId,
    ).run()
    return Number(result.meta.changes ?? 0) === 1
  } catch {
    // Read, unseal, or D1 failure: converge nothing; the caller keeps its
    // original authoritative-mismatch outcome and may retry later.
    return false
  }
}
