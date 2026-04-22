import type { Env } from '../types/env'
import { persistCompiledArtifactPayload } from './compiled-synthesis-artifacts'
import { getCompiledSynthesisStore } from './compiled-synthesis-postgres'
import type {
  PersistCompiledSynthesisInput,
  PersistCompiledSynthesisResult,
} from './compiled-synthesis-service-types'
import { normalizeJson, trimRequired } from './compiled-synthesis-utils'
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
  const entityIds = new Map<string, string>()
  const factIds = new Map<string, string>()
  const result: PersistCompiledSynthesisResult = {
    documentId: document.id,
    documentStableKey: document.stable_key,
    artifactRefs: [],
    entityIds: [],
    factIds: [],
    relationshipIds: [],
    contradictionIds: [],
    contextPackId: null,
  }
  for (const entity of input.entities ?? []) {
    const row = await store.upsertCompiledEntity({
      tenantId: input.tenantId,
      compiledDocumentId: document.id,
      stableKey: trimRequired(entity.stableKey, 'Compiled entity stable key'),
      scope: trimRequired(entity.scope, 'Compiled entity scope'),
      entityType: trimRequired(entity.entityType, 'Compiled entity type'),
      name: trimRequired(entity.name, 'Compiled entity name'),
      summary: entity.summary ?? null,
      compiledAt,
      updatedAt: compiledAt,
    })
    entityIds.set(row.stable_key, row.id)
    result.entityIds.push(row.id)
  }
  for (const fact of input.facts ?? []) {
    const row = await store.upsertCompiledFact({
      tenantId: input.tenantId,
      compiledDocumentId: document.id,
      stableKey: trimRequired(fact.stableKey, 'Compiled fact stable key'),
      scope: trimRequired(fact.scope, 'Compiled fact scope'),
      subjectEntityId: fact.subjectEntityStableKey ? entityIds.get(fact.subjectEntityStableKey) ?? null : null,
      factType: trimRequired(fact.factType, 'Compiled fact type'),
      valueJson: normalizeJson(fact.value),
      summary: fact.summary ?? null,
      compiledAt,
      updatedAt: compiledAt,
    })
    factIds.set(row.stable_key, row.id)
    result.factIds.push(row.id)
  }
  for (const rowInput of input.relationships ?? []) {
    const row = await store.upsertCompiledRelationship({
      tenantId: input.tenantId,
      compiledDocumentId: document.id,
      stableKey: trimRequired(rowInput.stableKey, 'Compiled relationship stable key'),
      scope: trimRequired(rowInput.scope, 'Compiled relationship scope'),
      subjectEntityId: rowInput.subjectEntityStableKey ? entityIds.get(rowInput.subjectEntityStableKey) ?? null : null,
      objectEntityId: rowInput.objectEntityStableKey ? entityIds.get(rowInput.objectEntityStableKey) ?? null : null,
      relationshipType: trimRequired(rowInput.relationshipType, 'Compiled relationship type'),
      summary: rowInput.summary ?? null,
      compiledAt,
      updatedAt: compiledAt,
    })
    result.relationshipIds.push(row.id)
  }
  for (const rowInput of input.contradictions ?? []) {
    const row = await store.upsertCompiledContradiction({
      tenantId: input.tenantId,
      compiledDocumentId: document.id,
      stableKey: trimRequired(rowInput.stableKey, 'Compiled contradiction stable key'),
      scope: trimRequired(rowInput.scope, 'Compiled contradiction scope'),
      leftFactId: rowInput.leftFactStableKey ? factIds.get(rowInput.leftFactStableKey) ?? null : null,
      rightFactId: rowInput.rightFactStableKey ? factIds.get(rowInput.rightFactStableKey) ?? null : null,
      title: rowInput.title ?? null,
      summary: trimRequired(rowInput.summary, 'Compiled contradiction summary'),
      status: rowInput.status,
      compiledAt,
      updatedAt: compiledAt,
    })
    result.contradictionIds.push(row.id)
  }

  if (input.contextPack) {
    result.contextPackId = (await store.upsertCompiledContextPack({
      tenantId: input.tenantId,
      compiledDocumentId: document.id,
      stableKey: trimRequired(input.contextPack.stableKey, 'Compiled context-pack stable key'),
      scope: trimRequired(input.contextPack.scope, 'Compiled context-pack scope'),
      packKind: trimRequired(input.contextPack.packKind, 'Compiled context-pack kind'),
      title: trimRequired(input.contextPack.title, 'Compiled context-pack title'),
      summary: input.contextPack.summary ?? null,
      agentUsable: input.contextPack.agentUsable,
      humanUsable: input.contextPack.humanUsable,
      compiledAt,
      updatedAt: compiledAt,
    })).id
  }

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
    result.artifactRefs.push({ artifactId: row.id, artifactRole: row.artifact_role, version: row.version, r2Key: row.r2_key })
  }

  return result
}
