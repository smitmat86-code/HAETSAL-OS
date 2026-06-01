import type { Env } from '../types/env'
import type {
  CanonicalPipelineCaptureInput,
  CompatibilityRetainResult,
} from '../types/canonical-capture-pipeline'
import { buildExpectedHindsightDocumentId } from './canonical-hindsight-projection-payload'
import { getCanonicalMemoryStore } from './canonical-postgres'

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
  const bodyR2Key = await getCanonicalMemoryStore(env).getCaptureBodyKey(tenantId, input.canonicalCaptureId)
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
    stoneR2Key: bodyR2Key,
    errorMessage: null,
  }
}
