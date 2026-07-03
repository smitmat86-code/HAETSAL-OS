import type { Env } from '../types/env'
import type {
  CanonicalCapturePipelineResult,
  CanonicalPipelineCaptureInput,
} from '../types/canonical-capture-pipeline'
import { maybeTriggerCompiledRefresh } from './canonical-compiled-refresh-trigger'
import { materializeGraphitiProjectionPayload } from './canonical-graphiti-projection'
import { captureCanonicalMemory } from './canonical-memory'
import {
  enqueueCanonicalProjectionDispatch,
  markCanonicalProjectionDispatchFailed,
} from './canonical-projection-dispatch'
import { processCanonicalProjectionDispatch } from '../workers/ingestion/canonical-projection-consumer'

export async function captureThroughCanonicalPipeline(
  input: CanonicalPipelineCaptureInput,
  env: Env,
  tenantId: string,
  ctx?: Pick<ExecutionContext, 'waitUntil'>,
  tmk: CryptoKey | null = null,
): Promise<CanonicalCapturePipelineResult> {
  const capture = await captureCanonicalMemory({
    tenantId: input.tenantId,
    sourceSystem: input.sourceSystem,
    sourceRef: input.sourceRef ?? null,
    scope: input.scope,
    title: input.title ?? null,
    body: input.body,
    bodyEncrypted: input.bodyEncrypted ?? null,
    artifactRef: input.artifactRef ?? null,
    capturedAt: input.capturedAt ?? null,
    projectionKinds: input.projectionKinds ?? null,
    governance: {
      ...input.governance,
      legacyMemoryType: input.governance?.legacyMemoryType ?? input.memoryType ?? null,
      provenanceNote: input.governance?.provenanceNote ?? input.provenance ?? null,
      dedupHash: input.governance?.dedupHash ?? input.dedupHash ?? null,
      salienceTier: input.governance?.salienceTier ?? input.salienceTier ?? null,
    },
  }, env, tenantId)

  const message = {
    type: 'canonical_projection_dispatch' as const,
    tenantId,
    payload: {
      captureId: capture.captureId,
      documentId: capture.documentId,
      operationId: capture.operationId,
      projectionKinds: capture.projectionKinds,
    },
    enqueuedAt: Date.now(),
  }

  const projectionInput = {
    ...input,
    canonicalCaptureId: capture.captureId,
    canonicalDocumentId: capture.documentId,
    canonicalOperationId: capture.operationId,
  }
  if (capture.projectionKinds.includes('graphiti')) {
    try {
      await materializeGraphitiProjectionPayload(projectionInput, capture.captureId, env)
    } catch (error) {
      console.error('GRAPHITI_PROJECTION_PAYLOAD_MATERIALIZE_FAILED', {
        tenantId,
        captureId: capture.captureId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  try {
    await enqueueCanonicalProjectionDispatch(message, env)
    if (input.eagerProjectionDispatch) {
      await processCanonicalProjectionDispatch(message.tenantId, message.payload, env, ctx)
    }
  } catch (error) {
    await markCanonicalProjectionDispatchFailed(message, env, error)
    throw error
  }

  await maybeTriggerCompiledRefresh({
    tenantId,
    scope: input.scope,
    sourceSystem: input.sourceSystem,
    sourceRef: input.sourceRef ?? null,
    title: input.title ?? null,
    body: input.body,
    captureId: capture.captureId,
    documentId: capture.documentId,
    artifactId: capture.artifactId,
    operationId: capture.operationId,
    tmk,
  }, env, ctx)

  return {
    capture: {
      ...capture,
      projectionKinds: capture.projectionKinds,
    },
    dispatch: {
      queue: 'QUEUE_BULK',
      status: 'queued',
      message,
    },
  }
}
