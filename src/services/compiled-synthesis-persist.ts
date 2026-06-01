import type { Env } from '../types/env'
import { persistCompiledArtifactPayload } from './compiled-synthesis-artifacts'
import { persistOutputRows } from './compiled-synthesis-persist-outputs'
import { getCompiledSynthesisStore } from './compiled-synthesis-postgres'
import { persistSupportingRows } from './compiled-synthesis-persist-supporting'
import type {
  PersistCompiledSynthesisInput,
  PersistCompiledSynthesisResult,
} from './compiled-synthesis-service-types'
import { trimRequired } from './compiled-synthesis-utils'

export async function persistCompiledSynthesis(
  input: PersistCompiledSynthesisInput,
  env: Env,
): Promise<PersistCompiledSynthesisResult> {
  if (input.sources.length === 0) {
    throw new Error('Compiled synthesis requires at least one canonical source link')
  }

  const compiledAt = input.compiledAt ?? Date.now()
  const store = getCompiledSynthesisStore(env)
  const document = await store.upsertCompiledDocument({
    tenantId: input.tenantId,
    stableKey: trimRequired(input.document.stableKey, 'Compiled document stable key'),
    family: input.document.family,
    scope: trimRequired(input.document.scope, 'Compiled document scope'),
    title: input.document.title ?? null,
    summary: input.document.summary ?? null,
    audience: input.document.audience,
    compiledAt,
    updatedAt: compiledAt,
  })

  await store.replaceCompiledDocumentSources(input.tenantId, document.id, input.sources)

  const result: PersistCompiledSynthesisResult = {
    documentId: document.id,
    documentStableKey: document.stable_key,
    artifactRefs: [],
    entityIds: [],
    factIds: [],
    relationshipIds: [],
    contradictionIds: [],
    dossierId: null,
    contextPackId: null,
    changeViewId: null,
  }

  await persistSupportingRows(store, input, document.id, compiledAt, result)
  await persistOutputRows(store, input, document.id, compiledAt, result)

  for (const artifact of input.artifacts ?? []) {
    const persisted = await persistCompiledArtifactPayload(env, {
      tenantId: input.tenantId,
      family: document.family,
      stableKey: document.stable_key,
      artifactRole: trimRequired(artifact.artifactRole, 'Compiled artifact role'),
      format: artifact.format,
      version: trimRequired(artifact.version, 'Compiled artifact version'),
      mediaType: artifact.mediaType ?? null,
      contentEncrypted: trimRequired(artifact.contentEncrypted, 'Compiled artifact payload'),
    })
    const row = await store.insertCompiledDocumentArtifact(input.tenantId, {
      compiledDocumentId: document.id,
      artifactRole: persisted.artifactRole,
      format: persisted.format,
      version: persisted.version,
      mediaType: persisted.mediaType,
      r2Key: persisted.r2Key,
      sha256: persisted.sha256,
      byteLength: persisted.byteLength,
      createdAt: compiledAt,
    })
    result.artifactRefs.push({
      artifactId: row.id,
      artifactRole: row.artifact_role,
      version: row.version,
      r2Key: row.r2_key,
    })
  }

  return result
}
