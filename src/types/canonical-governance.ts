export const CANONICAL_MEMORY_CLASSES = [
  'raw_source',
  'episode',
  'observation',
  'claim',
  'fact',
  'preference',
  'procedure',
  'compiled_view',
] as const
export type CanonicalMemoryClass = (typeof CANONICAL_MEMORY_CLASSES)[number]

export const CANONICAL_TRUST_STATES = [
  'evidence',
  'inferred',
  'user_confirmed',
  'trusted_import',
  'disputed',
  'stale',
  'superseded',
  'rejected',
] as const
export type CanonicalTrustState = (typeof CANONICAL_TRUST_STATES)[number]

export const CANONICAL_USE_POLICIES = [
  'can_use_as_evidence',
  'can_use_as_instruction',
  'requires_confirmation',
  'do_not_inject_automatically',
] as const
export type CanonicalUsePolicy = (typeof CANONICAL_USE_POLICIES)[number]

export const CANONICAL_AUTHOR_KINDS = ['user', 'agent', 'cron', 'external_client', 'system'] as const
export type CanonicalAuthorKind = (typeof CANONICAL_AUTHOR_KINDS)[number]

export const CANONICAL_RETENTIONS = ['standard', 'ephemeral', 'permanent'] as const
export type CanonicalRetention = (typeof CANONICAL_RETENTIONS)[number]

/** Provenance envelope required on every canonical memory write (HAETSAL_MISSION.md Phase 1). */
export interface CanonicalProvenanceEnvelope {
  sourceSystem: string
  sourceRef: string | null
  capturedAt: number
  scope: string
  authorKind: CanonicalAuthorKind
  agentIdentity: string | null
  modelRuntime: string | null
  confidence: number | null
  retention: CanonicalRetention
  provenanceNote: string | null
}

/** Governance verdict attached to a capture after resolution rules run. */
export interface CanonicalGovernanceDecision {
  memoryClass: CanonicalMemoryClass
  trustState: CanonicalTrustState
  usePolicy: CanonicalUsePolicy
  envelope: CanonicalProvenanceEnvelope
  /** Set when the requested class/trust was downgraded by policy (e.g. agent-claimed fact). */
  downgraded: { requestedClass?: string; requestedTrustState?: string; reason: string } | null
}

export interface CanonicalGovernanceRequest {
  sourceSystem: string
  sourceRef?: string | null
  capturedAt?: number | null
  scope: string
  authorKind?: CanonicalAuthorKind
  agentIdentity?: string | null
  modelRuntime?: string | null
  confidence?: number | null
  retention?: CanonicalRetention | null
  provenanceNote?: string | null
  memoryClass?: CanonicalMemoryClass | null
  trustState?: CanonicalTrustState | null
  usePolicy?: CanonicalUsePolicy | null
  /** Legacy memory type retained for continuity with pre-mission writers. */
  legacyMemoryType?: 'episodic' | 'semantic' | 'world' | null
}
