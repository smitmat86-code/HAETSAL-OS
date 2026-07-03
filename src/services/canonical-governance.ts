import {
  CANONICAL_AUTHOR_KINDS,
  CANONICAL_MEMORY_CLASSES,
  CANONICAL_RETENTIONS,
  CANONICAL_TRUST_STATES,
  CANONICAL_USE_POLICIES,
  type CanonicalGovernanceDecision,
  type CanonicalGovernanceRequest,
  type CanonicalMemoryClass,
  type CanonicalTrustState,
} from '../types/canonical-governance'

export const CONSOLIDATION_AGENT_IDENTITY = 'consolidation_cron'

const LEGACY_MEMORY_TYPE_TO_CLASS: Record<string, CanonicalMemoryClass> = {
  episodic: 'episode',
  semantic: 'claim',
  world: 'observation',
}

/** Trust states only a user (or explicit review/policy promotion) may assign. */
const PROTECTED_TRUST_STATES: ReadonlySet<CanonicalTrustState> = new Set([
  'user_confirmed',
  'trusted_import',
])

function assertMember<T extends string>(value: string, allowed: readonly T[], label: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`Invalid ${label}: ${value}`)
  }
  return value as T
}

/**
 * Resolve the governance decision for a canonical memory write.
 *
 * Rules (HAETSAL_MISSION.md Phase 1 + Law 3):
 * - Non-user authors default to trust_state 'evidence' with use_policy
 *   'can_use_as_evidence'; protected trust states are downgraded, never granted.
 * - memory_class 'fact' from a non-user author is downgraded to 'claim'
 *   (facts exist only via promotion through policy or review).
 * - memory_class 'procedure' is rejected for any identity other than the
 *   consolidation cron (Law 3).
 * - use_policy 'can_use_as_instruction' from a non-user author is downgraded
 *   to 'can_use_as_evidence'.
 */
export function resolveCaptureGovernance(request: CanonicalGovernanceRequest): CanonicalGovernanceDecision {
  const authorKind = assertMember(request.authorKind ?? 'system', CANONICAL_AUTHOR_KINDS, 'author kind')
  const retention = assertMember(request.retention ?? 'standard', CANONICAL_RETENTIONS, 'retention')
  const isUserAuthored = authorKind === 'user'
  const isConsolidation = authorKind === 'cron' && request.agentIdentity === CONSOLIDATION_AGENT_IDENTITY

  let memoryClass: CanonicalMemoryClass = request.memoryClass
    ? assertMember(request.memoryClass, CANONICAL_MEMORY_CLASSES, 'memory class')
    : (request.legacyMemoryType ? LEGACY_MEMORY_TYPE_TO_CLASS[request.legacyMemoryType] : null) ?? 'raw_source'
  let trustState: CanonicalTrustState = request.trustState
    ? assertMember(request.trustState, CANONICAL_TRUST_STATES, 'trust state')
    : (isUserAuthored ? 'user_confirmed' : 'evidence')
  let usePolicy = request.usePolicy
    ? assertMember(request.usePolicy, CANONICAL_USE_POLICIES, 'use policy')
    : 'can_use_as_evidence' as const

  let downgraded: CanonicalGovernanceDecision['downgraded'] = null

  if (memoryClass === 'procedure' && !isConsolidation) {
    throw new Error('Law 3: procedure memories are written only by the consolidation cron')
  }

  if (!isUserAuthored) {
    if (memoryClass === 'fact') {
      downgraded = { requestedClass: 'fact', reason: 'facts require promotion via policy or review' }
      memoryClass = 'claim'
    }
    if (PROTECTED_TRUST_STATES.has(trustState)) {
      downgraded = {
        ...(downgraded ?? { reason: '' }),
        requestedTrustState: trustState,
        reason: 'protected trust states require user authorship or review',
      }
      trustState = 'evidence'
    }
    if (usePolicy === 'can_use_as_instruction') {
      downgraded = {
        ...(downgraded ?? { reason: '' }),
        reason: 'instruction-grade use requires promotion via policy or review',
      }
      usePolicy = 'can_use_as_evidence'
    }
  }

  const confidence = request.confidence ?? null
  if (confidence !== null && (confidence < 0 || confidence > 1 || Number.isNaN(confidence))) {
    throw new Error(`Invalid confidence: ${String(request.confidence)}`)
  }

  return {
    memoryClass,
    trustState,
    usePolicy,
    downgraded,
    envelope: {
      sourceSystem: request.sourceSystem,
      sourceRef: request.sourceRef ?? null,
      capturedAt: request.capturedAt ?? Date.now(),
      scope: request.scope,
      authorKind,
      agentIdentity: request.agentIdentity ?? null,
      modelRuntime: request.modelRuntime ?? null,
      confidence,
      retention,
      provenanceNote: request.provenanceNote ?? null,
    },
  }
}
