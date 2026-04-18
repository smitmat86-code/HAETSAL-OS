export type CanonicalProjectionKind = 'hindsight' | 'graphiti'

export type CanonicalArtifactMode = 'inline_encrypted' | 'stored_r2'

export interface CanonicalArtifactRef {
  mode?: CanonicalArtifactMode
  filename?: string | null
  mediaType?: string | null
  storageKey?: string | null
  contentEncrypted?: string | null
  byteLength?: number | null
  sha256?: string | null
}

export interface CanonicalCaptureInput {
  tenantId: string
  sourceSystem: string
  sourceRef?: string | null
  scope: string
  title?: string | null
  body: string
  bodyEncrypted?: string | null
  artifactRef?: CanonicalArtifactRef | null
  capturedAt?: number | null
}

export interface CanonicalCaptureResult {
  captureId: string
  documentId: string
  chunkIds: string[]
  operationId: string
  projectionJobIds: string[]
}
