import type {
  CanonicalArtifactRef,
  CanonicalCaptureInput,
  CanonicalProjectionKind,
} from '../types/canonical-memory'

export interface CanonicalChunkPlan {
  id: string
  ordinal: number
  startOffset: number
  endOffset: number
  text: string
}

export interface CanonicalArtifactPlan {
  id: string
  ref: CanonicalArtifactRef
}

export interface NormalizedCanonicalCapture {
  captureId: string
  documentId: string
  operationId: string
  projectionKinds: CanonicalProjectionKind[]
  tenantId: string
  sourceSystem: string
  sourceRef: string | null
  scope: string
  title: string | null
  body: string
  bodyEncrypted: string
  artifact: CanonicalArtifactPlan | null
  capturedAt: number
}

export interface CanonicalShadowCaptureArgs {
  tenantId: string
  sourceSystem: string
  sourceRef?: string | null
  scope: string
  title?: string | null
  body: string
  bodyEncrypted?: string | null
}

export function toNormalizedArtifact(
  artifactRef?: CanonicalCaptureInput['artifactRef'],
): CanonicalArtifactPlan | null {
  if (!artifactRef) return null
  return { id: crypto.randomUUID(), ref: artifactRef }
}
