import type { AgentContextBundle } from '../types/chief-of-staff-context'
import type { ExternalClientCaptureInput } from '../types/external-client-memory'

export const WORKING_SESSION_BOUNDARY = {
  activeConversationHistory: 'volatile_non_canonical',
  scratchContext: 'volatile_non_canonical',
  readOnlyContextBundles: 'read_only_non_canonical',
  sessionCloseSummaries: 'canonical_evidence_candidate',
  canonicalTruth: 'postgres_r2_hyperdrive',
  instructionGradeMemory: 'haetsal_write_policy_required',
  upstreamSessionAdapter: 'haetsal_owned',
} as const

export type WorkingSessionRole = 'system' | 'user' | 'assistant' | 'tool'
export interface WorkingSessionTranscriptEntry {
  kind: 'transcript_entry'
  id: string
  role: WorkingSessionRole
  content: string
  createdAt: number
  canonicalDisposition: 'volatile_non_canonical'
}
export interface WorkingSessionScratchNote {
  kind: 'scratch_note'
  id: string
  content: string
  createdAt: number
  canonicalDisposition: 'volatile_non_canonical'
}
export interface BoundedWorkingScratchContext {
  maxEntries: number
  maxCharsPerEntry: number
  notes: readonly WorkingSessionScratchNote[]
  canonicalDisposition: 'volatile_non_canonical'
}
export interface WorkingSessionContextBundleRef {
  kind: 'read_only_context_bundle'
  id: string
  source: 'prepare_context_for_agent' | 'compiled_context' | 'runtime_context'
  attachedAt: number
  bundle: Readonly<AgentContextBundle>
  readonly: true
  canonicalDisposition: 'read_only_non_canonical'
}
export interface WorkingSessionCloseSummary {
  kind: 'session_close_summary'
  id: string
  sessionId: string
  content: string
  scope: string
  title: string | null
  clientName: string | null
  createdAt: number
  canonicalDisposition: 'session_summary_evidence_candidate'
  requiresHaetsalWritePolicy: true
}
export type WorkingSessionArtifact = WorkingSessionTranscriptEntry | WorkingSessionScratchNote | WorkingSessionContextBundleRef | WorkingSessionCloseSummary
export interface WorkingSessionCanonicalEvidenceEmission {
  kind: 'canonical_evidence_emission'
  source: 'session_close_summary'
  captureMode: 'session_summary'
  canonicalTruthBoundary: 'postgres_r2_hyperdrive'
  writePolicy: 'haetsal_write_policy_required'
  summary: WorkingSessionCloseSummary
  capture: ExternalClientCaptureInput & { capture_mode: 'session_summary' }
}
function requireText(value: string, label: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${label} is required`)
  return trimmed
}
export function boundScratchContext(
  notes: readonly Omit<WorkingSessionScratchNote, 'kind' | 'canonicalDisposition'>[],
  limits: { maxEntries: number; maxCharsPerEntry: number },
): BoundedWorkingScratchContext {
  if (limits.maxEntries < 1 || limits.maxCharsPerEntry < 1) {
    throw new Error('Scratch context limits must be positive')
  }
  return {
    maxEntries: limits.maxEntries,
    maxCharsPerEntry: limits.maxCharsPerEntry,
    canonicalDisposition: 'volatile_non_canonical',
    notes: notes.slice(-limits.maxEntries).map(note => ({
      kind: 'scratch_note',
      canonicalDisposition: 'volatile_non_canonical',
      ...note,
      content: requireText(note.content, 'Scratch note content').slice(0, limits.maxCharsPerEntry),
    })),
  }
}
export function createSessionCloseSummary(input: {
  id: string
  sessionId: string
  content: string
  scope: string
  title?: string | null
  clientName?: string | null
  createdAt: number
}): WorkingSessionCloseSummary {
  return {
    kind: 'session_close_summary',
    canonicalDisposition: 'session_summary_evidence_candidate',
    requiresHaetsalWritePolicy: true,
    ...input,
    title: input.title?.trim() || null,
    clientName: input.clientName?.trim() || null,
    content: requireText(input.content, 'Session close summary content'),
    scope: requireText(input.scope, 'Session summary scope'),
  }
}
export function isSessionSummaryEvidenceCandidate(
  artifact: WorkingSessionArtifact,
): artifact is WorkingSessionCloseSummary {
  return artifact.kind === 'session_close_summary'
}
export function buildSessionSummaryEvidenceEmission(
  summary: WorkingSessionCloseSummary,
): WorkingSessionCanonicalEvidenceEmission {
  return {
    kind: 'canonical_evidence_emission',
    source: 'session_close_summary',
    captureMode: 'session_summary',
    canonicalTruthBoundary: 'postgres_r2_hyperdrive',
    writePolicy: 'haetsal_write_policy_required',
    summary,
    capture: {
      content: summary.content,
      scope: summary.scope,
      memory_type: 'episodic',
      provenance: 'agent_authored',
      capture_mode: 'session_summary',
      client_name: summary.clientName,
      title: summary.title ?? 'Session summary',
      session_id: summary.sessionId,
    },
  }
}
export function collectCanonicalEvidenceEmissions(
  artifacts: readonly WorkingSessionArtifact[],
): WorkingSessionCanonicalEvidenceEmission[] {
  return artifacts
    .filter(isSessionSummaryEvidenceCandidate)
    .map(buildSessionSummaryEvidenceEmission)
}
