import type { IngestionSource } from './ingestion'
import type { CanonicalArtifactRef, CanonicalProjectionKind } from './canonical-memory'

export type CanonicalCompatibilityMode = 'off' | 'current_hindsight'

export interface CanonicalPipelineCaptureInput {
  tenantId: string
  sourceSystem: IngestionSource
  sourceRef?: string | null
  scope: string
  title?: string | null
  body: string
  bodyEncrypted?: string | null
  artifactRef?: CanonicalArtifactRef | null
  capturedAt?: number | null
  memoryType?: 'episodic' | 'semantic' | 'world'
  compatibilityMode?: CanonicalCompatibilityMode
  provenance?: string | null
  metadata?: Record<string, unknown>
  dedupHash?: string | null
  salienceTier?: 1 | 2 | 3
  salienceSurpriseScore?: number
  hindsightAsync?: boolean
  canonicalCaptureId?: string
  canonicalDocumentId?: string
  canonicalOperationId?: string
}

export interface CanonicalProjectionDispatchMessage {
  type: 'canonical_projection_dispatch'
  tenantId: string
  payload: {
    captureId: string
    documentId: string
    operationId: string
    projectionKinds: CanonicalProjectionKind[]
  }
  enqueuedAt: number
}

export interface HindsightProjectionDispatchInput {
  tenantId: string
  captureId: string
  operationId: string
  projectionJobId: string
  projectionKind: 'hindsight'
}

export interface HindsightProjectionSubmissionResult {
  targetRef: string
  bankId: string | null
  documentId: string | null
  operationId: string | null
  status: 'queued' | 'completed'
}

export interface HindsightProjectionReconcileResult {
  projectionJobId: string
  projectionStatus: 'queued' | 'completed' | 'failed'
  resultStatus: 'queued' | 'completed' | 'failed'
  targetRef: string | null
  errorMessage?: string | null
}

export interface CompatibilityRetainResult {
  mode: CanonicalCompatibilityMode
  status: 'skipped' | 'queued' | 'retained' | 'failed'
  memoryId: string | null
  operationId: string | null
  documentId: string | null
  stoneR2Key: string | null
  errorMessage?: string | null
}

export interface CanonicalCapturePipelineResult {
  capture: {
    captureId: string
    documentId: string
    chunkIds: string[]
    operationId: string
    projectionJobIds: string[]
    projectionKinds: CanonicalProjectionKind[]
  }
  dispatch: {
    queue: 'QUEUE_BULK'
    status: 'queued'
    message: CanonicalProjectionDispatchMessage
  }
  compatibility: CompatibilityRetainResult
}
