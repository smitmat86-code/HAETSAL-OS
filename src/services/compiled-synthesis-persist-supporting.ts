import type { CompiledSynthesisStore } from './compiled-synthesis-repository'
import type {
  PersistCompiledSynthesisInput,
  PersistCompiledSynthesisResult,
} from './compiled-synthesis-service-types'
import { normalizeJson, trimRequired } from './compiled-synthesis-utils'

export interface PersistSupportingRowsResult {
  entityIds: Map<string, string>
  factIds: Map<string, string>
}

export async function persistSupportingRows(
  store: CompiledSynthesisStore,
  input: PersistCompiledSynthesisInput,
  compiledDocumentId: string,
  compiledAt: number,
  result: PersistCompiledSynthesisResult,
): Promise<PersistSupportingRowsResult> {
  const entityIds = new Map<string, string>()
  const factIds = new Map<string, string>()

  for (const entity of input.entities ?? []) {
    const row = await store.upsertCompiledEntity({
      tenantId: input.tenantId,
      compiledDocumentId,
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
      compiledDocumentId,
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

  for (const relationship of input.relationships ?? []) {
    const row = await store.upsertCompiledRelationship({
      tenantId: input.tenantId,
      compiledDocumentId,
      stableKey: trimRequired(relationship.stableKey, 'Compiled relationship stable key'),
      scope: trimRequired(relationship.scope, 'Compiled relationship scope'),
      subjectEntityId: relationship.subjectEntityStableKey
        ? entityIds.get(relationship.subjectEntityStableKey) ?? null
        : null,
      objectEntityId: relationship.objectEntityStableKey
        ? entityIds.get(relationship.objectEntityStableKey) ?? null
        : null,
      relationshipType: trimRequired(relationship.relationshipType, 'Compiled relationship type'),
      summary: relationship.summary ?? null,
      compiledAt,
      updatedAt: compiledAt,
    })
    result.relationshipIds.push(row.id)
  }

  for (const contradiction of input.contradictions ?? []) {
    const leftClaim = contradiction.leftClaim ?? {
      summary: contradiction.summary,
      factStableKey: contradiction.leftFactStableKey ?? null,
    }
    const rightClaim = contradiction.rightClaim ?? {
      summary: contradiction.summary,
      factStableKey: contradiction.rightFactStableKey ?? null,
    }
    const row = await store.upsertCompiledContradiction({
      tenantId: input.tenantId,
      compiledDocumentId,
      stableKey: trimRequired(contradiction.stableKey, 'Compiled contradiction stable key'),
      scope: trimRequired(contradiction.scope, 'Compiled contradiction scope'),
      leftFactId: contradiction.leftFactStableKey ? factIds.get(contradiction.leftFactStableKey) ?? null : null,
      rightFactId: contradiction.rightFactStableKey ? factIds.get(contradiction.rightFactStableKey) ?? null : null,
      title: contradiction.title ?? null,
      contradictionKind: contradiction.contradictionKind?.trim() || 'claim_conflict',
      conflictScope: contradiction.conflictScope ?? null,
      severity: contradiction.severity ?? 'medium',
      freshness: contradiction.freshness ?? 'recent',
      summary: trimRequired(contradiction.summary, 'Compiled contradiction summary'),
      status: contradiction.status,
      leftClaimJson: normalizeJson(leftClaim),
      rightClaimJson: normalizeJson(rightClaim),
      suggestedResolution: contradiction.suggestedResolution ?? null,
      resolutionSummary: contradiction.resolutionSummary ?? null,
      compiledAt,
      updatedAt: compiledAt,
    })
    result.contradictionIds.push(row.id)
  }

  return { entityIds, factIds }
}
