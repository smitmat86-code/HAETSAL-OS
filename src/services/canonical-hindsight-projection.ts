import type { Env } from '../types/env'
import type {
  HindsightProjectionDispatchInput,
  HindsightProjectionSubmissionResult,
} from '../types/canonical-capture-pipeline'
import { ensureHindsightBankConfigured } from './bootstrap/hindsight-config'
import {
  buildExpectedHindsightDocumentId,
  materializeHindsightProjectionPayload,
  projectionAlreadySubmitted,
  readProjectionJobContext,
  readProjectionPayload,
  resolveProjectionSourceRef,
  toHindsightArtifact,
} from './canonical-hindsight-projection-payload'
import { recordHindsightProjectionState } from './canonical-hindsight-projection-state'
import { retainMemory } from './hindsight'
import {
  persistQueuedRetain,
  persistRetained,
  scheduleQueuedRetainFollowUps,
} from './ingestion/retain-persistence'
import { buildHindsightRetainRequest } from './ingestion/retain-request'

export { materializeHindsightProjectionPayload }

export async function submitHindsightProjection(
  input: HindsightProjectionDispatchInput,
  env: Env,
  ctx?: Pick<ExecutionContext, 'waitUntil'>,
): Promise<HindsightProjectionSubmissionResult | null> {
  const row = await readProjectionJobContext(env, input.tenantId, input)
  if (await projectionAlreadySubmitted(env, input.tenantId, row.id)) return null
  const plannedDocumentId = buildExpectedHindsightDocumentId(
    input.tenantId,
    row.source_system,
    row.source_ref,
    row.capture_id,
  )

  try {
    const payload = await readProjectionPayload(env, input.tenantId, row.capture_id)
    const dedupHash = resolveProjectionSourceRef(row)
    const artifact = toHindsightArtifact(input.tenantId, row, payload)
    await recordHindsightProjectionState({
      env,
      tenantId: input.tenantId,
      job: row,
      jobStatus: 'queued',
      resultStatus: 'queued',
      submission: { bankId: null, documentId: plannedDocumentId, operationId: null },
      auditAction: 'memory.projection.hindsight_started',
    })
    await ensureHindsightBankConfigured(input.tenantId, input.tenantId, env)

    const { documentId, request } = buildHindsightRetainRequest(
      artifact,
      dedupHash,
      payload.memoryType,
      row.scope,
      payload.salienceTier,
      true,
    )
    const response = await retainMemory(input.tenantId, request, env)
    const submission: HindsightProjectionSubmissionResult = {
      targetRef: response.operation_id
        ? `hindsight://banks/${response.bank_id}/documents/${documentId}/operations/${response.operation_id}`
        : `hindsight://banks/${response.bank_id}/documents/${documentId}`,
      bankId: response.bank_id ?? null,
      documentId,
      operationId: response.operation_id ?? null,
      status: response.operation_id ? 'queued' : 'completed',
    }

    if (submission.status === 'queued') {
      await persistQueuedRetain({
        artifact,
        env,
        dedupHash,
        stoneR2Key: row.body_r2_key,
        memoryType: payload.memoryType,
        domain: row.scope,
        salienceTier: payload.salienceTier,
        salienceSurpriseScore: payload.salienceSurpriseScore,
        documentId,
        hindsightData: response,
        memoryId: documentId,
        operationId: submission.operationId,
      })
      await scheduleQueuedRetainFollowUps({
        env,
        tenantId: input.tenantId,
        operationId: submission.operationId,
        memoryId: documentId,
        ctx,
      })
    } else {
      await persistRetained({
        artifact,
        env,
        dedupHash,
        stoneR2Key: row.body_r2_key,
        memoryType: payload.memoryType,
        domain: row.scope,
        salienceTier: payload.salienceTier,
        salienceSurpriseScore: payload.salienceSurpriseScore,
        memoryId: documentId,
      })
    }

    await recordHindsightProjectionState({
      env,
      tenantId: input.tenantId,
      job: row,
      jobStatus: submission.status,
      resultStatus: submission.status,
      submission,
      auditAction: submission.status === 'completed'
        ? 'memory.projection.hindsight_completed'
        : 'memory.projection.hindsight_queued',
    })
    return submission
  } catch (error) {
    await recordHindsightProjectionState({
      env,
      tenantId: input.tenantId,
      job: row,
      jobStatus: 'failed',
      resultStatus: 'failed',
      submission: { bankId: null, documentId: plannedDocumentId, operationId: null },
      errorMessage: error instanceof Error ? error.message : String(error),
      auditAction: 'memory.projection.hindsight_failed',
    })
    throw error
  }
}
