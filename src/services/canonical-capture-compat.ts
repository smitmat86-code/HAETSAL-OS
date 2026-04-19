import type { Env } from '../types/env'
import type {
  CanonicalPipelineCaptureInput,
  CompatibilityRetainResult,
} from '../types/canonical-capture-pipeline'
import type { IngestionArtifact } from '../types/ingestion'
import {
  recordCompatibilityState,
  toCompatibilityResult,
} from './canonical-capture-compat-state'
import { ensureHindsightBankConfigured } from './bootstrap/hindsight-config'
import { retainMemory } from './hindsight'
import {
  archiveEncryptedContent,
  persistQueuedRetain,
  persistRetained,
  scheduleQueuedRetainFollowUps,
} from './ingestion/retain-persistence'
import { buildHindsightRetainRequest } from './ingestion/retain-request'

export async function runCompatibilityRetainBridge(
  input: CanonicalPipelineCaptureInput,
  env: Env,
  tenantId: string,
  ctx?: Pick<ExecutionContext, 'waitUntil'>,
): Promise<CompatibilityRetainResult> {
  if ((input.compatibilityMode ?? 'current_hindsight') === 'off') {
    return toCompatibilityResult('off', 'skipped', null, null, null, null)
  }
  if (!input.bodyEncrypted?.trim()) {
    throw new Error('Compatibility retain bridge requires bodyEncrypted')
  }
  if (!input.canonicalOperationId) {
    throw new Error('Compatibility retain bridge requires canonicalOperationId')
  }

  const artifact: IngestionArtifact = {
    tenantId,
    source: input.sourceSystem,
    content: input.body,
    occurredAt: input.capturedAt ?? Date.now(),
    memoryType: input.memoryType,
    domain: input.scope,
    provenance: input.provenance ?? input.sourceSystem,
    metadata: input.metadata,
  }
  const dedupHash = input.dedupHash ?? crypto.randomUUID()
  const salienceTier = input.salienceTier ?? 1
  const stoneR2Key = await archiveEncryptedContent(env, tenantId, input.bodyEncrypted, ctx)
  const { documentId, request } = buildHindsightRetainRequest(
    artifact,
    dedupHash,
    input.memoryType ?? 'episodic',
    input.scope,
    salienceTier,
    input.hindsightAsync ?? false,
  )

  await ensureHindsightBankConfigured(tenantId, tenantId, env)

  try {
    const hindsightData = await retainMemory(tenantId, request, env)
    const memoryId = hindsightData.operation_id ?? documentId
    const operationId = hindsightData.operation_id ?? null

    if (request.async) {
      await persistQueuedRetain({
        artifact,
      env,
      dedupHash,
      stoneR2Key,
      memoryType: input.memoryType ?? 'episodic',
      domain: input.scope,
      salienceTier,
      salienceSurpriseScore: input.salienceSurpriseScore ?? 0.5,
      documentId,
      hindsightData,
      memoryId,
      operationId,
      })
      await scheduleQueuedRetainFollowUps({ env, tenantId, operationId, memoryId, ctx })
      const result = toCompatibilityResult('current_hindsight', 'queued', memoryId, operationId, documentId, stoneR2Key)
      await recordCompatibilityState(env, tenantId, input.canonicalOperationId, result)
      return result
    }

    await persistRetained({
      artifact,
      env,
      dedupHash,
      stoneR2Key,
      memoryType: input.memoryType ?? 'episodic',
      domain: input.scope,
      salienceTier,
      salienceSurpriseScore: input.salienceSurpriseScore ?? 0.5,
      memoryId,
    })
    const result = toCompatibilityResult('current_hindsight', 'retained', memoryId, operationId, documentId, stoneR2Key)
    await recordCompatibilityState(env, tenantId, input.canonicalOperationId, result)
    return result
  } catch (error) {
    const result = toCompatibilityResult(
      'current_hindsight',
      'failed',
      null,
      null,
      null,
      stoneR2Key,
      error instanceof Error ? error.message : String(error),
    )
    await recordCompatibilityState(env, tenantId, input.canonicalOperationId, result)
    throw error
  }
}
