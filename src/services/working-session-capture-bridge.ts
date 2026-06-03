import type { ExternalClientCaptureInput } from '../types/external-client-memory'
import type { WorkingSessionCanonicalEvidenceEmission, WorkingSessionCloseSummary } from './working-session'

export type WorkingSessionSummaryCaptureInput = ExternalClientCaptureInput & { capture_mode: 'session_summary' }
type MaybePromise<T> = T | Promise<T>
type CaptureModeState = 'session_summary' | 'unknown'
type WritePolicyState = 'haetsal_write_policy_required' | 'unknown'
type CanonicalTruthBoundaryState = 'postgres_r2_hyperdrive' | 'unknown'
export interface WorkingSessionAdapter {
  readCanonicalEvidenceEmissions(): MaybePromise<readonly WorkingSessionCanonicalEvidenceEmission[]>
}

export interface WorkingSessionEvidenceCaptureMetadata {
  emissionId: string
  summaryId: string | null
  sessionId: string | null
  source: 'session_close_summary' | 'unknown'
  captureMode: CaptureModeState
  writePolicy: WritePolicyState
  canonicalTruthBoundary: CanonicalTruthBoundaryState
  requiresHaetsalWritePolicy: boolean
}

export interface WorkingSessionEvidenceCaptureSink {
  captureSessionSummary(
    input: WorkingSessionSummaryCaptureInput,
    metadata: WorkingSessionEvidenceCaptureMetadata,
  ): MaybePromise<Record<string, unknown>>
}

export type WorkingSessionEvidenceSkipReason =
  | 'not_explicit_session_close_summary'
  | 'not_session_summary_capture'
  | 'write_policy_boundary_missing'
  | 'canonical_truth_boundary_mismatch'

type ResultBase = WorkingSessionEvidenceCaptureMetadata
export type WorkingSessionEvidenceCapturedResult = ResultBase & {
  status: 'captured'
  captureInput: WorkingSessionSummaryCaptureInput
  sinkResult: Record<string, unknown>
  acceptedBySink: true
}
export type WorkingSessionEvidenceSkippedResult = ResultBase & {
  status: 'skipped'
  reason: WorkingSessionEvidenceSkipReason
  acceptedBySink: false
}
export type WorkingSessionEvidenceFailedResult = ResultBase & {
  status: 'failed'
  reason: 'capture_sink_failed'
  captureInput: WorkingSessionSummaryCaptureInput
  error: { name: string; message: string }
  acceptedBySink: false
}
export type WorkingSessionEvidenceCaptureResult =
  | WorkingSessionEvidenceCapturedResult
  | WorkingSessionEvidenceSkippedResult
  | WorkingSessionEvidenceFailedResult

export interface WorkingSessionEvidenceCaptureBatchResult {
  results: WorkingSessionEvidenceCaptureResult[]; captured: WorkingSessionEvidenceCapturedResult[]
  skipped: WorkingSessionEvidenceSkippedResult[]; failed: WorkingSessionEvidenceFailedResult[]
}

function emissionMetadata(
  emission: Partial<WorkingSessionCanonicalEvidenceEmission>,
  index: number,
): WorkingSessionEvidenceCaptureMetadata {
  const summary = emission.summary as Partial<WorkingSessionCloseSummary> | undefined
  return {
    emissionId: typeof summary?.id === 'string' && summary.id ? summary.id : `working-session-emission-${index}`,
    summaryId: typeof summary?.id === 'string' ? summary.id : null,
    sessionId: typeof summary?.sessionId === 'string' ? summary.sessionId : null,
    source: emission.source === 'session_close_summary' ? 'session_close_summary' : 'unknown',
    captureMode: emission.captureMode === 'session_summary' ? 'session_summary' : 'unknown',
    writePolicy: emission.writePolicy === 'haetsal_write_policy_required' ? 'haetsal_write_policy_required' : 'unknown',
    canonicalTruthBoundary: emission.canonicalTruthBoundary === 'postgres_r2_hyperdrive' ? 'postgres_r2_hyperdrive' : 'unknown',
    requiresHaetsalWritePolicy: summary?.requiresHaetsalWritePolicy === true,
  }
}

function skipReason(
  emission: Partial<WorkingSessionCanonicalEvidenceEmission>,
): WorkingSessionEvidenceSkipReason | null {
  const summary = emission.summary as Partial<WorkingSessionCloseSummary> | undefined
  if (
    emission.kind !== 'canonical_evidence_emission' ||
    emission.source !== 'session_close_summary' ||
    summary?.kind !== 'session_close_summary' ||
    summary.canonicalDisposition !== 'session_summary_evidence_candidate'
  ) return 'not_explicit_session_close_summary'
  if (emission.captureMode !== 'session_summary' || emission.capture?.capture_mode !== 'session_summary') return 'not_session_summary_capture'
  if (emission.writePolicy !== 'haetsal_write_policy_required' || summary.requiresHaetsalWritePolicy !== true) return 'write_policy_boundary_missing'
  if (emission.canonicalTruthBoundary !== 'postgres_r2_hyperdrive') return 'canonical_truth_boundary_mismatch'
  return null
}

function normalizeCaptureError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message }
  return { name: 'Error', message: 'Capture sink failed' }
}

export async function captureWorkingSessionEvidenceEmissions(
  emissions: readonly WorkingSessionCanonicalEvidenceEmission[],
  sink: WorkingSessionEvidenceCaptureSink,
): Promise<WorkingSessionEvidenceCaptureBatchResult> {
  const results: WorkingSessionEvidenceCaptureResult[] = []

  for (const [index, emission] of emissions.entries()) {
    const metadata = emissionMetadata(emission, index)
    const reason = skipReason(emission)
    if (reason) {
      results.push({ ...metadata, status: 'skipped', reason, acceptedBySink: false })
      continue
    }
    const captureInput = emission.capture as WorkingSessionSummaryCaptureInput
    try {
      const sinkResult = await sink.captureSessionSummary(captureInput, metadata)
      results.push({ ...metadata, status: 'captured', captureInput, sinkResult, acceptedBySink: true })
    } catch (error) {
      results.push({
        ...metadata,
        status: 'failed',
        reason: 'capture_sink_failed',
        captureInput,
        error: normalizeCaptureError(error),
        acceptedBySink: false,
      })
    }
  }

  return {
    results,
    captured: results.filter((result): result is WorkingSessionEvidenceCapturedResult => result.status === 'captured'),
    skipped: results.filter((result): result is WorkingSessionEvidenceSkippedResult => result.status === 'skipped'),
    failed: results.filter((result): result is WorkingSessionEvidenceFailedResult => result.status === 'failed'),
  }
}

export async function captureWorkingSessionAdapterEvidence(
  adapter: WorkingSessionAdapter,
  sink: WorkingSessionEvidenceCaptureSink,
): Promise<WorkingSessionEvidenceCaptureBatchResult> {
  return captureWorkingSessionEvidenceEmissions(await adapter.readCanonicalEvidenceEmissions(), sink)
}
