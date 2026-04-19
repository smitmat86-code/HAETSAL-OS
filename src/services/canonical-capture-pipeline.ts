import type { Env } from '../types/env'
import type {
  CanonicalCapturePipelineResult,
  CanonicalPipelineCaptureInput,
} from '../types/canonical-capture-pipeline'
import { materializeHindsightProjectionPayload } from './canonical-hindsight-projection'
import { captureCanonicalMemory } from './canonical-memory'
import { CANONICAL_PROJECTION_KINDS } from './canonical-memory-schema'
import {
  enqueueCanonicalProjectionDispatch,
  markCanonicalProjectionDispatchFailed,
} from './canonical-projection-dispatch'
import { runCompatibilityRetainBridge } from './canonical-capture-compat'

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

  await materializeHindsightProjectionPayload({
    ...input,
    canonicalCaptureId: capture.captureId,
    canonicalDocumentId: capture.documentId,
    canonicalOperationId: capture.operationId,
  }, capture.captureId, env).catch((error) => {
    console.error('HINDSIGHT_PROJECTION_PAYLOAD_MATERIALIZE_FAILED', {
      tenantId,
      captureId: capture.captureId,
      error: error instanceof Error ? error.message : String(error),
    })
  })

  try {
    await enqueueCanonicalProjectionDispatch(message, env)
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
