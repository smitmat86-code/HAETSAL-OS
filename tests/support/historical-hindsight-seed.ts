import type { Env } from '../../src/types/env'
import { getCanonicalMemoryStore } from '../../src/services/canonical-postgres'
import { sha256Hex } from '../../src/services/canonical-memory-artifacts'
import type { CanonicalCaptureWrite } from '../../src/services/canonical-postgres-schema'
import { encryptContentForArchive } from '../../src/services/ingestion/encryption'

/**
 * Seeds a HISTORICAL Hindsight projection: a canonical capture that was
 * projected to Hindsight before the write path was severed
 * (HAETSAL_MISSION.md Phase 1). The pipeline can no longer produce these,
 * so tests that need semantic-mode fixtures build the record directly via
 * `writeCapture` (which does not validate projection kinds) and then mark
 * the hindsight projection job completed via `recordProjectionState`.
 *
 * This is independent of any real (graphiti) capture the test may also run
 * for the same body/title — the two are unrelated canonical rows, exactly
 * as they would have been pre-cutover when both projections ran off the
 * same source event but Hindsight had its own bank-side document id.
 */
export interface HistoricalHindsightSeedInput {
  tenantId: string
  sourceSystem: string
  sourceRef?: string | null
  scope: string
  title?: string | null
  body: string
  capturedAt?: number | null
  /** Required so the stored body decrypts like any other canonical document (raw mode reads it too). */
  tmk: CryptoKey
  /** Defaults to a fresh random id; pass one in to control fixture recall lookups. */
  engineDocumentId?: string
  engineOperationId?: string | null
  engineBankId?: string | null
}

export interface HistoricalHindsightSeedResult {
  captureId: string
  documentId: string
  operationId: string
  projectionJobId: string
  engineDocumentId: string
}

export async function seedHistoricalHindsightProjection(
  env: Env,
  input: HistoricalHindsightSeedInput,
): Promise<HistoricalHindsightSeedResult> {
  const now = Date.now()
  const capturedAt = input.capturedAt ?? now
  const captureId = crypto.randomUUID()
  const documentId = crypto.randomUUID()
  const operationId = crypto.randomUUID()
  const projectionJobId = crypto.randomUUID()
  const chunkId = crypto.randomUUID()
  const engineDocumentId = input.engineDocumentId ?? crypto.randomUUID()
  const bodySha256 = await sha256Hex(input.body)
  const bodyR2Key = `canonical/${input.tenantId}/documents/${documentId}.enc`
  const bodyEncrypted = await encryptContentForArchive(input.body, input.tmk)

  await env.R2_ARTIFACTS.put(bodyR2Key, bodyEncrypted)

  const write: CanonicalCaptureWrite = {
    capture: {
      id: captureId,
      tenant_id: input.tenantId,
      source_system: input.sourceSystem,
      source_ref: input.sourceRef ?? null,
      scope: input.scope,
      title: input.title ?? null,
      body_r2_key: bodyR2Key,
      body_sha256: bodySha256,
      artifact_id: null,
      captured_at: capturedAt,
      created_at: now,
      memory_class: 'raw_source',
      trust_state: 'evidence',
      use_policy: 'can_use_as_evidence',
      author_kind: 'system',
      agent_identity: null,
      model_runtime: null,
      confidence: null,
      retention: 'standard',
      provenance_note: 'historical-hindsight-seed',
      memory_type: 'episodic',
      dedup_hash: null,
      salience_tier: null,
      governance_downgraded_json: null,
    },
    artifact: null,
    document: {
      id: documentId,
      tenant_id: input.tenantId,
      capture_id: captureId,
      artifact_id: null,
      title: input.title ?? null,
      body_r2_key: bodyR2Key,
      body_sha256: bodySha256,
      chunk_count: 1,
      created_at: now,
    },
    chunks: [{
      id: chunkId,
      tenant_id: input.tenantId,
      document_id: documentId,
      ordinal: 0,
      start_offset: 0,
      end_offset: input.body.length,
      chunk_sha256: bodySha256,
      chunk_text: input.body,
      created_at: now,
    }],
    operation: {
      id: operationId,
      tenant_id: input.tenantId,
      capture_id: captureId,
      operation_type: 'capture.accepted',
      status: 'accepted',
      created_at: now,
      updated_at: now,
    },
    projectionJobs: [{
      id: projectionJobId,
      tenant_id: input.tenantId,
      operation_id: operationId,
      capture_id: captureId,
      document_id: documentId,
      projection_kind: 'hindsight',
      status: 'accepted',
      created_at: now,
      enqueued_at: now,
    }],
    event: null,
  }

  const store = getCanonicalMemoryStore(env)
  await store.writeCapture(write)
  await store.recordProjectionState({
    tenantId: input.tenantId,
    jobId: projectionJobId,
    operationId,
    jobStatus: 'completed',
    resultStatus: 'completed',
    targetRef: `hindsight://documents/${engineDocumentId}`,
    engineDocumentId,
    engineOperationId: input.engineOperationId ?? null,
    engineBankId: input.engineBankId ?? null,
    updatedAt: now,
  })

  return { captureId, documentId, operationId, projectionJobId, engineDocumentId }
}
