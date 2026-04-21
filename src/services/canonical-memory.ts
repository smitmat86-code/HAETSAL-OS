import type { Env } from '../types/env'
import type {
  CanonicalCaptureInput,
  CanonicalCaptureResult,
} from '../types/canonical-memory'
import { buildCanonicalCaptureAcceptedAuditBatch } from './canonical-memory-audit'
import { mirrorCanonicalCaptureWrite } from './canonical-d1-compat'
import { persistCanonicalPayloads, sha256Hex } from './canonical-memory-artifacts'
import { getCanonicalMemoryStore } from './canonical-postgres'
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
  }
  await store.writeCapture(write)
  await mirrorCanonicalCaptureWrite(env, write)

  await env.D1_US.batch(buildCanonicalCaptureAcceptedAuditBatch(env.D1_US, {
      tenantId,
      captureId: capture.captureId,
      createdAt,
    }))

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
