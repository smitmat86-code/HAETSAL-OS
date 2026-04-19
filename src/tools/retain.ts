// src/tools/retain.ts
// MCP retain tool — retains immediately so user-authored writes are available right away.

import type { RetainInput, RetainOutput } from '../types/tools'
import type { Env } from '../types/env'
import { retainContent } from '../services/ingestion/retain'

/**
 * MCP retain via direct ingestion so interactive writes are visible to Hindsight
 * without depending on the separate ingestion queue consumer.
 */
export async function retainViaService(
  input: RetainInput,
  tenantId: string,
  tmk: CryptoKey | null,
  env: Env,
  ctx?: Pick<ExecutionContext, 'waitUntil'>,
): Promise<RetainOutput> {
  console.log('MCP_RETAIN_START', {
    tenantId,
    domain: input.domain,
    memoryType: input.memory_type ?? 'episodic',
    source: input.source ?? 'mcp_retain',
  })
  if (!tmk) {
    // No TMK available — return deferred status
    console.warn('MCP_RETAIN_DEFERRED_NO_TMK', { tenantId })
    return {
      memory_id: '',
      salience_tier: 0,
      status: 'deferred',
    }
  }

  const result = await retainContent({
    tenantId,
    source: input.source ?? 'mcp_retain',
    sourceRef: input.source_ref ?? null,
    content: input.content,
    occurredAt: Date.now(),
    memoryType: input.memory_type,
    domain: input.domain,
    provenance: input.provenance ?? 'mcp_retain',
    artifactRef: input.artifact_ref ?? null,
    metadata: input.metadata ?? {
      ...(input.title ? { title: input.title } : {}),
    },
  }, tmk, env, ctx, { hindsightAsync: true })

  console.log('MCP_RETAIN_DONE', {
    tenantId,
    memoryId: result?.memoryId ?? null,
    salienceTier: result?.salienceTier ?? null,
  })

  return {
    memory_id: result?.memoryId ?? '',
    salience_tier: result?.salienceTier ?? 0,
    status: result ? 'queued' : 'deferred',
    canonical_capture_id: result?.canonicalCaptureId ?? undefined,
    canonical_document_id: result?.canonicalDocumentId ?? undefined,
    canonical_operation_id: result?.canonicalOperationId ?? undefined,
    dispatch_status: result?.canonicalDispatchStatus ?? undefined,
    compatibility_status: result?.compatibilityStatus ?? undefined,
  }
}
