import type { HindsightRetainRequest } from '../../types/hindsight'
import type { IngestionArtifact } from '../../types/ingestion'
import { buildHindsightDocumentId, buildHindsightTags, buildRetainContext } from '../hindsight'

export function normalizeHindsightMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, string> {
  const normalized: Record<string, string> = {}
  if (!metadata) return normalized

  for (const [key, value] of Object.entries(metadata)) {
    if (value == null) continue
    normalized[key] = typeof value === 'string' ? value : JSON.stringify(value)
  }
  return normalized
}

export function buildHindsightRetainRequest(
  artifact: IngestionArtifact,
  dedupHash: string,
  memoryType: string,
  domain: string,
  salienceTier: number,
  async: boolean,
): { documentId: string; request: HindsightRetainRequest } {
  const documentId = buildHindsightDocumentId(artifact.tenantId, artifact.source, dedupHash)
  return {
    documentId,
    request: {
      async,
      items: [{
        content: artifact.content,
        context: buildRetainContext(
          artifact.source,
          artifact.provenance ?? artifact.source,
          domain,
        ),
        document_id: documentId,
        timestamp: new Date(artifact.occurredAt).toISOString(),
        tags: buildHindsightTags(artifact.tenantId, domain, artifact.source),
        metadata: {
          ...normalizeHindsightMetadata(artifact.metadata),
          app_memory_type: memoryType,
          domain,
          provenance: artifact.provenance ?? artifact.source,
          salience_tier: String(salienceTier),
          source: artifact.source,
          tenant_id: artifact.tenantId,
          occurred_at_ms: String(artifact.occurredAt),
        },
      }],
    },
  }
}
