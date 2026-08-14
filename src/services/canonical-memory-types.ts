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
  if (plans.filter(plan => plan.primary).length !== 1 || plans.filter(plan => plan.role === 'source').length > 1) {
    throw new Error('Invalid canonical artifact manifest')
  }
  const ids = new Set(plans.map(plan => plan.id))
  if (ids.size !== plans.length) throw new Error('Duplicate canonical artifact id')
  const ordinals = new Map(plans.map((plan, ordinal) => [plan.id, ordinal]))
  for (const [ordinal, plan] of plans.entries()) {
    if (plan.parentArtifactId && !ids.has(plan.parentArtifactId)) throw new Error('Invalid canonical artifact parent')
    if (plan.parentArtifactId && (ordinals.get(plan.parentArtifactId) ?? ordinal) >= ordinal) {
      throw new Error('Canonical artifact parent must precede its derivative')
    }
    if (plan.role === 'source' && plan.parentArtifactId) throw new Error('Canonical source artifact cannot have a parent')
  }
  return plans
}
