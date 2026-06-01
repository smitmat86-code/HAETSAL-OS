import { decryptWithKek, encryptWithKek, fetchAndValidateKek } from '../cron/kek'
import type { Env } from '../types/env'
import type {
  CanonicalPipelineCaptureInput,
  HindsightProjectionDispatchInput,
} from '../types/canonical-capture-pipeline'
import type { IngestionArtifact, IngestionSource } from '../types/ingestion'
import { getCanonicalMemoryStore } from './canonical-postgres'
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
  hindsightAsync?: boolean
}

const projectionPayloadKey = (tenantId: string, captureId: string): string =>
  `canonical/${tenantId}/projections/hindsight/${captureId}.enc`

export function resolveProjectionSourceRef(
  row: Pick<ProjectionJobContext, 'source_system' | 'source_ref' | 'capture_id'>,
): string {
  if (row.source_system === 'mcp:memory_write' && row.source_ref?.startsWith('brain-memory:')) {
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
  return buildHindsightDocumentId(tenantId, sourceSystem, resolveProjectionSourceRef({
    source_system: sourceSystem as IngestionSource,
    source_ref: sourceRef,
    capture_id: captureId,
  }))
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
    metadata: {
      ...(payload.metadata ?? {}),
      canonical_capture_id: row.capture_id,
      canonical_document_id: row.document_id,
      canonical_operation_id: row.operation_id,
    },
  }
}

export async function readProjectionJobContext(
  env: Env,
  tenantId: string,
  input: HindsightProjectionDispatchInput,
): Promise<ProjectionJobContext> {
  const row = await getCanonicalMemoryStore(env).getProjectionJobContext(
    tenantId,
    input.projectionJobId,
    'hindsight',
  ) as ProjectionJobContext | null
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
  const row = await getCanonicalMemoryStore(env).getLatestProjectionResult(tenantId, projectionJobId)
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
      hindsightAsync: input.hindsightAsync ?? false,
  } satisfies HindsightProjectionPayload), kek)
  await env.R2_ARTIFACTS.put(projectionPayloadKey(input.tenantId, captureId), ciphertext)
}
