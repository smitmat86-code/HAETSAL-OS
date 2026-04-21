import type { Env } from '../types/env'
import type { HindsightRecallResponse } from '../types/hindsight'
import { getCanonicalMemoryStore } from './canonical-postgres'
import { fetchDocument, getOperationStatus, recallMemory } from './hindsight'
import { resolveHindsightBankId } from './hindsight-transport'

export interface HindsightDebugInput {
  tenantId: string
  captureId?: string | null
  operationId?: string | null
  recallQuery?: string | null
  limit?: number
}

interface HindsightProjectionLookupRow {
  capture_id: string
  document_id: string
  operation_id: string
  projection_job_id: string
  projection_result_id: string
  projection_status: string
  result_status: string
  engine_document_id: string | null
  engine_operation_id: string | null
  target_ref: string | null
}

function normalizeRecallResults(response: HindsightRecallResponse): Record<string, unknown>[] {
  return [
    ...((response.results ?? []) as unknown as Record<string, unknown>[]),
    ...((response.items ?? []) as unknown as Record<string, unknown>[]),
    ...((response.memories ?? []) as unknown as Record<string, unknown>[]),
  ]
}

async function loadLatestHindsightProjection(
  env: Env,
  tenantId: string,
  args: { captureId?: string | null; operationId?: string | null },
): Promise<HindsightProjectionLookupRow | null> {
  if (!args.captureId && !args.operationId) return null
  return getCanonicalMemoryStore(env).getLatestHindsightProjection(tenantId, args) as Promise<HindsightProjectionLookupRow | null>
}

export async function debugHindsightBankState(
  input: HindsightDebugInput,
  env: Env,
): Promise<Record<string, unknown>> {
  const bankId = await resolveHindsightBankId(input.tenantId, env)
  const projection = await loadLatestHindsightProjection(env, input.tenantId, {
    captureId: input.captureId ?? null,
    operationId: input.operationId ?? null,
  })

  const remoteOperation = projection?.engine_operation_id
    ? await getOperationStatus(bankId, projection.engine_operation_id, env).catch((error) => ({
      error: error instanceof Error ? error.message : String(error),
    }))
    : null

  const remoteDocument = projection?.engine_document_id
    ? await fetchDocument(bankId, projection.engine_document_id, env).catch((error) => ({
      error: error instanceof Error ? error.message : String(error),
    }))
    : null

  const rawRecall = input.recallQuery
    ? await recallMemory(bankId, {
      query: input.recallQuery,
      budget: 'mid',
      max_tokens: Math.max((input.limit ?? 5) * 512, 1024),
      query_timestamp: new Date().toISOString(),
    }, env).then((response) => ({
      query: input.recallQuery,
      count: normalizeRecallResults(response).length,
      items: normalizeRecallResults(response).slice(0, input.limit ?? 5),
      text: response.text ?? null,
    })).catch((error) => ({
      query: input.recallQuery,
      error: error instanceof Error ? error.message : String(error),
    }))
    : null

  return {
    bankId,
    projection: projection
      ? {
        captureId: projection.capture_id,
        documentId: projection.document_id,
        operationId: projection.operation_id,
        projectionJobId: projection.projection_job_id,
        projectionResultId: projection.projection_result_id,
        projectionStatus: projection.projection_status,
        resultStatus: projection.result_status,
        engineDocumentId: projection.engine_document_id,
        engineOperationId: projection.engine_operation_id,
        targetRef: projection.target_ref,
      }
      : null,
    remoteOperation,
    remoteDocument,
    rawRecall,
  }
}
