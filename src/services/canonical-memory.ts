import type { Env } from '../types/env'
import type {
  CanonicalCaptureInput,
  CanonicalCaptureResult,
} from '../types/canonical-memory'
import { buildCanonicalCaptureAcceptedAuditBatch } from './canonical-memory-audit'
import { persistCanonicalPayloads, sha256Hex } from './canonical-memory-artifacts'
import { resolveCaptureGovernance } from './canonical-governance'
import { getCanonicalMemoryStore } from './canonical-postgres'
import {
  assertCanonicalIdentity,
  normalizeCanonicalBody,
  planCanonicalChunks,
  requireEncryptedBody,
  resolveCanonicalProjectionKinds,
} from './canonical-memory-schema'
import { toNormalizedArtifact, type CanonicalShadowCaptureArgs } from './canonical-memory-types'

function canonicalShadowWritesEnabled(env: Env): boolean {
  return env.CANONICAL_MEMORY_SHADOW_WRITES === 'true'
}

export async function captureCanonicalMemory(
  input: CanonicalCaptureInput,
  env: Env,
  tenantId: string,
): Promise<CanonicalCaptureResult> {
  assertCanonicalIdentity(tenantId, input.tenantId, input.sourceSystem, input.scope)
  const body = normalizeCanonicalBody(input.body)
  if (!body) throw new Error('Canonical capture body is required')
  const tenant = await env.D1_US.prepare('SELECT id FROM tenants WHERE id = ?').bind(tenantId).first()
  if (!tenant) throw new Error(`Unknown tenant for canonical capture: ${tenantId}`)

  const governance = resolveCaptureGovernance({
    sourceSystem: input.sourceSystem,
    sourceRef: input.sourceRef ?? null,
    capturedAt: input.capturedAt ?? null,
    scope: input.scope,
    authorKind: input.governance?.authorKind,
    agentIdentity: input.governance?.agentIdentity ?? null,
    modelRuntime: input.governance?.modelRuntime ?? null,
    confidence: input.governance?.confidence ?? null,
    retention: input.governance?.retention ?? null,
    provenanceNote: input.governance?.provenanceNote ?? null,
    memoryClass: input.governance?.memoryClass ?? null,
    trustState: input.governance?.trustState ?? null,
    usePolicy: input.governance?.usePolicy ?? null,
    legacyMemoryType: input.governance?.legacyMemoryType ?? null,
  })
  const capture = {
    captureId: crypto.randomUUID(),
    documentId: crypto.randomUUID(),
    operationId: crypto.randomUUID(),
    projectionKinds: resolveCanonicalProjectionKinds(input.projectionKinds),
    tenantId,
    sourceSystem: input.sourceSystem,
    sourceRef: input.sourceRef ?? null,
    scope: input.scope,
    title: input.title?.trim() || null,
    body,
    bodyEncrypted: requireEncryptedBody({ bodyEncrypted: input.bodyEncrypted ?? '' }),
    artifact: toNormalizedArtifact(input.artifactRef),
    capturedAt: governance.envelope.capturedAt,
  }
  const chunks = planCanonicalChunks(body)
  const payloads = await persistCanonicalPayloads(capture, env)
  const createdAt = Date.now()
  const projectionJobs = capture.projectionKinds.map(kind => ({ id: crypto.randomUUID(), kind }))
  const artifactStorageKind = capture.artifact
    ? (capture.artifact.ref.contentEncrypted?.trim() ? 'r2' : 'reference')
    : null
  const store = getCanonicalMemoryStore(env)

  const write = {
    capture: {
      id: capture.captureId,
      tenant_id: tenantId,
      source_system: capture.sourceSystem,
      source_ref: capture.sourceRef,
      scope: capture.scope,
      title: capture.title,
      body_r2_key: payloads.documentR2Key,
      body_sha256: payloads.documentSha256,
      artifact_id: capture.artifact?.id ?? null,
      captured_at: capture.capturedAt,
      created_at: createdAt,
      memory_class: governance.memoryClass,
      trust_state: governance.trustState,
      use_policy: governance.usePolicy,
      author_kind: governance.envelope.authorKind,
      agent_identity: governance.envelope.agentIdentity,
      model_runtime: governance.envelope.modelRuntime,
      confidence: governance.envelope.confidence,
      retention: governance.envelope.retention,
      provenance_note: governance.envelope.provenanceNote,
      memory_type: input.governance?.legacyMemoryType ?? null,
      dedup_hash: input.governance?.dedupHash ?? null,
      salience_tier: input.governance?.salienceTier ?? null,
      governance_downgraded_json: governance.downgraded ? JSON.stringify(governance.downgraded) : null,
    },
    artifact: capture.artifact
      ? {
        id: capture.artifact.id,
        tenant_id: tenantId,
        capture_id: capture.captureId,
        storage_kind: artifactStorageKind ?? 'reference',
        r2_key: payloads.artifactR2Key,
        media_type: capture.artifact.ref.mediaType ?? null,
        filename: capture.artifact.ref.filename ?? null,
        byte_length: capture.artifact.ref.byteLength ?? null,
        sha256: payloads.artifactSha256,
        created_at: createdAt,
      }
      : null,
    document: {
      id: capture.documentId,
      tenant_id: tenantId,
      capture_id: capture.captureId,
      artifact_id: capture.artifact?.id ?? null,
      title: capture.title,
      body_r2_key: payloads.documentR2Key,
      body_sha256: payloads.documentSha256,
      chunk_count: chunks.length,
      created_at: createdAt,
    },
    chunks: await Promise.all(chunks.map(async (chunk) => ({
      id: chunk.id,
      tenant_id: tenantId,
      document_id: capture.documentId,
      ordinal: chunk.ordinal,
      start_offset: chunk.startOffset,
      end_offset: chunk.endOffset,
      chunk_sha256: await sha256Hex(chunk.text),
      chunk_text: chunk.text,
      created_at: createdAt,
    }))),
    operation: {
      id: capture.operationId,
      tenant_id: tenantId,
      capture_id: capture.captureId,
      operation_type: 'capture.accepted',
      status: 'accepted',
      created_at: createdAt,
      updated_at: createdAt,
    },
    projectionJobs: projectionJobs.map((job) => ({
      id: job.id,
      tenant_id: tenantId,
      operation_id: capture.operationId,
      capture_id: capture.captureId,
      document_id: capture.documentId,
      projection_kind: job.kind,
      status: 'accepted',
      created_at: createdAt,
      enqueued_at: createdAt,
    })),
    event: {
      id: crypto.randomUUID(),
      tenant_id: tenantId,
      event_type: 'memory.captured',
      subject_kind: 'capture',
      subject_id: capture.captureId,
      capture_id: capture.captureId,
      actor_kind: governance.envelope.authorKind,
      actor_identity: governance.envelope.agentIdentity,
      occurred_at: capture.capturedAt,
      recorded_at: createdAt,
      detail_json: JSON.stringify({
        memoryClass: governance.memoryClass,
        trustState: governance.trustState,
        usePolicy: governance.usePolicy,
        sourceSystem: capture.sourceSystem,
        scope: capture.scope,
      }),
    },
  }
  await store.writeCapture(write)

  await env.D1_US.batch(buildCanonicalCaptureAcceptedAuditBatch(env.D1_US, {
      tenantId,
      captureId: capture.captureId,
      createdAt,
    }))

  return {
    captureId: capture.captureId,
    documentId: capture.documentId,
    artifactId: capture.artifact?.id ?? null,
    chunkIds: chunks.map(chunk => chunk.id),
    operationId: capture.operationId,
    projectionJobIds: projectionJobs.map(job => job.id),
    projectionKinds: capture.projectionKinds,
    bodyR2Key: payloads.documentR2Key,
    governance: {
      memoryClass: governance.memoryClass,
      trustState: governance.trustState,
      usePolicy: governance.usePolicy,
      authorKind: governance.envelope.authorKind,
      agentIdentity: governance.envelope.agentIdentity,
      downgraded: governance.downgraded,
    },
  }
}

export async function maybeShadowWriteCanonicalCapture(
  args: CanonicalShadowCaptureArgs,
  env: Env,
): Promise<void> {
  if (!canonicalShadowWritesEnabled(env) || !args.bodyEncrypted?.trim()) return
  await captureCanonicalMemory({
    tenantId: args.tenantId,
    sourceSystem: args.sourceSystem,
    sourceRef: args.sourceRef ?? null,
    scope: args.scope,
    title: args.title ?? null,
    body: args.body,
    bodyEncrypted: args.bodyEncrypted,
  }, env, args.tenantId)
}
