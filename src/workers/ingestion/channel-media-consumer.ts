import type { Env } from '../../types/env'
import type { IngestionQueueMessage } from '../../types/ingestion'
import { fetchAndValidateKek } from '../../cron/kek'
import { ArtifactIntakeContractError } from '../../services/artifact-intake/contracts'
import { processChannelMediaJob } from '../../services/channel-media/orchestrator'

export async function processChannelMediaMessage(
  msg: Message<IngestionQueueMessage>,
  tmk: CryptoKey,
  env: Env,
): Promise<void> {
  const { tenantId, payload } = msg.body
  const operationId = typeof payload.operationId === 'string' ? payload.operationId : ''
  try {
    const kek = await fetchAndValidateKek(tenantId, env)
    if (!kek) {
      console.warn('CHANNEL_MEDIA_WAITING_FOR_KEY')
      msg.retry({ delaySeconds: 30 })
      return
    }
    await processChannelMediaJob({ tenantId, operationId, tmk, kek, env })
    msg.ack()
  } catch (error) {
    const code = error instanceof ArtifactIntakeContractError ? error.code : 'invalid_state'
    console.warn('CHANNEL_MEDIA_JOB_RETRY', { code })
    msg.retry({ delaySeconds: 30 })
  }
}
