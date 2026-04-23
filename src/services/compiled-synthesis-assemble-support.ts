import type { CompiledContradictionSectionRef, CompiledFactSectionItem, CompiledRecommendedActionItem, CompiledRelationshipSectionItem } from './compiled-synthesis-section-types'
import type { PersistCompiledContradictionInput, PersistCompiledEntityInput, PersistCompiledFactInput, PersistCompiledRelationshipInput } from './compiled-synthesis-service-types'
import type { ParsedContradictionSignal, ParsedFactSignal, ParsedRelationshipSignal } from './compiled-synthesis-signal-parser'
import { slugifyStableSegment } from './compiled-synthesis-utils'

export function buildFactInputs(
  stableSegment: string,
  scope: string,
  subjectStableKey: string,
  factSignals: ParsedFactSignal[],
): { facts: PersistCompiledFactInput[]; keyFacts: CompiledFactSectionItem[] } {
  const factMap = new Map<string, ParsedFactSignal>()
  for (const signal of factSignals) {
    const stableKey = `fact:project:${stableSegment}:${signal.kind}`
    if (!factMap.has(stableKey)) factMap.set(stableKey, signal)
  }
  return {
    facts: [...factMap.entries()].map(([stableKey, signal]) => ({
      stableKey,
      scope,
      subjectEntityStableKey: subjectStableKey,
      factType: signal.kind,
      value: { label: signal.label, summary: signal.summary },
      summary: signal.summary,
    })),
    keyFacts: [...factMap.entries()].map(([stableKey, signal]) => ({
      label: signal.label,
      summary: signal.summary,
      factStableKey: stableKey,
      subjectStableKey,
    })),
  }
}

export function buildRelationshipInputs(
  stableSegment: string,
  scope: string,
  subjectStableKey: string,
  subjectName: string,
  currentStateSummary: string,
  relationshipSignals: ParsedRelationshipSignal[],
): {
  entities: PersistCompiledEntityInput[]
  relationships: PersistCompiledRelationshipInput[]
  keyRelationships: CompiledRelationshipSectionItem[]
} {
  const entityMap = new Map<string, PersistCompiledEntityInput>()
  entityMap.set(subjectStableKey, {
    stableKey: subjectStableKey,
    scope,
    entityType: 'project',
    name: subjectName,
    summary: currentStateSummary,
  })
  const relationships: PersistCompiledRelationshipInput[] = []
  const keyRelationships: CompiledRelationshipSectionItem[] = []
  const seenRelationshipKeys = new Set<string>()
  for (const signal of relationshipSignals) {
    const counterpartSlug = signal.counterpartName ? slugifyStableSegment(signal.counterpartName) : 'related'
    const relationshipStableKey = `relationship:${stableSegment}:${signal.relationshipType}:${counterpartSlug}`
    if (seenRelationshipKeys.has(relationshipStableKey)) continue
    seenRelationshipKeys.add(relationshipStableKey)
    const counterpartStableKey = signal.counterpartName ? `entity:reference:${counterpartSlug}` : null
    if (signal.counterpartName) {
      entityMap.set(counterpartStableKey!, {
        stableKey: counterpartStableKey!,
        scope,
        entityType: 'reference',
        name: signal.counterpartName,
        summary: signal.summary,
      })
    }

    relationships.push({
      stableKey: relationshipStableKey,
      scope,
      subjectEntityStableKey: subjectStableKey,
      objectEntityStableKey: counterpartStableKey,
      relationshipType: signal.relationshipType,
      summary: signal.summary,
    })
    keyRelationships.push({
      label: signal.counterpartName
        ? `${signal.relationshipType.replace(/-/g, ' ')}: ${signal.counterpartName}`
        : signal.relationshipType.replace(/-/g, ' '),
      summary: signal.summary,
      relationshipStableKey,
      counterpartStableKey,
    })
  }
  return { entities: [...entityMap.values()], relationships, keyRelationships }
}

export function buildContradictionInputs(
  stableSegment: string,
  subjectName: string,
  scope: string,
  facts: PersistCompiledFactInput[],
  contradictionSignals: ParsedContradictionSignal[],
  recommendedActions: CompiledRecommendedActionItem[],
): {
  contradictions: PersistCompiledContradictionInput[]
  contradictionRefs: CompiledContradictionSectionRef[]
} {
  const contradictions = contradictionSignals.slice(0, 5).map((signal, index) => {
    const linkedFactStableKey = facts[index]?.stableKey ?? facts[0]?.stableKey ?? null
    return {
      stableKey: `contradiction:project:${stableSegment}:${signal.contradictionKind}:${index + 1}`,
      scope,
      leftFactStableKey: linkedFactStableKey,
      title: `${subjectName} ${signal.contradictionKind.replace(/-/g, ' ')}`,
      contradictionKind: signal.contradictionKind,
      conflictScope: scope,
      severity: 'medium' as const,
      freshness: 'recent' as const,
      summary: signal.summary,
      status: 'open' as const,
      leftClaim: linkedFactStableKey
        ? {
          summary: facts.find((fact) => fact.stableKey === linkedFactStableKey)?.summary ?? signal.summary,
          factStableKey: linkedFactStableKey,
          sourceRole: 'primary',
        }
        : undefined,
      rightClaim: { summary: signal.summary, sourceRole: 'supporting' },
      suggestedResolution: recommendedActions[0]?.summary ?? null,
    }
  })
  return {
    contradictions,
    contradictionRefs: contradictions.map((contradiction) => ({
      contradictionStableKey: contradiction.stableKey,
      summary: contradiction.summary,
      status: contradiction.status,
      severity: contradiction.severity,
    })),
  }
}
