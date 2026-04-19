import type { MemoryQueryMode } from './canonical-memory-query'

export type ContextBundleIntent = 'person' | 'project' | 'scope' | 'meeting_prep'
export type ContextConfidenceLevel = 'low' | 'medium' | 'high'

export interface PrepareContextForAgentInput {
  agent: 'chief_of_staff' | string
  intent: ContextBundleIntent
  target: string
  scope?: string | null
  limit?: number
}

export interface ContextSourceRef {
  mode: MemoryQueryMode
  title: string | null
  preview: string
  captureId: string | null
  documentId: string | null
  sourceSystem: string | null
  sourceRef: string | null
  capturedAt: number | null
  projectionRef: string | null
  targetRef: string | null
  graphRef: string | null
}

export interface ContextGap {
  kind: 'missing' | 'uncertain' | 'stale'
  mode: MemoryQueryMode | null
  message: string
}

export interface ContextEvidenceBlock {
  mode: MemoryQueryMode
  query: string
  status: 'ok' | 'partial' | 'unavailable'
  routeReason: string | null
  items: ContextSourceRef[]
}

export interface AgentContextBundle {
  agent: string
  intent: ContextBundleIntent
  target: string
  scope: string | null
  summary: string
  confidence: { level: ContextConfidenceLevel; rationale: string }
  highlights: string[]
  recentChanges: string[]
  openLoops: string[]
  risks: string[]
  timeline: string[]
  relationships: string[]
  followUpQuestions: string[]
  gaps: ContextGap[]
  sources: ContextSourceRef[]
  evidence: ContextEvidenceBlock[]
}
