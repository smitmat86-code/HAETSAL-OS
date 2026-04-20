import { decryptWithKek, encryptWithKek, fetchAndValidateKek } from '../cron/kek'
import type { Env } from '../types/env'
import type {
  CanonicalPipelineCaptureInput,
  HindsightProjectionDispatchInput,
} from '../types/canonical-capture-pipeline'
import type { IngestionArtifact, IngestionSource } from '../types/ingestion'
import { buildHindsightDocumentId } from './hindsight'

export interface ProjectionJobContext {
  id: string
  operation_id: string
  capture_id: string
  document_id: string
  source_system: IngestionSource
  source_ref: string | null
  scope: string
  captured_at: number
  body_r2_key: string
}

export interface HindsightProjectionPayload {
  body: string
  memoryType: 'episodic' | 'semantic' | 'world'
  provenance: string
  metadata?: Record<string, unknown>
  salienceTier: 1 | 2 | 3
  salienceSurpriseScore: number
}

function projectionPayloadKey(tenantId: string, captureId: string): string {
  return `canonical/${tenantId}/projections/hindsight/${captureId}.enc`
}

export function resolveProjectionSourceRef(
  row: Pick<ProjectionJobContext, 'source_system' | 'source_ref' | 'capture_id'>,
): string {
  if (
    row.source_system === 'mcp:memory_write'
    && row.source_ref?.startsWith('brain-memory:')
  ) {
    return row.capture_id
  }
  return row.source_ref?.trim() || row.capture_id
}

export function buildExpectedHindsightDocumentId(
  tenantId: string,
  sourceSystem: string,
  sourceRef: string | null,
  captureId: string,
): string {
  return buildHindsightDocumentId(tenantId, sourceSystem, sourceRef?.trim() || captureId)
}

export function toHindsightArtifact(
  tenantId: string,
  row: ProjectionJobContext,
  payload: HindsightProjectionPayload,
): IngestionArtifact {
  return {
    tenantId,
    source: row.source_system,
    content: payload.body,
    occurredAt: row.captured_at,
    memoryType: payload.memoryType,
    domain: row.scope,
    provenance: payload.provenance,
    metadata: payload.metadata,
  }
}

export async function readProjectionJobContext(
  env: Env,
  tenantId: string,
  input: HindsightProjectionDispatchInput,
): Promise<ProjectionJobContext> {
  const row = await env.D1_US.prepare(
    `SELECT j.id, j.operation_id, j.capture_id, j.document_id, c.source_system, c.source_ref,
            c.scope, c.captured_at, c.body_r2_key
     FROM canonical_projection_jobs j
     INNER JOIN canonical_captures c ON c.id = j.capture_id
     WHERE j.tenant_id = ? AND j.id = ? AND j.projection_kind = 'hindsight'
     LIMIT 1`,
  ).bind(tenantId, input.projectionJobId).first<ProjectionJobContext>()
  if (!row) throw new Error(`Missing hindsight projection job ${input.projectionJobId}`)
  return row
}

export async function readProjectionPayload(
  env: Env,
  tenantId: string,
  captureId: string,
): Promise<HindsightProjectionPayload> {
  const kek = await fetchAndValidateKek(tenantId, env)
  if (!kek) throw new Error(`Missing tenant KEK for hindsight projection ${captureId}`)
  const stored = await env.R2_ARTIFACTS.get(projectionPayloadKey(tenantId, captureId))
  if (!stored) throw new Error(`Missing hindsight projection payload for ${captureId}`)
  return JSON.parse(await decryptWithKek(await stored.text(), kek)) as HindsightProjectionPayload
}

export async function projectionAlreadySubmitted(
  env: Env,
  tenantId: string,
  projectionJobId: string,
): Promise<boolean> {
  const row = await env.D1_US.prepare(
    `SELECT engine_bank_id, engine_operation_id, status
     FROM canonical_projection_results
     WHERE tenant_id = ? AND projection_job_id = ?
     ORDER BY updated_at DESC, created_at DESC, id DESC
     LIMIT 1`,
  ).bind(tenantId, projectionJobId).first<{
    engine_bank_id: string | null
    engine_operation_id: string | null
    status: string | null
  }>()
  return Boolean(
    row && row.status !== 'failed' &&
    (row.engine_bank_id || row.engine_operation_id || row.status === 'completed'),
  )
}

export async function materializeHindsightProjectionPayload(
  input: CanonicalPipelineCaptureInput,
  captureId: string,
  env: Env,
): Promise<void> {
  const kek = await fetchAndValidateKek(input.tenantId, env)
  if (!kek) return
  const ciphertext = await encryptWithKek(JSON.stringify({
    body: input.body,
    memoryType: input.memoryType ?? 'episodic',
    provenance: input.provenance ?? input.sourceSystem,
    metadata: input.metadata,
    salienceTier: input.salienceTier ?? 1,
    salienceSurpriseScore: input.salienceSurpriseScore ?? 0.5,
  } satisfies HindsightProjectionPayload), kek)
  await env.R2_ARTIFACTS.put(projectionPayloadKey(input.tenantId, captureId), ciphertext)
}
