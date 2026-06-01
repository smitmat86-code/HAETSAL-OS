import { decryptWithKek, encryptWithKek, fetchAndValidateKek } from '../cron/kek'
import type { Env } from '../types/env'
import type { GraphitiProjectionDispatchInput } from '../types/canonical-graph-projection'
import type { CanonicalPipelineCaptureInput } from '../types/canonical-capture-pipeline'
import type { IngestionSource } from '../types/ingestion'
import { getCanonicalMemoryStore } from './canonical-postgres'

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
  const row = await getCanonicalMemoryStore(env).getProjectionJobContext(
    tenantId,
    input.projectionJobId,
    'graphiti',
  ) as GraphitiProjectionJobContext | null
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
  const row = await getCanonicalMemoryStore(env).getLatestProjectionResult(tenantId, projectionJobId)
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
