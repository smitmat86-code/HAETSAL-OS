import { decryptWithKek, encryptWithKek, fetchAndValidateKek } from '../cron/kek'
import type { Env } from '../types/env'
import type { GraphitiProjectionDispatchInput } from '../types/canonical-graph-projection'
import type { CanonicalPipelineCaptureInput } from '../types/canonical-capture-pipeline'
import type { IngestionSource } from '../types/ingestion'

export interface GraphitiProjectionJobContext {
  id: string
  operation_id: string
  capture_id: string
  document_id: string
  scope: string
  source_system: IngestionSource
  source_ref: string | null
  title: string | null
  captured_at: number
  artifact_filename: string | null
  artifact_media_type: string | null
  artifact_storage_key: string | null
}

interface GraphitiProjectionPayload {
  body: string
}

function graphitiProjectionPayloadKey(tenantId: string, captureId: string): string {
  return `canonical/${tenantId}/projections/graphiti/${captureId}.enc`
}

export async function readGraphitiProjectionJobContext(
  env: Env,
  tenantId: string,
  input: GraphitiProjectionDispatchInput,
): Promise<GraphitiProjectionJobContext> {
  const row = await env.D1_US.prepare(
    `SELECT j.id, j.operation_id, j.capture_id, j.document_id, c.scope, c.source_system, c.source_ref,
            c.title, c.captured_at, a.filename AS artifact_filename, a.media_type AS artifact_media_type,
            a.r2_key AS artifact_storage_key
     FROM canonical_projection_jobs j
     INNER JOIN canonical_captures c ON c.id = j.capture_id
     LEFT JOIN canonical_artifacts a ON a.id = c.artifact_id
     WHERE j.tenant_id = ? AND j.id = ? AND j.projection_kind = 'graphiti'
     LIMIT 1`,
  ).bind(tenantId, input.projectionJobId).first<GraphitiProjectionJobContext>()
  if (!row) throw new Error(`Missing graphiti projection job ${input.projectionJobId}`)
  return row
}

export async function readGraphitiProjectionPayload(
  env: Env,
  tenantId: string,
  captureId: string,
): Promise<GraphitiProjectionPayload> {
  const kek = await fetchAndValidateKek(tenantId, env)
  if (!kek) throw new Error(`Missing tenant KEK for graphiti projection ${captureId}`)
  const stored = await env.R2_ARTIFACTS.get(graphitiProjectionPayloadKey(tenantId, captureId))
  if (!stored) throw new Error(`Missing graphiti projection payload for ${captureId}`)
  return JSON.parse(await decryptWithKek(await stored.text(), kek)) as GraphitiProjectionPayload
}

export async function graphitiProjectionAlreadySubmitted(
  env: Env,
  tenantId: string,
  projectionJobId: string,
): Promise<boolean> {
  const row = await env.D1_US.prepare(
    `SELECT status, target_ref, engine_operation_id
     FROM canonical_projection_results
     WHERE tenant_id = ? AND projection_job_id = ?
     ORDER BY updated_at DESC, created_at DESC, id DESC
     LIMIT 1`,
  ).bind(tenantId, projectionJobId).first<{
    status: string | null
    target_ref: string | null
    engine_operation_id: string | null
  }>()
  return Boolean(
    row && row.status !== 'failed' &&
    (row.target_ref || row.engine_operation_id || row.status === 'completed'),
  )
}

export async function materializeGraphitiProjectionPayload(
  input: CanonicalPipelineCaptureInput,
  captureId: string,
  env: Env,
): Promise<void> {
  const kek = await fetchAndValidateKek(input.tenantId, env)
  if (!kek) return
  const ciphertext = await encryptWithKek(JSON.stringify({
    body: input.body,
  } satisfies GraphitiProjectionPayload), kek)
  await env.R2_ARTIFACTS.put(graphitiProjectionPayloadKey(input.tenantId, captureId), ciphertext)
}
