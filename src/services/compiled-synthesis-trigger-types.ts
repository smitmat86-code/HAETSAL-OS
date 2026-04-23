import type { ProjectCompilationSubject } from './compiled-synthesis-compiler-types'

export type CanonicalCompiledChangeType = 'capture_created' | 'document_updated' | 'artifact_updated'

export interface CanonicalCompiledChangedRecords {
  captureId: string | null
  documentId: string | null
  artifactId: string | null
  operationId: string | null
}

export interface CanonicalCompiledSubjectHint {
  subjectKind: 'project'
  stableKey: string
  name: string
  scope: string
  keywords: string[]
  evidence: 'source_ref' | 'title' | 'body'
}

export interface CanonicalCompiledChangeEvent {
  tenantId: string
  changeType: CanonicalCompiledChangeType
  scope: string
  sourceSystem: string
  sourceRef: string | null
  title: string | null
  changedRecords: CanonicalCompiledChangedRecords
  subjectHints: CanonicalCompiledSubjectHint[]
}

export type CompiledRefreshTargetFamily = 'dossier' | 'context_pack' | 'what_changed'

export interface CompiledRefreshTarget {
  family: CompiledRefreshTargetFamily
  stableKey: string
  scope: string
  subjectStableKey: string
  subjectKind: 'project'
  reason: string
}

export interface CompiledRefreshDispatchJob {
  jobKind: 'project_compilation'
  subject: ProjectCompilationSubject
  targetStableKeys: string[]
  reason: string
}

export interface PlannedCompiledRefresh {
  event: CanonicalCompiledChangeEvent
  targets: CompiledRefreshTarget[]
  dispatchJobs: CompiledRefreshDispatchJob[]
}

export interface CompiledRefreshDispatchRecord {
  jobKind: CompiledRefreshDispatchJob['jobKind']
  subjectStableKey: string
  targetStableKeys: string[]
  sourceFingerprint: string
  sourceCount: number
}

export interface CompiledRefreshSkippedRecord {
  jobKind: CompiledRefreshDispatchJob['jobKind']
  subjectStableKey: string
  targetStableKeys: string[]
  reason: string
}

export interface CompiledRefreshFailedRecord {
  jobKind: CompiledRefreshDispatchJob['jobKind']
  subjectStableKey: string
  targetStableKeys: string[]
  error: string
}

export interface DispatchTargetedCompiledRefreshResult {
  plan: PlannedCompiledRefresh
  dispatched: CompiledRefreshDispatchRecord[]
  skipped: CompiledRefreshSkippedRecord[]
  failed: CompiledRefreshFailedRecord[]
}
