/**
 * Projection kind — engine names ('hindsight', 'graphiti') are historical;
 * both engines retired in mission Phase 3. Type is string to keep historical
 * DB rows readable while allowing future canonical projections.
 */
export type CanonicalProjectionKind = string

export type CanonicalArtifactMode = 'inline_encrypted' | 'stored_r2'

export interface CanonicalArtifactRef {
  /** Stable managed-artifact id. Omitted for legacy inline/reference captures. */
  artifactId?: string | null
  mode?: CanonicalArtifactMode
  storageKind?: 'managed_r2' | 'external_reference' | null
  filename?: string | null
  mediaType?: string | null
  storageKey?: string | null
  contentEncrypted?: string | null
  byteLength?: number | null
  sha256?: string | null
  cipherSha256?: string | null
  encryptionFamily?: 'tmk' | 'kek' | 'legacy_unsealed' | null
  role?: 'source' | 'derivative'
  parentArtifactId?: string | null
  primary?: boolean
}

export interface CanonicalCaptureGovernanceInput {
  authorKind?: import('./canonical-governance').CanonicalAuthorKind
  agentIdentity?: string | null
  modelRuntime?: string | null
  confidence?: number | null
  retention?: import('./canonical-governance').CanonicalRetention | null
  provenanceNote?: string | null
  memoryClass?: import('./canonical-governance').CanonicalMemoryClass | null
  trustState?: import('./canonical-governance').CanonicalTrustState | null
  usePolicy?: import('./canonical-governance').CanonicalUsePolicy | null
  legacyMemoryType?: 'episodic' | 'semantic' | 'world' | null
  dedupHash?: string | null
  salienceTier?: number | null
}

export interface CanonicalCaptureInput {
  tenantId: string
  captureId?: string | null
  documentId?: string | null
  operationId?: string | null
  sourceSystem: string
  sourceRef?: string | null
  scope: string
  title?: string | null
  body: string
  bodyEncrypted?: string | null
  artifactRef?: CanonicalArtifactRef | null
  artifactRefs?: CanonicalArtifactRef[] | null
  capturedAt?: number | null
  projectionKinds?: CanonicalProjectionKind[] | null
  governance?: CanonicalCaptureGovernanceInput | null
}

export interface CanonicalCaptureResult {
  captureId: string
  documentId: string
  artifactId: string | null
  artifactIds: string[]
  chunkIds: string[]
  operationId: string
  projectionJobIds: string[]
  projectionKinds: CanonicalProjectionKind[]
  /** R2 key of the encrypted archival body. */
  bodyR2Key: string
  /** Chunk plaintext (in-memory only) for the post-capture embedding hook. */
  chunkTexts: Array<{ id: string; text: string }>
  /** Provenance-tagged governance receipt for the write (Phase 1). */
  governance: {
    memoryClass: import('./canonical-governance').CanonicalMemoryClass
    trustState: import('./canonical-governance').CanonicalTrustState
    usePolicy: import('./canonical-governance').CanonicalUsePolicy
    authorKind: import('./canonical-governance').CanonicalAuthorKind
    agentIdentity: string | null
    downgraded: { requestedClass?: string; requestedTrustState?: string; reason: string } | null
  }
}
