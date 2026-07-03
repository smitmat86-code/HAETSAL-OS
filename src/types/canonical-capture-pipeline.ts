import type { IngestionSource } from './ingestion'
import type {
  CanonicalArtifactRef,
  CanonicalCaptureGovernanceInput,
  CanonicalProjectionKind,
} from './canonical-memory'

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
  provenance?: string | null
  metadata?: Record<string, unknown>
  dedupHash?: string | null
  salienceTier?: 1 | 2 | 3
  salienceSurpriseScore?: number
  eagerProjectionDispatch?: boolean
  projectionKinds?: CanonicalProjectionKind[] | null
  governance?: CanonicalCaptureGovernanceInput | null
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

export interface CanonicalCapturePipelineResult {
  capture: {
    captureId: string
    documentId: string
    artifactId: string | null
    chunkIds: string[]
    operationId: string
    projectionJobIds: string[]
    projectionKinds: CanonicalProjectionKind[]
    bodyR2Key: string
    governance: import('./canonical-memory').CanonicalCaptureResult['governance']
  }
  dispatch: {
    queue: 'QUEUE_BULK'
    status: 'queued'
    message: CanonicalProjectionDispatchMessage
  }
}
