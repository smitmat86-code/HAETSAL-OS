import type { Env } from '../types/env'
import type {
  CanonicalCapturePipelineResult,
  CanonicalPipelineCaptureInput,
} from '../types/canonical-capture-pipeline'
import { materializeGraphitiProjectionPayload } from './canonical-graphiti-projection'
import { materializeHindsightProjectionPayload } from './canonical-hindsight-projection'
import { captureCanonicalMemory } from './canonical-memory'
import { CANONICAL_PROJECTION_KINDS } from './canonical-memory-schema'
import {
  enqueueCanonicalProjectionDispatch,
  markCanonicalProjectionDispatchFailed,
} from './canonical-projection-dispatch'
import { runCompatibilityRetainBridge } from './canonical-capture-compat'
import { processCanonicalProjectionDispatch } from '../workers/ingestion/canonical-projection-consumer'

export async function captureThroughCanonicalPipeline(
  input: CanonicalPipelineCaptureInput,
  env: Env,
  tenantId: string,
  ctx?: Pick<ExecutionContext, 'waitUntil'>,
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
  }, env, tenantId)

  const message = {
    type: 'canonical_projection_dispatch' as const,
    tenantId,
    payload: {
      captureId: capture.captureId,
      documentId: capture.documentId,
      operationId: capture.operationId,
      projectionKinds: CANONICAL_PROJECTION_KINDS,
    },
    enqueuedAt: Date.now(),
  }

  const projectionInput = {
    ...input,
    canonicalCaptureId: capture.captureId,
    canonicalDocumentId: capture.documentId,
    canonicalOperationId: capture.operationId,
  }
  await Promise.allSettled([
    materializeHindsightProjectionPayload(projectionInput, capture.captureId, env),
    materializeGraphitiProjectionPayload(projectionInput, capture.captureId, env),
  ]).then((results) => {
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') return
      const lane = index === 0 ? 'HINDSIGHT' : 'GRAPHITI'
      console.error(`${lane}_PROJECTION_PAYLOAD_MATERIALIZE_FAILED`, {
        tenantId,
        captureId: capture.captureId,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      })
    })
  })

  try {
    await enqueueCanonicalProjectionDispatch(message, env)
    if (input.eagerProjectionDispatch) {
      await processCanonicalProjectionDispatch(message.tenantId, message.payload, env, ctx)
    }
  } catch (error) {
    await markCanonicalProjectionDispatchFailed(message, env, error)
    throw error
  }

  const compatibility = await runCompatibilityRetainBridge({
    ...input,
    canonicalCaptureId: capture.captureId,
    canonicalDocumentId: capture.documentId,
    canonicalOperationId: capture.operationId,
  }, env, tenantId)

  return {
    capture: {
      ...capture,
      projectionKinds: CANONICAL_PROJECTION_KINDS,
    },
    dispatch: {
      queue: 'QUEUE_BULK',
      status: 'queued',
      message,
    },
    compatibility,
  }
}
