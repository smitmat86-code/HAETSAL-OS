import { describe, expect, it } from 'vitest'
import type { AgentContextBundle } from '../src/types/chief-of-staff-context'
import type {
  WorkingSessionArtifact,
  WorkingSessionCloseSummary,
  WorkingSessionContextBundleRef,
  WorkingSessionTranscriptEntry,
} from '../src/services/working-session'
import {
  WORKING_SESSION_BOUNDARY,
  boundScratchContext,
  collectCanonicalEvidenceEmissions,
  createSessionCloseSummary,
} from '../src/services/working-session'

class InMemoryWorkingSessionAdapter {
  private readonly artifacts: WorkingSessionArtifact[] = []

  appendTranscript(entry: WorkingSessionTranscriptEntry): void {
    this.artifacts.push(entry)
  }

  addScratch(notes: Array<{ id: string; content: string; createdAt: number }>): void {
    this.artifacts.push(...boundScratchContext(notes, { maxEntries: 2, maxCharsPerEntry: 24 }).notes)
  }

  attachContext(bundle: WorkingSessionContextBundleRef): void {
    this.artifacts.push(bundle)
  }

  closeWithSummary(summary: WorkingSessionCloseSummary): void {
    this.artifacts.push(summary)
  }

  canonicalEvidence() {
    return collectCanonicalEvidenceEmissions(this.artifacts)
  }
}

function contextBundle(): WorkingSessionContextBundleRef {
  const bundle: AgentContextBundle = {
    agent: 'chief_of_staff',
    intent: 'project',
    target: 'Northgate Studio',
    scope: 'project:northgate',
    summary: 'Compiled context for Northgate Studio.',
    confidence: { level: 'high', rationale: 'Compiled context pack is fresh.' },
    highlights: ['Northgate is active.'],
    recentChanges: [],
    openLoops: [],
    risks: [],
    timeline: [],
    relationships: [],
    followUpQuestions: [],
    gaps: [],
    sources: [],
    evidence: [],
    compiled: null,
  }
  return {
    kind: 'read_only_context_bundle',
    id: 'ctx-11-5',
    source: 'prepare_context_for_agent',
    attachedAt: 11,
    bundle,
    readonly: true,
    canonicalDisposition: 'read_only_non_canonical',
  }
}

describe('11.5 HAETSAL working-session abstraction', () => {
  it('keeps raw transcript, working notes, and read-only context out of canonical evidence', () => {
    const adapter = new InMemoryWorkingSessionAdapter()
    adapter.appendTranscript({
      kind: 'transcript_entry',
      id: 'turn-1',
      role: 'assistant',
      content: 'Session summary: this is still just raw transcript text.',
      createdAt: 1,
      canonicalDisposition: 'volatile_non_canonical',
    })
    adapter.addScratch([
      { id: 'note-1', content: 'draft thought that should not be durable', createdAt: 2 },
      { id: 'note-2', content: 'local scratch about a possible next action', createdAt: 3 },
      { id: 'note-3', content: 'latest scratch survives only inside the bound', createdAt: 4 },
    ])
    adapter.attachContext(contextBundle())

    expect(adapter.canonicalEvidence()).toEqual([])
  })

  it('emits capture_mode session_summary only for explicit session close summaries', () => {
    const adapter = new InMemoryWorkingSessionAdapter()
    adapter.closeWithSummary(createSessionCloseSummary({
      id: 'summary-11-5',
      sessionId: 'session-11-5',
      content: 'Session summary: chose a HAETSAL-owned adapter boundary and left production agents unwired.',
      scope: 'project:northgate',
      title: 'Northgate working session close',
      clientName: 'Codex',
      createdAt: 5,
    }))

    const [emission] = adapter.canonicalEvidence()
    expect(emission.captureMode).toBe('session_summary')
    expect(emission.capture).toMatchObject({
      capture_mode: 'session_summary',
      memory_type: 'episodic',
      provenance: 'agent_authored',
      session_id: 'session-11-5',
      client_name: 'Codex',
      scope: 'project:northgate',
    })
    expect(emission.summary.requiresHaetsalWritePolicy).toBe(true)
    expect(emission.canonicalTruthBoundary).toBe('postgres_r2_hyperdrive')
    expect(emission.writePolicy).toBe('haetsal_write_policy_required')
  })

  it('keeps the contract HAETSAL-owned with no upstream session or chat-memory dependency', () => {
    expect(WORKING_SESSION_BOUNDARY).toMatchObject({
      activeConversationHistory: 'volatile_non_canonical',
      scratchContext: 'volatile_non_canonical',
      readOnlyContextBundles: 'read_only_non_canonical',
      sessionCloseSummaries: 'canonical_evidence_candidate',
      canonicalTruth: 'postgres_r2_hyperdrive',
      instructionGradeMemory: 'haetsal_write_policy_required',
      upstreamSessionAdapter: 'haetsal_owned',
    })

    const boundaryText = JSON.stringify(WORKING_SESSION_BOUNDARY).toLowerCase()
    const disallowed = [
      ['agents', 'experimental', 'memory', 'session'].join('/'),
      ['@cloudflare', 'think'].join('/'),
      ['@cloudflare', 'ai-chat'].join('/'),
      ['@cloudflare', 'shell'].join('/'),
      ['workers', 'ai', 'provider'].join('-'),
      ['hind', 'sight'].join(''),
    ]
    expect(disallowed.every(term => !boundaryText.includes(term))).toBe(true)
  })
})
