import type {
  BrainClientFixture,
  BrainClientMapping,
  BrainProvenanceClass,
  BrainSourceFixture,
  BrainSourceIngestionDefinition,
  BrainSurfaceDefinition,
  BrainSurfaceId,
  ImplementationOrderStep,
  WorkingIdentityArtifactDefinition,
  WorkingIdentityArtifactId,
} from '../types/external-brain'
import { BRAIN_MEMORY_TOOL_NAMES } from '../tools/brain-memory-surface'

const sharedByocDelivery = ['file', 'mcp-record'] as const

export const EXTERNAL_BRAIN_SURFACES: BrainSurfaceDefinition[] = [
  {
    id: 'brain-memory',
    status: 'live',
    riskLevel: 'lowest',
    purpose: 'Capture and query canonical brain memory without source traversal or mutation.',
    clients: ['Codex', 'Claude Code', 'Cursor', 'first-party HAETSAL agents'],
    operations: [
      ...BRAIN_MEMORY_TOOL_NAMES.map((id) => ({ id, actionClass: 'memory' as const, live: true, description: `${id} is part of the live memory-only surface.` })),
    ],
  },
  {
    id: 'brain-sources-read',
    status: 'planned',
    riskLevel: 'medium',
    purpose: 'Read connected sources selectively and capture into the one canonical brain.',
    clients: ['Google ingestion workers', 'future trusted source connectors', 'later trusted first-party agents'],
    operations: [
      { id: 'gmail.read_thread', actionClass: 'source-read', live: false, description: 'Read Gmail threads without mailbox mirroring.' },
      { id: 'calendar.read_event', actionClass: 'source-read', live: false, description: 'Read calendar events while the source remains authoritative.' },
      { id: 'drive.read_document', actionClass: 'source-read', live: false, description: 'Read explicitly included Drive or Docs content only.' },
      { id: 'source.capture_selective', actionClass: 'source-read', live: false, description: 'Selectively capture source-derived memory into the canonical pipeline.' },
    ],
  },
  {
    id: 'brain-actions',
    status: 'deferred',
    riskLevel: 'highest',
    purpose: 'Handle external system mutation behind stronger review and approval boundaries.',
    clients: ['future chief-of-staff / ops agents'],
    operations: [
      { id: 'gmail.send_email', actionClass: 'source-write', live: false, description: 'Deferred external email mutation.' },
      { id: 'calendar.create_or_update', actionClass: 'source-write', live: false, description: 'Deferred calendar mutation.' },
      { id: 'docs.edit_file', actionClass: 'source-write', live: false, description: 'Deferred document mutation.' },
    ],
  },
]

export const EXTERNAL_BRAIN_CLIENT_MAPPINGS: BrainClientMapping[] = [
  { clientClass: 'mcp-native-coding-client', connectionPattern: 'remote-mcp', defaultSurface: 'brain-memory', portabilityBridge: false },
  { clientClass: 'first-party-agent', connectionPattern: 'internal-worker', defaultSurface: 'brain-memory', portabilityBridge: false },
  { clientClass: 'web-ai-client', connectionPattern: 'byoc-portability', defaultSurface: null, portabilityBridge: true },
  { clientClass: 'source-connector', connectionPattern: 'queue-webhook-ingestion', defaultSurface: 'brain-sources-read', portabilityBridge: false },
]

export const EXTERNAL_CLIENT_FIXTURES: BrainClientFixture[] = [
  { name: 'Codex', clientClass: 'mcp-native-coding-client', expectedSurface: 'brain-memory' },
  { name: 'Claude Code', clientClass: 'mcp-native-coding-client', expectedSurface: 'brain-memory' },
  { name: 'Cursor', clientClass: 'mcp-native-coding-client', expectedSurface: 'brain-memory' },
  { name: 'ChatGPT web', clientClass: 'web-ai-client', expectedSurface: null },
  { name: 'Claude web', clientClass: 'web-ai-client', expectedSurface: null },
  { name: 'Gemini web', clientClass: 'web-ai-client', expectedSurface: null },
]

export const EXTERNAL_BRAIN_SOURCES: BrainSourceIngestionDefinition[] = [
  { sourceClass: 'event-driven-source-read', pattern: 'Webhook or push event followed by queue fetch and selective canonical capture.', examples: ['Gmail', 'Calendar'], selective: true, sourceOfTruthRemainsExternal: true },
  { sourceClass: 'explicit-file-ingestion', pattern: 'Explicit inclusion rules such as folders, tags, or metadata markers.', examples: ['Drive/Docs', 'Obsidian bridge'], selective: true, sourceOfTruthRemainsExternal: true },
  { sourceClass: 'historical-import', pattern: 'Bounded bootstrap import kept separate from live ongoing capture.', examples: ['Gmail history', 'Calendar history', 'Drive history'], selective: true, sourceOfTruthRemainsExternal: true },
  { sourceClass: 'external-action', pattern: 'Deferred mutation lane with explicit approval bias.', examples: ['Send email', 'Create events', 'Edit docs'], selective: false, sourceOfTruthRemainsExternal: true },
]

export const EXTERNAL_SOURCE_FIXTURES: BrainSourceFixture[] = [
  { name: 'Gmail', sourceClass: 'event-driven-source-read', expectedSurface: 'brain-sources-read' },
  { name: 'Calendar', sourceClass: 'event-driven-source-read', expectedSurface: 'brain-sources-read' },
  { name: 'Drive/Docs', sourceClass: 'explicit-file-ingestion', expectedSurface: 'brain-sources-read' },
]

export const CANONICAL_BRAIN_PROVENANCE: Array<{ id: BrainProvenanceClass; meaning: string }> = [
  { id: 'user_authored', meaning: 'Direct human-authored memory or note.' },
  { id: 'agent_authored', meaning: 'Intentional first-party agent output captured into the brain.' },
  { id: 'source_ingested', meaning: 'Selective live source-system capture.' },
  { id: 'bootstrap_import', meaning: 'Bounded historical import kept distinct from live capture.' },
  { id: 'byoc_export', meaning: 'Portable working-identity artifact derived from reviewed context.' },
]

export const PORTABLE_WORKING_IDENTITY_ARTIFACTS: WorkingIdentityArtifactDefinition[] = [
  { id: 'operating-model.json', format: 'json', delivery: [...sharedByocDelivery], userOwned: true, provenance: 'byoc_export' },
  { id: 'USER.md', format: 'markdown', delivery: [...sharedByocDelivery], userOwned: true, provenance: 'byoc_export' },
  { id: 'SOUL.md', format: 'markdown', delivery: [...sharedByocDelivery], userOwned: true, provenance: 'byoc_export' },
  { id: 'HEARTBEAT.md', format: 'markdown', delivery: [...sharedByocDelivery], userOwned: true, provenance: 'byoc_export' },
  { id: 'schedule-recommendations.json', format: 'json', delivery: [...sharedByocDelivery], userOwned: true, provenance: 'byoc_export' },
]

export const EXTERNAL_BRAIN_IMPLEMENTATION_ORDER: ImplementationOrderStep[] = [
  { id: 'brain-memory', label: 'Ship the memory-only external surface first.' },
  { id: 'client-capture-patterns', label: 'Add session-close and explicit capture patterns for coding clients.' },
  { id: 'brain-sources-read', label: 'Add Google read-only source ingestion next.' },
  { id: 'byoc-portability', label: 'Add BYOC export and import support for web clients after source-read.' },
  { id: 'brain-actions', label: 'Only evaluate source mutation after the lower-risk surfaces are proven.' },
]

export function getExternalBrainSurface(surfaceId: BrainSurfaceId): BrainSurfaceDefinition {
  return EXTERNAL_BRAIN_SURFACES.find((surface) => surface.id === surfaceId) ?? EXTERNAL_BRAIN_SURFACES[0]
}

export function validatePortableWorkingIdentityFamily(ids: string[]): {
  valid: boolean
  missing: WorkingIdentityArtifactId[]
} {
  const present = new Set(ids)
  const missing = PORTABLE_WORKING_IDENTITY_ARTIFACTS
    .map((artifact) => artifact.id)
    .filter((id) => !present.has(id))
  return { valid: missing.length === 0, missing }
}
