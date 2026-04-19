import type { Env } from '../types/env'
import type {
  CanonicalPipelineCaptureInput,
  CompatibilityRetainResult,
} from '../types/canonical-capture-pipeline'
import { buildExpectedHindsightDocumentId } from './canonical-hindsight-projection-payload'

export async function runCompatibilityRetainBridge(
  input: CanonicalPipelineCaptureInput,
  env: Env,
  tenantId: string,
): Promise<CompatibilityRetainResult> {
  if ((input.compatibilityMode ?? 'current_hindsight') === 'off') {
    return {
      mode: 'off',
      status: 'skipped',
      memoryId: null,
      operationId: null,
      documentId: null,
      stoneR2Key: null,
      errorMessage: null,
    }
  }
  if (!input.canonicalCaptureId || !input.canonicalOperationId) {
    throw new Error('Compatibility projection shim requires canonical ids')
  }
  const body = await env.D1_US.prepare(
    `SELECT body_r2_key
     FROM canonical_captures
     WHERE tenant_id = ? AND id = ?
     LIMIT 1`,
  ).bind(tenantId, input.canonicalCaptureId).first<{ body_r2_key: string | null }>()
  const documentId = buildExpectedHindsightDocumentId(
    input.tenantId,
    input.sourceSystem,
    input.sourceRef ?? null,
    input.canonicalCaptureId,
  )
  return {
    mode: 'current_hindsight',
    status: 'queued',
    memoryId: documentId,
    operationId: null,
    documentId,
    stoneR2Key: body?.body_r2_key ?? null,
    errorMessage: null,
  }
}
