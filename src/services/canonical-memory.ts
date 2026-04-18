import type { Env } from '../types/env'
import type {
  CanonicalCaptureInput,
  CanonicalCaptureResult,
} from '../types/canonical-memory'
import { buildCanonicalAuditBatch } from './canonical-memory-audit'
import { persistCanonicalPayloads, sha256Hex } from './canonical-memory-artifacts'
import {
  assertCanonicalIdentity,
  CANONICAL_PROJECTION_KINDS,
  normalizeCanonicalBody,
  planCanonicalChunks,
  requireEncryptedBody,
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

  const capture = {
    captureId: crypto.randomUUID(),
    documentId: crypto.randomUUID(),
    operationId: crypto.randomUUID(),
    projectionKinds: CANONICAL_PROJECTION_KINDS,
    tenantId,
    sourceSystem: input.sourceSystem,
    sourceRef: input.sourceRef ?? null,
    scope: input.scope,
    title: input.title?.trim() || null,
    body,
    bodyEncrypted: requireEncryptedBody({ bodyEncrypted: input.bodyEncrypted ?? '' }),
    artifact: toNormalizedArtifact(input.artifactRef),
    capturedAt: input.capturedAt ?? Date.now(),
  }
  const chunks = planCanonicalChunks(body)
  const payloads = await persistCanonicalPayloads(capture, env)
  const createdAt = Date.now()
  const projectionJobs = capture.projectionKinds.map(kind => ({ id: crypto.randomUUID(), kind }))

  await env.D1_US.batch([
    env.D1_US.prepare(
      `INSERT INTO canonical_captures
       (id, tenant_id, source_system, source_ref, scope, title, body_r2_key, body_sha256, artifact_id, captured_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(capture.captureId, tenantId, capture.sourceSystem, capture.sourceRef, capture.scope, capture.title, payloads.documentR2Key, payloads.documentSha256, capture.artifact?.id ?? null, capture.capturedAt, createdAt),
    ...(capture.artifact ? [env.D1_US.prepare(
      `INSERT INTO canonical_artifacts
       (id, tenant_id, capture_id, storage_kind, r2_key, media_type, filename, byte_length, sha256, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(capture.artifact.id, tenantId, capture.captureId, 'r2', payloads.artifactR2Key, capture.artifact.ref.mediaType ?? null, capture.artifact.ref.filename ?? null, capture.artifact.ref.byteLength ?? null, payloads.artifactSha256, createdAt)] : []),
    env.D1_US.prepare(
      `INSERT INTO canonical_documents
       (id, tenant_id, capture_id, artifact_id, title, body_r2_key, body_sha256, chunk_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(capture.documentId, tenantId, capture.captureId, capture.artifact?.id ?? null, capture.title, payloads.documentR2Key, payloads.documentSha256, chunks.length, createdAt),
    ...await Promise.all(chunks.map(async chunk => env.D1_US.prepare(
      `INSERT INTO canonical_chunks
       (id, tenant_id, document_id, ordinal, start_offset, end_offset, chunk_sha256, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(chunk.id, tenantId, capture.documentId, chunk.ordinal, chunk.startOffset, chunk.endOffset, await sha256Hex(chunk.text), createdAt))),
    env.D1_US.prepare(
      `INSERT INTO canonical_memory_operations
       (id, tenant_id, capture_id, operation_type, status, created_at, updated_at)
       VALUES (?, ?, ?, 'capture.accepted', 'accepted', ?, ?)`,
    ).bind(capture.operationId, tenantId, capture.captureId, createdAt, createdAt),
    ...projectionJobs.map(job => env.D1_US.prepare(
      `INSERT INTO canonical_projection_jobs
       (id, tenant_id, operation_id, capture_id, document_id, projection_kind, status, created_at, enqueued_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).bind(job.id, tenantId, capture.operationId, capture.captureId, capture.documentId, job.kind, createdAt, createdAt)),
    ...buildCanonicalAuditBatch(env.D1_US, {
      tenantId,
      captureId: capture.captureId,
      operationId: capture.operationId,
      projectionKinds: capture.projectionKinds,
      createdAt,
    }),
  ])

  return {
    captureId: capture.captureId,
    documentId: capture.documentId,
    chunkIds: chunks.map(chunk => chunk.id),
    operationId: capture.operationId,
    projectionJobIds: projectionJobs.map(job => job.id),
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
