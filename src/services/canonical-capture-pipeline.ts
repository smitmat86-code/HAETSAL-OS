import type { Env } from '../types/env'
import type {
  CanonicalCapturePipelineResult,
  CanonicalPipelineCaptureInput,
} from '../types/canonical-capture-pipeline'
import { maybeTriggerCompiledRefresh } from './canonical-compiled-refresh-trigger'
import { captureCanonicalMemory } from './canonical-memory'
import { getCanonicalMemoryStore } from './canonical-postgres'
import {
  enqueueCanonicalProjectionDispatch,
  markCanonicalProjectionDispatchFailed,
} from './canonical-projection-dispatch'
import { embedTexts } from './retrieval-support'
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

  // Chunk embeddings for pgvector semantic retrieval (Phase 2). Best-effort:
  // failures never block the capture; missing embeddings degrade semantic
  // search to lexical until a backfill runs.
  const embedTask = (async () => {
    const embeddings = await embedTexts(env, capture.chunkTexts.map((chunk) => chunk.text))
    if (!embeddings) return
    await getCanonicalMemoryStore(env).updateChunkEmbeddings(tenantId, capture.chunkTexts.map((chunk, index) => ({
      chunkId: chunk.id,
      embedding: embeddings[index]!,
    })))
  })().catch((error) => {
    console.warn('CANONICAL_CHUNK_EMBEDDING_FAILED', {
      tenantId,
      captureId: capture.captureId,
      error: error instanceof Error ? error.message : String(error),
    })
  })
  if (ctx?.waitUntil) ctx.waitUntil(embedTask)
  else await embedTask

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

  // Projection engines are retired (Hindsight: Phase 1, Graphiti: Phase 2).
  // With no projection kinds there is nothing to materialize or dispatch;
  // future projections (e.g. AI Search) re-enter through this seam.
  let dispatchStatus: 'queued' | 'skipped' = 'skipped'
  if (capture.projectionKinds.length > 0) {
    try {
      await enqueueCanonicalProjectionDispatch(message, env)
      dispatchStatus = 'queued'
      if (input.eagerProjectionDispatch) {
        await processCanonicalProjectionDispatch(message.tenantId, message.payload, env, ctx)
      }
    } catch (error) {
      await markCanonicalProjectionDispatchFailed(message, env, error)
      throw error
    }
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
      status: dispatchStatus,
      message,
    },
  }
}
