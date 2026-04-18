import type { Env } from '../../types/env'
import type { IngestionArtifact, QueuedRetainPayload } from '../../types/ingestion'
import { retainContent } from '../../services/ingestion/retain'

export async function processQueuedRetainArtifact(
  tenantId: string,
  payload: Record<string, unknown>,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const retainPayload = payload as unknown as QueuedRetainPayload
  const artifact = {
    ...(retainPayload.artifact as Omit<IngestionArtifact, 'tenantId'>),
    tenantId,
  } satisfies IngestionArtifact

  await retainContent(artifact, null, env, ctx, {
    contentEncrypted: retainPayload.contentEncrypted,
  })
}
