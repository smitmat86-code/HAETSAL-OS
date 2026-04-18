import type { CanonicalProjectionKind } from '../types/canonical-memory'
import type {
  CanonicalChunkPlan,
  NormalizedCanonicalCapture,
} from './canonical-memory-types'

const SAFE_VALUE = /^[a-z0-9:_-]{2,80}$/i
const CHUNK_LIMIT = 240

export const CANONICAL_PROJECTION_KINDS: CanonicalProjectionKind[] = [
  'hindsight',
  'graphiti',
]

export function normalizeCanonicalBody(body: string): string {
  return body.replace(/\r\n/g, '\n').trim()
}

export function assertCanonicalIdentity(
  expectedTenantId: string,
  inputTenantId: string,
  sourceSystem: string,
  scope: string,
): void {
  if (expectedTenantId !== inputTenantId) {
    throw new Error('captureCanonicalMemory tenant mismatch')
  }
  if (!SAFE_VALUE.test(sourceSystem)) {
    throw new Error(`Invalid canonical source system: ${sourceSystem}`)
  }
  if (!SAFE_VALUE.test(scope)) {
    throw new Error(`Invalid canonical scope: ${scope}`)
  }
}

export function requireEncryptedBody(
  capture: Pick<NormalizedCanonicalCapture, 'bodyEncrypted'>,
): string {
  if (!capture.bodyEncrypted.trim()) {
    throw new Error('Canonical capture requires bodyEncrypted for HAETSAL-owned storage')
  }
  return capture.bodyEncrypted
}

export function planCanonicalChunks(body: string): CanonicalChunkPlan[] {
  const normalized = normalizeCanonicalBody(body)
  const paragraphs = normalized.split(/\n{2,}/).filter(Boolean)
  const chunks: CanonicalChunkPlan[] = []
  let searchFrom = 0
  for (const paragraph of paragraphs) {
    const start = normalized.indexOf(paragraph, searchFrom)
    let localOffset = 0
    while (localOffset < paragraph.length) {
      const sliceEnd = Math.min(localOffset + CHUNK_LIMIT, paragraph.length)
      chunks.push({
        id: crypto.randomUUID(),
        ordinal: chunks.length,
        startOffset: start + localOffset,
        endOffset: start + sliceEnd,
        text: paragraph.slice(localOffset, sliceEnd),
      })
      localOffset = sliceEnd
    }
    searchFrom = start + paragraph.length
  }
  if (chunks.length > 0) return chunks
  return [{
    id: crypto.randomUUID(),
    ordinal: 0,
    startOffset: 0,
    endOffset: normalized.length,
    text: normalized,
  }]
}
