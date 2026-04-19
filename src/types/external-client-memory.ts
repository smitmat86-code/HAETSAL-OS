import type { CanonicalArtifactRef } from './canonical-memory'

export type ExternalClientCaptureMode =
  | 'explicit'
  | 'session_summary'
  | 'artifact'

export interface BrainMemorySurfaceProfile {
  surface: 'brain-memory'
  canCapture: true
  canQuery: true
  canReadSources: false
  canMutateSources: false
  recommendedDefaultCaptureMode: 'session_summary'
  rejectsFullTranscriptDefault: true
  writeToolNames: ['capture_memory']
  readToolNames: [
    'search_memory',
    'trace_relationship',
    'get_entity_timeline',
    'prepare_context_for_agent',
    'get_recent_memories',
    'get_document',
    'memory_status',
    'memory_stats',
  ]
}

export interface ExternalClientCaptureInput {
  content: string
  scope?: string | null
  memory_type?: 'episodic' | 'semantic' | 'world'
  provenance?: string | null
  capture_mode?: ExternalClientCaptureMode | null
  client_name?: string | null
  title?: string | null
  session_id?: string | null
  source_ref?: string | null
  artifact_ref?: string | null
  artifact_filename?: string | null
  artifact_media_type?: string | null
  artifact_byte_length?: number | null
}

export interface BrainMemoryRolloutAttribution {
  surface: 'brain-memory'
  captureMode: ExternalClientCaptureMode
  provenance: string
  clientName: string | null
  locator: string | null
  sessionId: string | null
  artifactRef: string | null
}

export interface ExternalClientCaptureNormalization {
  captureMode: ExternalClientCaptureMode
  clientName: string
  provenance: string
  sourceSystem: 'mcp:memory_write'
  sourceRef: string
  title: string | null
  artifactRef: CanonicalArtifactRef | null
  metadata: Record<string, unknown>
}

export interface ExternalClientCapturePattern {
  id: ExternalClientCaptureMode
  label: string
  durableValue: string
}
