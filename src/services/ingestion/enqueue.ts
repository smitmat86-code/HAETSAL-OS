import type { Env } from '../../types/env'
import type { IngestionArtifact } from '../../types/ingestion'
import { scoreSalience } from './salience'
import { encryptContentForArchive } from './encryption'

type RetainQueueName = 'QUEUE_HIGH' | 'QUEUE_NORMAL'

export interface EnqueuedRetainResult {
  requestId: string
  queue: RetainQueueName
  salienceTier: 1 | 2 | 3
}

function getQueueBinding(queue: RetainQueueName, env: Env): Queue {
  return queue === 'QUEUE_HIGH' ? env.QUEUE_HIGH : env.QUEUE_NORMAL
}

export async function enqueueRetainArtifact(
  artifact: IngestionArtifact,
  env: Env,
  ctx?: ExecutionContext,
  tmk?: CryptoKey | null,
): Promise<EnqueuedRetainResult> {
  const { tenantId, ...artifactWithoutTenant } = artifact
  const salience = scoreSalience(artifact)
  const queue = salience.queue
  const requestId = crypto.randomUUID()
  const contentEncrypted = tmk
    ? await encryptContentForArchive(artifact.content, tmk)
    : undefined
  const message = {
    type: 'retain_artifact' as const,
    tenantId,
    payload: {
      requestId,
      artifact: artifactWithoutTenant,
      contentEncrypted,
    },
    enqueuedAt: Date.now(),
  }

  const sendPromise = getQueueBinding(queue, env).send(message)
  if (ctx) {
    ctx.waitUntil(sendPromise)
  } else {
    await sendPromise
  }

  return {
    requestId,
    queue,
    salienceTier: salience.tier,
  }
}
