import { describe, expect, it } from 'vitest'
import type { AgentContextBundle } from '../src/types/chief-of-staff-context'
import type {
  WorkingSessionArtifact,
  WorkingSessionCanonicalEvidenceEmission,
  WorkingSessionContextBundleRef,
  WorkingSessionTranscriptEntry,
} from '../src/services/working-session'
import {
  boundScratchContext,
  buildSessionSummaryEvidenceEmission,
  collectCanonicalEvidenceEmissions,
  createSessionCloseSummary,
} from '../src/services/working-session'
import {
  captureWorkingSessionAdapterEvidence,
  captureWorkingSessionEvidenceEmissions,
  type WorkingSessionAdapter,
  type WorkingSessionEvidenceCaptureMetadata,
  type WorkingSessionEvidenceCaptureSink,
  type WorkingSessionSummaryCaptureInput,
} from '../src/services/working-session-capture-bridge'
import * as bridgeModule from '../src/services/working-session-capture-bridge'

class RecordingCaptureSink implements WorkingSessionEvidenceCaptureSink {
  readonly calls: Array<{
    input: WorkingSessionSummaryCaptureInput
    metadata: WorkingSessionEvidenceCaptureMetadata
  }> = []

  captureSessionSummary(
    input: WorkingSessionSummaryCaptureInput,
    metadata: WorkingSessionEvidenceCaptureMetadata,
  ): Record<string, unknown> {
    this.calls.push({ input, metadata })
    return { fake_capture_id: `capture-${metadata.emissionId}` }
  }
}

class FailingCaptureSink implements WorkingSessionEvidenceCaptureSink {
  readonly calls: WorkingSessionSummaryCaptureInput[] = []

  captureSessionSummary(input: WorkingSessionSummaryCaptureInput): Record<string, unknown> {
    this.calls.push(input)
    throw new Error('fake capture failure')
  }
}

function transcriptEntry(): WorkingSessionTranscriptEntry {
  return {
    kind: 'transcript_entry',
    id: 'turn-11-6',
    role: 'assistant',
    content: 'Session summary: this raw transcript text is not canonical evidence.',
    createdAt: 11,
    canonicalDisposition: 'volatile_non_canonical',
  }
}

function contextBundle(): WorkingSessionContextBundleRef {
  const bundle: AgentContextBundle = {
    agent: 'chief_of_staff',
    intent: 'project',
    target: 'Northgate Studio',
    scope: 'project:northgate',
    summary: 'Read-only context bundle for Northgate Studio.',
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
    id: 'ctx-11-6',
    source: 'prepare_context_for_agent',
    attachedAt: 16,
    bundle,
    readonly: true,
    canonicalDisposition: 'read_only_non_canonical',
  }
}

function sessionSummaryEmission(): WorkingSessionCanonicalEvidenceEmission {
  return buildSessionSummaryEvidenceEmission(createSessionCloseSummary({
    id: 'summary-11-6',
    sessionId: 'session-11-6',
    content: 'Session summary: captured only the explicit close summary through a fake sink.',
    scope: 'project:northgate',
    title: 'Northgate working session close',
    clientName: 'Codex',
    createdAt: 17,
  }))
}

describe('11.6 working-session adapter and summary capture bridge', () => {
  it('does not capture raw transcript, scratch, or read-only context artifacts', async () => {
    const summary = createSessionCloseSummary({
      id: 'summary-filtered',
      sessionId: 'session-filtered',
      content: 'Session summary: only this explicit close summary should be capturable.',
      scope: 'project:northgate',
      title: 'Filtered session close',
      clientName: 'Codex',
      createdAt: 18,
    })
    const artifacts: WorkingSessionArtifact[] = [
      transcriptEntry(),
      ...boundScratchContext([
        { id: 'scratch-1', content: 'local thought only', createdAt: 12 },
        { id: 'scratch-2', content: 'temporary note only', createdAt: 13 },
      ], { maxEntries: 2, maxCharsPerEntry: 40 }).notes,
      contextBundle(),
      summary,
    ]
    const emissions = collectCanonicalEvidenceEmissions(artifacts)
    const sink = new RecordingCaptureSink()

    const result = await captureWorkingSessionEvidenceEmissions(emissions, sink)

    expect(emissions).toHaveLength(1)
    expect(sink.calls).toHaveLength(1)
    expect(sink.calls[0]?.input.content).toBe(summary.content)
    expect(result.captured).toHaveLength(1)
    expect(result.skipped).toHaveLength(0)
    expect(result.failed).toHaveLength(0)
  })

  it('sends only session-summary capture inputs and preserves write-policy state', async () => {
    const sink = new RecordingCaptureSink()
    const adapter: WorkingSessionAdapter = {
      readCanonicalEvidenceEmissions: () => [sessionSummaryEmission()],
    }

    const result = await captureWorkingSessionAdapterEvidence(adapter, sink)

    expect(sink.calls).toHaveLength(1)
    expect(sink.calls[0]?.input).toMatchObject({
      capture_mode: 'session_summary',
      memory_type: 'episodic',
      provenance: 'agent_authored',
      session_id: 'session-11-6',
    })
    expect(sink.calls[0]?.metadata).toMatchObject({
      source: 'session_close_summary',
      captureMode: 'session_summary',
      writePolicy: 'haetsal_write_policy_required',
      canonicalTruthBoundary: 'postgres_r2_hyperdrive',
      requiresHaetsalWritePolicy: true,
    })
    expect(result.captured[0]).toMatchObject({
      status: 'captured',
      captureMode: 'session_summary',
      writePolicy: 'haetsal_write_policy_required',
      canonicalTruthBoundary: 'postgres_r2_hyperdrive',
      requiresHaetsalWritePolicy: true,
      acceptedBySink: true,
    })
    expect(result.captured[0]?.captureInput.capture_mode).toBe('session_summary')
  })

  it('skips emissions that do not keep the explicit session-summary contract', async () => {
    const valid = sessionSummaryEmission()
    const invalid = {
      ...valid,
      capture: { ...valid.capture, capture_mode: 'explicit' },
    } as unknown as WorkingSessionCanonicalEvidenceEmission
    const sink = new RecordingCaptureSink()

    const result = await captureWorkingSessionEvidenceEmissions([invalid], sink)

    expect(sink.calls).toHaveLength(0)
    expect(result.results).toHaveLength(1)
    expect(result.skipped[0]).toMatchObject({
      status: 'skipped',
      reason: 'not_session_summary_capture',
      acceptedBySink: false,
    })
    expect(result.captured).toHaveLength(0)
    expect(result.failed).toHaveLength(0)
  })

  it('reports fake sink failures without accepting failed captures', async () => {
    const sink = new FailingCaptureSink()

    const result = await captureWorkingSessionEvidenceEmissions([sessionSummaryEmission()], sink)

    expect(sink.calls).toHaveLength(1)
    expect(result.captured).toHaveLength(0)
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]).toMatchObject({
      status: 'failed',
      reason: 'capture_sink_failed',
      acceptedBySink: false,
      captureMode: 'session_summary',
      writePolicy: 'haetsal_write_policy_required',
    })
    expect(result.failed[0]?.captureInput.capture_mode).toBe('session_summary')
  })

  it('exposes only dependency-injected runtime bridge functions', () => {
    expect(Object.keys(bridgeModule).sort()).toEqual([
      'captureWorkingSessionAdapterEvidence',
      'captureWorkingSessionEvidenceEmissions',
    ])
  })
})
