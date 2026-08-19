import type {
  CanonicalArtifactRef,
  CanonicalCaptureInput,
  CanonicalProjectionKind,
} from '../types/canonical-memory'
import { assertCanonicalArtifactManifestShape } from './canonical-artifact-manifest'

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
  role: 'source' | 'derivative'
  parentArtifactId: string | null
  primary: boolean
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
  artifacts: CanonicalArtifactPlan[]
  primaryArtifact: CanonicalArtifactPlan | null
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

export function toNormalizedArtifacts(input: Pick<CanonicalCaptureInput, 'artifactRef' | 'artifactRefs'>): CanonicalArtifactPlan[] {
  const refs = input.artifactRefs?.length
    ? input.artifactRefs
    : input.artifactRef
      ? [input.artifactRef]
      : []
  const plans = refs.map((ref, index) => ({
    id: ref.artifactId?.trim() || crypto.randomUUID(),
    ref,
    role: ref.role ?? ('source' as const),
    parentArtifactId: ref.parentArtifactId ?? null,
    primary: ref.primary ?? index === 0,
  }))
  if (plans.length === 0) return plans
  assertCanonicalArtifactManifestShape(plans.map(plan => ({
    id: plan.id,
    role: plan.role,
    parentId: plan.parentArtifactId,
    primary: plan.primary,
  })))
  return plans
}
