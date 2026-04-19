export type BrainSurfaceId = 'brain-memory' | 'brain-sources-read' | 'brain-actions'
export type BrainSurfaceStatus = 'live' | 'planned' | 'deferred'
export type BrainRiskLevel = 'lowest' | 'medium' | 'highest'
export type BrainActionClass = 'memory' | 'source-read' | 'source-write'
export type BrainClientClass =
  | 'mcp-native-coding-client'
  | 'first-party-agent'
  | 'web-ai-client'
  | 'source-connector'
export type BrainSourceClass =
  | 'event-driven-source-read'
  | 'explicit-file-ingestion'
  | 'historical-import'
  | 'external-action'
export type BrainConnectionPattern =
  | 'remote-mcp'
  | 'internal-worker'
  | 'byoc-portability'
  | 'queue-webhook-ingestion'
export type WorkingIdentityArtifactId =
  | 'operating-model.json'
  | 'USER.md'
  | 'SOUL.md'
  | 'HEARTBEAT.md'
  | 'schedule-recommendations.json'
export type WorkingIdentityDelivery = 'file' | 'mcp-record'
export type BrainProvenanceClass =
  | 'user_authored'
  | 'agent_authored'
  | 'source_ingested'
  | 'bootstrap_import'
  | 'byoc_export'

export interface BrainOperationDefinition {
  id: string
  actionClass: BrainActionClass
  live: boolean
  description: string
}

export interface BrainSurfaceDefinition {
  id: BrainSurfaceId
  status: BrainSurfaceStatus
  riskLevel: BrainRiskLevel
  purpose: string
  clients: string[]
  operations: BrainOperationDefinition[]
}

export interface BrainClientMapping {
  clientClass: BrainClientClass
  connectionPattern: BrainConnectionPattern
  defaultSurface: BrainSurfaceId | null
  portabilityBridge: boolean
}

export interface BrainClientFixture {
  name: string
  clientClass: BrainClientClass
  expectedSurface: BrainSurfaceId | null
}

export interface BrainSourceIngestionDefinition {
  sourceClass: BrainSourceClass
  pattern: string
  examples: string[]
  selective: boolean
  sourceOfTruthRemainsExternal: boolean
}

export interface BrainSourceFixture {
  name: string
  sourceClass: BrainSourceClass
  expectedSurface: BrainSurfaceId
}

export interface WorkingIdentityArtifactDefinition {
  id: WorkingIdentityArtifactId
  format: 'json' | 'markdown'
  delivery: WorkingIdentityDelivery[]
  userOwned: boolean
  provenance: 'byoc_export'
}

export interface ImplementationOrderStep {
  id: string
  label: string
}
