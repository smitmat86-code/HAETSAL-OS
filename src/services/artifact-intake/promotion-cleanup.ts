import type { Env } from '../../types/env'
import { clearUploadAttemptIntent, readAttemptOwnership } from './attempt-orphans'
import type { ArtifactIntakeOperationRow } from './operations'
import { managedArtifactAttemptR2Key } from './storage'

export async function cleanupAmbiguousPromotion(
  env: Env,
  row: ArtifactIntakeOperationRow,
  token: string,
): Promise<void> {
  const ownership = await readAttemptOwnership(env, row.tenant_id, row.upload_id)
  if (!ownership) return
  if (ownership.adopted_attempt_token === token) {
    await clearUploadAttemptIntent(env, row.tenant_id, row.upload_id, token)
    return
  }
  // A promotion begins from status=sealed, so status alone never proves loss.
  // The exact token must first be absent; if it remains, a delayed adoption
  // may still commit and the tombstone/sweeper own the eventual decision.
  if (ownership.upload_attempt_token === token) return
  const key = await managedArtifactAttemptR2Key(row.tenant_id, row.upload_id, token)
  await env.R2_ARTIFACTS.delete(key)
  await clearUploadAttemptIntent(env, row.tenant_id, row.upload_id, token)
}
