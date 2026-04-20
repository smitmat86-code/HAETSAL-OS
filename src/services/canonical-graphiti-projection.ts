import type { CanonicalArtifactRef } from '../types/canonical-memory'
import type {
  GraphitiProjectionDispatchInput, GraphitiProjectionSubmissionResult,
} from '../types/canonical-graph-projection'
import type { Env } from '../types/env'
import { buildCanonicalGraphProjectionPlan, GRAPHITI_DEPLOYMENT_POSTURE } from './canonical-graph-projection-design'
import {
  graphitiProjectionAlreadySubmitted,
  materializeGraphitiProjectionPayload,
  readGraphitiProjectionJobContext,
  readGraphitiProjectionPayload,
} from './canonical-graphiti-payload'
import { recordGraphitiProjectionState } from './canonical-graphiti-reconcile'
import { submitCanonicalGraphitiProjection } from './graphiti-client'

function toArtifactRef(row: {
  artifact_filename: string | null
  artifact_media_type: string | null
  artifact_storage_key: string | null
}): CanonicalArtifactRef | null {
  return row.artifact_filename || row.artifact_media_type || row.artifact_storage_key
    ? {
      filename: row.artifact_filename,
      mediaType: row.artifact_media_type,
      storageKey: row.artifact_storage_key,
    }
    : null
}

export { materializeGraphitiProjectionPayload }

export async function submitGraphitiProjection(
  input: GraphitiProjectionDispatchInput,
  env: Env,
): Promise<GraphitiProjectionSubmissionResult | null> {
  const row = await readGraphitiProjectionJobContext(env, input.tenantId, input)
  if (await graphitiProjectionAlreadySubmitted(env, input.tenantId, row.id)) return null
  const payload = await readGraphitiProjectionPayload(env, input.tenantId, row.capture_id)
  const plan = buildCanonicalGraphProjectionPlan({
    tenantId: input.tenantId,
    captureId: row.capture_id,
    documentId: row.document_id,
    operationId: row.operation_id,
    scope: row.scope,
    sourceSystem: row.source_system,
    sourceRef: row.source_ref,
    title: row.title,
    body: payload.body,
    capturedAt: row.captured_at,
    artifactRef: toArtifactRef(row),
  })

  await recordGraphitiProjectionState({
    env,
    tenantId: input.tenantId,
    job: row,
    jobStatus: 'queued',
    resultStatus: 'queued',
    submission: { targetRef: null, operationRef: null, mappings: [] },
    auditAction: 'memory.projection.graphiti_started',
  })

  try {
    const submission = await submitCanonicalGraphitiProjection({
      tenantId: input.tenantId,
      projectionJobId: row.id,
      captureId: row.capture_id,
      operationId: row.operation_id,
      documentId: row.document_id,
      posture: GRAPHITI_DEPLOYMENT_POSTURE.id,
      plan,
      content: { body: payload.body },
    }, env)
    if (submission.status === 'completed' && submission.mappings.length === 0) {
      throw new Error('Graphiti projection completed without identity mappings')
    }
    await recordGraphitiProjectionState({
      env,
      tenantId: input.tenantId,
      job: row,
      jobStatus: submission.status,
      resultStatus: submission.status,
      submission,
      auditAction: submission.status === 'completed'
        ? 'memory.projection.graphiti_completed'
        : 'memory.projection.graphiti_queued',
    })
    return submission
  } catch (error) {
    await recordGraphitiProjectionState({
      env,
      tenantId: input.tenantId,
      job: row,
      jobStatus: 'failed',
      resultStatus: 'failed',
      submission: { targetRef: null, operationRef: null, mappings: [] },
      errorMessage: error instanceof Error ? error.message : String(error),
      auditAction: 'memory.projection.graphiti_failed',
    })
    throw error
  }
}
