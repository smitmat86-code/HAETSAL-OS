import type { ContextEvidenceBlock, ContextSourceRef } from '../types/chief-of-staff-context'
import type { CompiledSourceRefItem } from './compiled-synthesis'
import type { CompiledDocumentSourceRecord } from './compiled-synthesis-records'

export function linkedSourceRefs(
  sourceRefs: CompiledSourceRefItem[],
  sources: CompiledDocumentSourceRecord[],
): CompiledSourceRefItem[] {
  if (sourceRefs.length > 0) return sourceRefs
  return sources.map((source) => ({
    sourceRole: source.source_role,
    canonicalCaptureId: source.canonical_capture_id,
    canonicalDocumentId: source.canonical_document_id,
    canonicalArtifactId: source.canonical_artifact_id,
    canonicalOperationId: source.canonical_operation_id,
  }))
}

export function linkedSourceCount(
  sourceRefs: CompiledSourceRefItem[],
  sources: CompiledDocumentSourceRecord[],
): number {
  return linkedSourceRefs(sourceRefs, sources).length
}

function toCompiledSource(
  source: CompiledSourceRefItem,
  fallbackTitle: string,
): ContextSourceRef {
  const preview = source.label?.trim() || source.sourceRole?.trim() || source.canonicalDocumentId || source.canonicalCaptureId || source.canonicalOperationId || `Compiled source for ${fallbackTitle}`
  return { mode: 'composed', title: source.label?.trim() || fallbackTitle, preview, captureId: source.canonicalCaptureId ?? null, documentId: source.canonicalDocumentId ?? null, sourceSystem: null, sourceRef: source.sourceRole ?? null, capturedAt: null, projectionRef: null, targetRef: null, graphRef: null }
}

export function compiledEvidenceBlock(
  stableKey: string,
  title: string,
  sourceRefs: CompiledSourceRefItem[],
  routeReason: string,
): ContextEvidenceBlock {
  const items = sourceRefs.map((source) => toCompiledSource(source, title))
  return { mode: 'composed', query: stableKey, status: items.length ? 'ok' : 'partial', routeReason, items }
}
