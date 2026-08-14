export type ArtifactRole = 'source' | 'derivative'
export type ArtifactStorageKind = 'managed_r2' | 'external_reference'
export type ArtifactEncryptionFamily = 'tmk' | 'kek' | 'legacy_unsealed'
export type ArtifactUploadState = 'reserved' | 'sealed' | 'finalized' | 'failed' | 'expired'

export interface ArtifactManifestEntry {
  uploadId: string
  role: ArtifactRole
  parentUploadId?: string | null
  primary: boolean
  filename?: string | null
  declaredMimeType?: string | null
  detectedMimeType: string
  byteLength: number
  plaintextSha256: string
  clientFileId?: string | null
}

export interface FinalizeArtifactCaptureInput {
  tenantId: string
  content: string
  title?: string | null
  scope: string
  provenance?: string | null
  clientName: string
  agentIdentity?: string | null
  modelRuntime?: string | null
  sourceRef?: string | null
  idempotencyKey: string
  artifacts: ArtifactManifestEntry[]
  declaredDerivativeUploadIds?: string[]
}

export interface ArtifactUploadReceipt {
  operationId: string
  uploadId: string
  artifactId: string
  status: ArtifactUploadState
  byteLength: number
  plaintextSha256: string
  ciphertextSha256: string | null
  encryptionFamily: ArtifactEncryptionFamily | null
  expiresAt: number
  canonicalCaptureId: string | null
  canonicalDocumentId: string | null
  canonicalOperationId: string | null
  errorCode: string | null
}

export interface ArtifactManifestReceipt {
  artifactId: string
  uploadId: string
  role: ArtifactRole
  parentArtifactId: string | null
  primary: boolean
  mediaType: string
  byteLength: number
  plaintextSha256: string
  ciphertextSha256: string
  encryptionFamily: Exclude<ArtifactEncryptionFamily, 'legacy_unsealed'>
}

export interface FinalizeArtifactCaptureReceipt {
  status: 'finalized'
  captureId: string
  documentId: string
  operationId: string
  primaryArtifactId: string
  artifacts: ArtifactManifestReceipt[]
  clientName: string
  agentIdentity: string
}
