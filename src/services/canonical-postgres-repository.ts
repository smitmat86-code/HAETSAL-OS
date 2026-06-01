import { neon } from '@neondatabase/serverless'
import type { CanonicalGraphIdentityMapping } from '../types/canonical-graph-projection'
import { CANONICAL_POSTGRES_SCHEMA } from './canonical-postgres-schema'
import type {
  CanonicalArtifactRecord,
  CanonicalCaptureRecord,
  CanonicalCaptureWrite,
  CanonicalDispatchStateInput,
  CanonicalDocumentLookupRow,
  CanonicalGraphEdgeObservationRow,
  CanonicalGraphIdentityMappingRecord,
  CanonicalHindsightProjectionLookupRow,
  CanonicalListRow,
  CanonicalMemoryOperationRecord,
  CanonicalOperationLookupRow,
  CanonicalProjectionJobContextRow,
  CanonicalProjectionJobRecord,
  CanonicalProjectionJobSummary,
  CanonicalProjectionKind,
  CanonicalProjectionResultRecord,
  CanonicalProjectionStateRow,
  CanonicalProjectionStateWriteInput,
  CanonicalSemanticLinkbackRow,
  CanonicalStatsRow,
} from './canonical-postgres-schema'

type NeonSql = ReturnType<typeof neon>
type NeonQueryCapable = NeonSql & { query: (query: string) => Promise<unknown> }

export interface CanonicalMemoryStore {
  writeCapture(input: CanonicalCaptureWrite): Promise<void>
  getCapture(tenantId: string, captureId: string): Promise<CanonicalCaptureRecord | null>
  getCaptureBodyKey(tenantId: string, captureId: string): Promise<string | null>
  listRecentDocuments(tenantId: string, scope: string | null, limit: number): Promise<CanonicalListRow[]>
  getDocument(tenantId: string, documentId: string): Promise<CanonicalDocumentLookupRow | null>
  getOperationById(tenantId: string, operationId: string): Promise<CanonicalOperationLookupRow | null>
  getLatestOperationForCapture(tenantId: string, captureId: string): Promise<CanonicalOperationLookupRow | null>
  listProjectionStatesForOperation(tenantId: string, operationId: string): Promise<CanonicalProjectionStateRow[]>
  listProjectionJobsForOperation(tenantId: string, operationId: string): Promise<CanonicalProjectionJobSummary[]>
  recordDispatchState(input: CanonicalDispatchStateInput): Promise<void>
  getProjectionJobContext(
    tenantId: string,
    projectionJobId: string,
    projectionKind: CanonicalProjectionKind,
  ): Promise<CanonicalProjectionJobContextRow | null>
  getLatestProjectionResult(tenantId: string, projectionJobId: string): Promise<CanonicalProjectionResultRecord | null>
  getLatestProjectionResultForOperation(
    tenantId: string,
    operationId: string,
    projectionKind: CanonicalProjectionKind,
  ): Promise<CanonicalProjectionStateRow | null>
  recordProjectionState(input: CanonicalProjectionStateWriteInput): Promise<void>
  findHindsightProjectionByEngineOperation(
    tenantId: string,
    engineOperationId: string,
  ): Promise<{ projection_job_id: string; operation_id: string } | null>
  listCompletedProjectionOperationIds(
    tenantId: string,
    projectionKind: CanonicalProjectionKind,
  ): Promise<string[]>
  findSemanticLinkback(
    tenantId: string,
    lookup: { captureId?: string | null; documentId?: string | null; operationId?: string | null; targetRef?: string | null },
  ): Promise<CanonicalSemanticLinkbackRow | null>
  listGraphEdgeObservations(tenantId: string): Promise<CanonicalGraphEdgeObservationRow[]>
  getStats(tenantId: string): Promise<CanonicalStatsRow>
  getLatestHindsightProjection(
    tenantId: string,
    args: { captureId?: string | null; operationId?: string | null },
  ): Promise<CanonicalHindsightProjectionLookupRow | null>
  listGraphIdentityMappings(tenantId: string): Promise<CanonicalGraphIdentityMappingRecord[]>
}

function compareProjectionResults(
  left: Pick<CanonicalProjectionResultRecord, 'updated_at' | 'created_at' | 'id'>,
  right: Pick<CanonicalProjectionResultRecord, 'updated_at' | 'created_at' | 'id'>,
): number {
  return right.updated_at - left.updated_at
    || right.created_at - left.created_at
    || right.id.localeCompare(left.id)
}

function latestProjectionResult(
  results: Iterable<CanonicalProjectionResultRecord>,
  projectionJobId: string,
): CanonicalProjectionResultRecord | null {
  return [...results]
    .filter((row) => row.projection_job_id === projectionJobId)
    .sort(compareProjectionResults)[0] ?? null
}

function computeAggregateOperationStatus(
  jobs: Iterable<CanonicalProjectionJobRecord>,
  operationId: string,
  currentJobId: string,
  nextJobStatus: CanonicalProjectionJobRecord['status'],
): CanonicalMemoryOperationRecord['status'] {
  const statuses = [...jobs]
    .filter((row) => row.operation_id === operationId)
    .map((row) => (row.id === currentJobId ? nextJobStatus : row.status))
  if (statuses.includes('failed')) return 'failed'
  if (statuses.length > 0 && statuses.every((status) => status === 'completed')) return 'completed'
  if (statuses.some((status) => status === 'queued' || status === 'completed')) return 'queued'
  return 'accepted'
}

function toProjectionStateRow(
  job: CanonicalProjectionJobRecord,
  result: CanonicalProjectionResultRecord | null,
): CanonicalProjectionStateRow {
  return {
    projection_result_id: result?.id ?? null,
    job_id: job.id,
    document_id: job.document_id,
    projection_kind: job.projection_kind,
    status: job.status,
    result_status: result?.status ?? null,
    target_ref: result?.target_ref ?? null,
    error_message: result?.error_message ?? null,
    engine_document_id: result?.engine_document_id ?? null,
    engine_operation_id: result?.engine_operation_id ?? null,
    engine_bank_id: result?.engine_bank_id ?? null,
    result_updated_at: result?.updated_at ?? null,
  }
}

function dedupeGraphMappings(
  mappings: CanonicalGraphIdentityMapping[] | undefined,
): CanonicalGraphIdentityMapping[] {
  const seen = new Set<string>()
  return (mappings ?? []).filter((mapping) => {
    const key = `${mapping.graphKind}:${mapping.canonicalKey}:${mapping.graphRef}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const NUMERIC_DB_FIELDS = new Set([
  'captured_at',
  'created_at',
  'updated_at',
  'enqueued_at',
  'result_updated_at',
  'document_created_at',
  'byte_length',
  'chunk_count',
  'ordinal',
  'start_offset',
  'end_offset',
  'count',
  'capture_count',
  'document_count',
  'operation_count',
  'pending_projection_count',
  'completed_projection_count',
  'failed_projection_count',
  'last_capture_at',
])

function normalizeDbRow<T>(row: T): T {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => {
      if (typeof value === 'string' && NUMERIC_DB_FIELDS.has(key) && /^-?\d+$/.test(value)) {
        return [key, Number(value)]
      }
      return [key, value]
    }),
  ) as T
}

export class InMemoryCanonicalMemoryStore implements CanonicalMemoryStore {
  private readonly captures = new Map<string, CanonicalCaptureRecord>()
  private readonly artifactRows = new Map<string, CanonicalArtifactRecord>()
  private readonly documents = new Map<string, CanonicalCaptureWrite['document']>()
  private readonly chunks = new Map<string, CanonicalCaptureWrite['chunks'][number]>()
  private readonly operations = new Map<string, CanonicalCaptureWrite['operation']>()
  private readonly projectionJobs = new Map<string, CanonicalCaptureWrite['projectionJobs'][number]>()
  private readonly projectionResults = new Map<string, CanonicalProjectionResultRecord>()
  private readonly graphIdentityMappings = new Map<string, CanonicalGraphIdentityMappingRecord>()

  async writeCapture(input: CanonicalCaptureWrite): Promise<void> {
    this.captures.set(input.capture.id, { ...input.capture })
    if (input.artifact) this.artifactRows.set(input.artifact.id, { ...input.artifact })
    this.documents.set(input.document.id, { ...input.document })
    input.chunks.forEach((chunk) => { this.chunks.set(chunk.id, { ...chunk }) })
    this.operations.set(input.operation.id, { ...input.operation })
    input.projectionJobs.forEach((job) => { this.projectionJobs.set(job.id, { ...job }) })
  }

  async getCapture(tenantId: string, captureId: string): Promise<CanonicalCaptureRecord | null> {
    const row = this.captures.get(captureId)
    return row?.tenant_id === tenantId ? { ...row } : null
  }

  async getCaptureBodyKey(tenantId: string, captureId: string): Promise<string | null> {
    return (await this.getCapture(tenantId, captureId))?.body_r2_key ?? null
  }

  async listRecentDocuments(tenantId: string, scope: string | null, limit: number): Promise<CanonicalListRow[]> {
    return [...this.documents.values()]
      .filter((document) => document.tenant_id === tenantId)
      .map((document) => {
        const capture = this.captures.get(document.capture_id)
        return capture && (!scope || capture.scope === scope)
          ? {
            capture_id: capture.id,
            document_id: document.id,
            title: document.title,
            scope: capture.scope,
            source_system: capture.source_system,
            source_ref: capture.source_ref,
            captured_at: capture.captured_at,
            body_r2_key: document.body_r2_key,
          }
          : null
      })
      .filter((row): row is CanonicalListRow => Boolean(row))
      .sort((left, right) => right.captured_at - left.captured_at || left.document_id.localeCompare(right.document_id))
      .slice(0, limit)
  }

  async getDocument(tenantId: string, documentId: string): Promise<CanonicalDocumentLookupRow | null> {
    const document = this.documents.get(documentId)
    if (!document || document.tenant_id !== tenantId) return null
    const capture = this.captures.get(document.capture_id)
    if (!capture) return null
    const artifact = document.artifact_id ? this.artifactRows.get(document.artifact_id) : null
    return {
      capture_id: capture.id,
      document_id: document.id,
      title: document.title,
      scope: capture.scope,
      source_system: capture.source_system,
      source_ref: capture.source_ref,
      captured_at: capture.captured_at,
      body_r2_key: document.body_r2_key,
      chunk_count: document.chunk_count,
      document_created_at: document.created_at,
      artifact_id: artifact?.id ?? null,
      filename: artifact?.filename ?? null,
      media_type: artifact?.media_type ?? null,
      byte_length: artifact?.byte_length ?? null,
      storage_kind: artifact?.storage_kind ?? null,
      r2_key: artifact?.r2_key ?? null,
    }
  }

  async getOperationById(tenantId: string, operationId: string): Promise<CanonicalOperationLookupRow | null> {
    const operation = this.operations.get(operationId)
    if (!operation || operation.tenant_id !== tenantId) return null
    const capture = this.captures.get(operation.capture_id)
    if (!capture) return null
    return {
      id: operation.id,
      capture_id: operation.capture_id,
      operation_type: operation.operation_type,
      status: operation.status,
      created_at: operation.created_at,
      updated_at: operation.updated_at,
      source_system: capture.source_system,
      source_ref: capture.source_ref,
      scope: capture.scope,
      title: capture.title,
      captured_at: capture.captured_at,
    }
  }

  async getLatestOperationForCapture(tenantId: string, captureId: string): Promise<CanonicalOperationLookupRow | null> {
    const row = [...this.operations.values()]
      .filter((operation) => operation.tenant_id === tenantId && operation.capture_id === captureId)
      .sort((left, right) => right.created_at - left.created_at || left.id.localeCompare(right.id))[0]
    return row ? this.getOperationById(tenantId, row.id) : null
  }

  async listProjectionStatesForOperation(tenantId: string, operationId: string): Promise<CanonicalProjectionStateRow[]> {
    return [...this.projectionJobs.values()]
      .filter((job) => job.tenant_id === tenantId && job.operation_id === operationId)
      .sort((left, right) => left.projection_kind.localeCompare(right.projection_kind))
      .map((job) => toProjectionStateRow(job, latestProjectionResult(this.projectionResults.values(), job.id)))
  }

  async listProjectionJobsForOperation(tenantId: string, operationId: string): Promise<CanonicalProjectionJobSummary[]> {
    return [...this.projectionJobs.values()]
      .filter((job) => job.tenant_id === tenantId && job.operation_id === operationId)
      .sort((left, right) => left.projection_kind.localeCompare(right.projection_kind))
      .map((job) => ({ id: job.id, projection_kind: job.projection_kind }))
  }

  async recordDispatchState(input: CanonicalDispatchStateInput): Promise<void> {
    const jobs = [...this.projectionJobs.values()].filter((job) => job.tenant_id === input.tenantId && job.operation_id === input.operationId)
    const operation = this.operations.get(input.operationId)
    if (operation && operation.tenant_id === input.tenantId) {
      this.operations.set(operation.id, {
        ...operation,
        status: input.status,
        updated_at: input.updatedAt,
      })
    }
    jobs.forEach((job) => {
      this.projectionJobs.set(job.id, {
        ...job,
        status: input.status,
        enqueued_at: input.updatedAt,
      })
      const id = crypto.randomUUID()
      this.projectionResults.set(id, {
        id,
        tenant_id: input.tenantId,
        projection_job_id: job.id,
        status: input.status,
        target_ref: null,
        error_message: input.status === 'failed' ? input.errorMessage ?? null : null,
        engine_bank_id: null,
        engine_document_id: null,
        engine_operation_id: null,
        created_at: input.updatedAt,
        updated_at: input.updatedAt,
      })
    })
  }

  async getProjectionJobContext(
    tenantId: string,
    projectionJobId: string,
    projectionKind: CanonicalProjectionKind,
  ): Promise<CanonicalProjectionJobContextRow | null> {
    const job = this.projectionJobs.get(projectionJobId)
    if (!job || job.tenant_id !== tenantId || job.projection_kind !== projectionKind) return null
    const capture = this.captures.get(job.capture_id)
    const document = this.documents.get(job.document_id)
    const artifact = capture?.artifact_id ? this.artifactRows.get(capture.artifact_id) : null
    if (!capture || !document) return null
    return {
      id: job.id,
      operation_id: job.operation_id,
      capture_id: job.capture_id,
      document_id: job.document_id,
      projection_kind: job.projection_kind,
      source_system: capture.source_system,
      source_ref: capture.source_ref,
      scope: capture.scope,
      title: capture.title,
      captured_at: capture.captured_at,
      body_r2_key: capture.body_r2_key,
      artifact_filename: artifact?.filename ?? null,
      artifact_media_type: artifact?.media_type ?? null,
      artifact_storage_key: artifact?.r2_key ?? null,
    }
  }

  async getLatestProjectionResult(tenantId: string, projectionJobId: string): Promise<CanonicalProjectionResultRecord | null> {
    const row = latestProjectionResult(this.projectionResults.values(), projectionJobId)
    return row?.tenant_id === tenantId ? { ...row } : null
  }

  async getLatestProjectionResultForOperation(
    tenantId: string,
    operationId: string,
    projectionKind: CanonicalProjectionKind,
  ): Promise<CanonicalProjectionStateRow | null> {
    return (await this.listProjectionStatesForOperation(tenantId, operationId))
      .find((row) => row.projection_kind === projectionKind) ?? null
  }

  async recordProjectionState(input: CanonicalProjectionStateWriteInput): Promise<void> {
    const job = this.projectionJobs.get(input.jobId)
    if (!job || job.tenant_id !== input.tenantId) return
    const operation = this.operations.get(input.operationId)
    const aggregateStatus = computeAggregateOperationStatus(
      this.projectionJobs.values(),
      input.operationId,
      input.jobId,
      input.jobStatus,
    )
    if (operation && operation.tenant_id === input.tenantId) {
      this.operations.set(operation.id, {
        ...operation,
        status: aggregateStatus,
        updated_at: input.updatedAt,
      })
    }
    this.projectionJobs.set(job.id, { ...job, status: input.jobStatus })
    const resultId = crypto.randomUUID()
    this.projectionResults.set(resultId, {
      id: resultId,
      tenant_id: input.tenantId,
      projection_job_id: input.jobId,
      status: input.resultStatus,
      target_ref: input.targetRef,
      error_message: input.errorMessage ?? null,
      engine_bank_id: input.engineBankId ?? null,
      engine_document_id: input.engineDocumentId ?? null,
      engine_operation_id: input.engineOperationId ?? null,
      created_at: input.updatedAt,
      updated_at: input.updatedAt,
    })
    dedupeGraphMappings(input.graphMappings).forEach((mapping) => {
      const existing = [...this.graphIdentityMappings.values()].find((row) =>
        row.projection_job_id === input.jobId
        && row.canonical_key === mapping.canonicalKey
        && row.graph_kind === mapping.graphKind,
      )
      const id = existing?.id ?? crypto.randomUUID()
      this.graphIdentityMappings.set(id, {
        id,
        tenant_id: input.tenantId,
        projection_job_id: input.jobId,
        canonical_key: mapping.canonicalKey,
        graph_ref: mapping.graphRef,
        graph_kind: mapping.graphKind,
        created_at: existing?.created_at ?? input.updatedAt,
        updated_at: input.updatedAt,
      })
    })
  }

  async findHindsightProjectionByEngineOperation(
    tenantId: string,
    engineOperationId: string,
  ): Promise<{ projection_job_id: string; operation_id: string } | null> {
    const result = [...this.projectionResults.values()]
      .filter((row) => row.tenant_id === tenantId && row.engine_operation_id === engineOperationId)
      .sort(compareProjectionResults)[0]
    if (!result) return null
    const job = this.projectionJobs.get(result.projection_job_id)
    return job ? { projection_job_id: job.id, operation_id: job.operation_id } : null
  }

  async listCompletedProjectionOperationIds(
    tenantId: string,
    projectionKind: CanonicalProjectionKind,
  ): Promise<string[]> {
    const ids = [...this.projectionJobs.values()]
      .filter((job) => job.tenant_id === tenantId && job.projection_kind === projectionKind)
      .filter((job) => latestProjectionResult(this.projectionResults.values(), job.id)?.status === 'completed')
      .map((job) => job.operation_id)
    return [...new Set(ids)].sort()
  }

  async findSemanticLinkback(
    tenantId: string,
    lookup: { captureId?: string | null; documentId?: string | null; operationId?: string | null; targetRef?: string | null },
  ): Promise<CanonicalSemanticLinkbackRow | null> {
    const candidates = [...this.projectionJobs.values()]
      .filter((job) => job.tenant_id === tenantId && job.projection_kind === 'hindsight')
      .map((job) => {
        const result = latestProjectionResult(this.projectionResults.values(), job.id)
        const capture = this.captures.get(job.capture_id)
        const document = this.documents.get(job.document_id)
        const operation = this.operations.get(job.operation_id)
        return capture && document && operation && result
          ? {
            capture_id: capture.id,
            document_id: document.id,
            operation_id: operation.id,
            projection_job_id: job.id,
            projection_result_id: result.id,
            scope: capture.scope,
            source_system: capture.source_system,
            source_ref: capture.source_ref,
            title: document.title,
            captured_at: capture.captured_at,
            projection_status: job.status,
            result_status: result.status,
            target_ref: result.target_ref,
            engine_document_id: result.engine_document_id,
            engine_operation_id: result.engine_operation_id,
            updated_at: result.updated_at,
            created_at: result.created_at,
          }
          : null
      })
      .filter((row): row is CanonicalSemanticLinkbackRow & { updated_at: number; created_at: number } => Boolean(row))
      .filter((row) =>
        (lookup.captureId && row.capture_id === lookup.captureId)
        || (lookup.documentId && row.engine_document_id === lookup.documentId)
        || (lookup.operationId && row.engine_operation_id === lookup.operationId)
        || (lookup.targetRef && row.target_ref === lookup.targetRef),
      )
      .sort((left, right) => right.updated_at - left.updated_at || right.created_at - left.created_at || right.projection_result_id.localeCompare(left.projection_result_id))
    if (!candidates[0]) return null
    const { updated_at: _updatedAt, created_at: _createdAt, ...row } = candidates[0]
    return row
  }

  async listGraphEdgeObservations(tenantId: string): Promise<CanonicalGraphEdgeObservationRow[]> {
    const rows = [...this.graphIdentityMappings.values()]
      .filter((mapping) => mapping.tenant_id === tenantId && mapping.graph_kind === 'edge')
      .map((mapping) => {
        const job = this.projectionJobs.get(mapping.projection_job_id)
        if (!job || job.projection_kind !== 'graphiti' || job.status !== 'completed') return null
        const capture = this.captures.get(job.capture_id)
        const latest = latestProjectionResult(this.projectionResults.values(), job.id)
        return capture
          ? {
            canonical_key: mapping.canonical_key,
            graph_ref: mapping.graph_ref,
            projection_job_id: job.id,
            projection_result_id: latest?.id ?? null,
            target_ref: latest?.target_ref ?? null,
            operation_id: job.operation_id,
            capture_id: job.capture_id,
            document_id: job.document_id,
            scope: capture.scope,
            source_system: capture.source_system,
            source_ref: capture.source_ref,
            title: capture.title,
            captured_at: capture.captured_at,
          }
          : null
      })
      .filter(Boolean)
    return rows as CanonicalGraphEdgeObservationRow[]
  }

  async getStats(tenantId: string): Promise<CanonicalStatsRow> {
    const captures = [...this.captures.values()].filter((row) => row.tenant_id === tenantId)
    const documents = [...this.documents.values()].filter((row) => row.tenant_id === tenantId)
    const chunks = [...this.chunks.values()].filter((row) => row.tenant_id === tenantId)
    const operations = [...this.operations.values()].filter((row) => row.tenant_id === tenantId)
    const jobs = [...this.projectionJobs.values()].filter((row) => row.tenant_id === tenantId)
    const scopeCounts = new Map<string, number>()
    captures.forEach((row) => scopeCounts.set(row.scope, (scopeCounts.get(row.scope) ?? 0) + 1))
    return {
      captureCount: captures.length,
      documentCount: documents.length,
      chunkCount: chunks.length,
      operationCount: operations.length,
      pendingProjectionCount: jobs.filter((row) => row.status === 'accepted' || row.status === 'queued').length,
      completedProjectionCount: jobs.filter((row) => row.status === 'completed').length,
      failedProjectionCount: jobs.filter((row) => row.status === 'failed').length,
      lastCaptureAt: captures.reduce<number | null>((latest, row) => latest == null ? row.captured_at : Math.max(latest, row.captured_at), null),
      scopes: [...scopeCounts.entries()]
        .map(([scope, count]) => ({ scope, count }))
        .sort((left, right) => right.count - left.count || left.scope.localeCompare(right.scope)),
    }
  }

  async getLatestHindsightProjection(
    tenantId: string,
    args: { captureId?: string | null; operationId?: string | null },
  ): Promise<CanonicalHindsightProjectionLookupRow | null> {
    const rows = [...this.projectionJobs.values()]
      .filter((job) => job.tenant_id === tenantId && job.projection_kind === 'hindsight')
      .map((job) => {
        const capture = this.captures.get(job.capture_id)
        const operation = this.operations.get(job.operation_id)
        const result = latestProjectionResult(this.projectionResults.values(), job.id)
        return capture && operation && result
          ? {
            capture_id: capture.id,
            document_id: job.document_id,
            operation_id: operation.id,
            projection_job_id: job.id,
            projection_result_id: result.id,
            projection_status: job.status,
            result_status: result.status,
            engine_document_id: result.engine_document_id,
            engine_operation_id: result.engine_operation_id,
            target_ref: result.target_ref,
            updated_at: result.updated_at,
            created_at: result.created_at,
          }
          : null
      })
      .filter((row): row is CanonicalHindsightProjectionLookupRow & { updated_at: number; created_at: number } => Boolean(row))
      .filter((row) =>
        (args.captureId && row.capture_id === args.captureId)
        || (args.operationId && row.operation_id === args.operationId),
      )
      .sort((left, right) => right.updated_at - left.updated_at || right.created_at - left.created_at || right.projection_result_id.localeCompare(left.projection_result_id))
    if (!rows[0]) return null
    const { updated_at: _updatedAt, created_at: _createdAt, ...row } = rows[0]
    return row
  }

  async listGraphIdentityMappings(tenantId: string): Promise<CanonicalGraphIdentityMappingRecord[]> {
    return [...this.graphIdentityMappings.values()]
      .filter((row) => row.tenant_id === tenantId)
      .sort((left, right) => left.graph_kind.localeCompare(right.graph_kind) || left.canonical_key.localeCompare(right.canonical_key))
      .map((row) => ({ ...row }))
  }
}

export class NeonCanonicalMemoryStore implements CanonicalMemoryStore {
  private schemaReadyPromise: Promise<void> | null = null

  constructor(private readonly sql: NeonSql) {}

  private async ensureSchema(): Promise<void> {
    if (!this.schemaReadyPromise) {
      this.schemaReadyPromise = this.ensureSchemaOnce()
        .catch((error) => {
          this.schemaReadyPromise = null
          throw error
        })
    }
    await this.schemaReadyPromise
  }

  private async ensureSchemaOnce(): Promise<void> {
    await (this.sql as NeonQueryCapable).query(`CREATE SCHEMA IF NOT EXISTS ${CANONICAL_POSTGRES_SCHEMA}`)
    const statements = [
      `CREATE TABLE IF NOT EXISTS ${CANONICAL_POSTGRES_SCHEMA}.canonical_captures (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        source_system TEXT NOT NULL,
        source_ref TEXT,
        scope TEXT NOT NULL,
        title TEXT,
        body_r2_key TEXT NOT NULL,
        body_sha256 TEXT NOT NULL,
        artifact_id TEXT,
        captured_at BIGINT NOT NULL,
        created_at BIGINT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_pg_canonical_captures_tenant_source
        ON ${CANONICAL_POSTGRES_SCHEMA}.canonical_captures(tenant_id, source_system, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_pg_canonical_captures_tenant_scope
        ON ${CANONICAL_POSTGRES_SCHEMA}.canonical_captures(tenant_id, scope, created_at DESC)`,
      `CREATE TABLE IF NOT EXISTS ${CANONICAL_POSTGRES_SCHEMA}.canonical_artifacts (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        capture_id TEXT NOT NULL REFERENCES ${CANONICAL_POSTGRES_SCHEMA}.canonical_captures(id) ON DELETE CASCADE,
        storage_kind TEXT NOT NULL,
        r2_key TEXT,
        media_type TEXT,
        filename TEXT,
        byte_length BIGINT,
        sha256 TEXT,
        created_at BIGINT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_pg_canonical_artifacts_tenant_created
        ON ${CANONICAL_POSTGRES_SCHEMA}.canonical_artifacts(tenant_id, created_at DESC)`,
      `CREATE TABLE IF NOT EXISTS ${CANONICAL_POSTGRES_SCHEMA}.canonical_documents (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        capture_id TEXT NOT NULL REFERENCES ${CANONICAL_POSTGRES_SCHEMA}.canonical_captures(id) ON DELETE CASCADE,
        artifact_id TEXT REFERENCES ${CANONICAL_POSTGRES_SCHEMA}.canonical_artifacts(id) ON DELETE SET NULL,
        title TEXT,
        body_r2_key TEXT NOT NULL,
        body_sha256 TEXT NOT NULL,
        chunk_count INTEGER NOT NULL,
        created_at BIGINT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_pg_canonical_documents_tenant_capture
        ON ${CANONICAL_POSTGRES_SCHEMA}.canonical_documents(tenant_id, capture_id, created_at DESC)`,
      `CREATE TABLE IF NOT EXISTS ${CANONICAL_POSTGRES_SCHEMA}.canonical_chunks (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        document_id TEXT NOT NULL REFERENCES ${CANONICAL_POSTGRES_SCHEMA}.canonical_documents(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        start_offset INTEGER NOT NULL,
        end_offset INTEGER NOT NULL,
        chunk_sha256 TEXT NOT NULL,
        created_at BIGINT NOT NULL
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_pg_canonical_chunks_document_ordinal
        ON ${CANONICAL_POSTGRES_SCHEMA}.canonical_chunks(document_id, ordinal)`,
      `CREATE INDEX IF NOT EXISTS idx_pg_canonical_chunks_tenant_document
        ON ${CANONICAL_POSTGRES_SCHEMA}.canonical_chunks(tenant_id, document_id)`,
      `CREATE TABLE IF NOT EXISTS ${CANONICAL_POSTGRES_SCHEMA}.canonical_memory_operations (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        capture_id TEXT NOT NULL REFERENCES ${CANONICAL_POSTGRES_SCHEMA}.canonical_captures(id) ON DELETE CASCADE,
        operation_type TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_pg_canonical_memory_operations_tenant_status
        ON ${CANONICAL_POSTGRES_SCHEMA}.canonical_memory_operations(tenant_id, status, created_at DESC)`,
      `CREATE TABLE IF NOT EXISTS ${CANONICAL_POSTGRES_SCHEMA}.canonical_projection_jobs (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        operation_id TEXT NOT NULL REFERENCES ${CANONICAL_POSTGRES_SCHEMA}.canonical_memory_operations(id) ON DELETE CASCADE,
        capture_id TEXT NOT NULL REFERENCES ${CANONICAL_POSTGRES_SCHEMA}.canonical_captures(id) ON DELETE CASCADE,
        document_id TEXT NOT NULL REFERENCES ${CANONICAL_POSTGRES_SCHEMA}.canonical_documents(id) ON DELETE CASCADE,
        projection_kind TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        enqueued_at BIGINT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_pg_canonical_projection_jobs_tenant_status
        ON ${CANONICAL_POSTGRES_SCHEMA}.canonical_projection_jobs(tenant_id, projection_kind, status, created_at DESC)`,
      `CREATE TABLE IF NOT EXISTS ${CANONICAL_POSTGRES_SCHEMA}.canonical_projection_results (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        projection_job_id TEXT NOT NULL REFERENCES ${CANONICAL_POSTGRES_SCHEMA}.canonical_projection_jobs(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        target_ref TEXT,
        error_message TEXT,
        engine_bank_id TEXT,
        engine_document_id TEXT,
        engine_operation_id TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_pg_canonical_projection_results_tenant_status
        ON ${CANONICAL_POSTGRES_SCHEMA}.canonical_projection_results(tenant_id, status, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_pg_canonical_projection_results_operation
        ON ${CANONICAL_POSTGRES_SCHEMA}.canonical_projection_results(engine_operation_id, updated_at DESC)`,
      `CREATE TABLE IF NOT EXISTS ${CANONICAL_POSTGRES_SCHEMA}.canonical_graph_identity_mappings (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        projection_job_id TEXT NOT NULL REFERENCES ${CANONICAL_POSTGRES_SCHEMA}.canonical_projection_jobs(id) ON DELETE CASCADE,
        canonical_key TEXT NOT NULL,
        graph_ref TEXT NOT NULL,
        graph_kind TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_pg_canonical_graph_identity_unique
        ON ${CANONICAL_POSTGRES_SCHEMA}.canonical_graph_identity_mappings(projection_job_id, canonical_key, graph_kind)`,
      `CREATE INDEX IF NOT EXISTS idx_pg_canonical_graph_identity_lookup
        ON ${CANONICAL_POSTGRES_SCHEMA}.canonical_graph_identity_mappings(tenant_id, canonical_key, graph_kind, updated_at DESC)`,
    ]
    for (const statement of statements) {
      await (this.sql as NeonQueryCapable).query(statement)
    }
  }

  private async rows<T>(query: Promise<unknown>): Promise<T[]> {
    await this.ensureSchema()
    return (await query as T[]).map((row) => normalizeDbRow(row))
  }

  private async first<T>(query: Promise<unknown>): Promise<T | null> {
    return (await this.rows<T>(query))[0] ?? null
  }

  async writeCapture(input: CanonicalCaptureWrite): Promise<void> {
    await this.ensureSchema()
    const queries = [
      this.sql`INSERT INTO haetsal_canonical.canonical_captures
        (id, tenant_id, source_system, source_ref, scope, title, body_r2_key, body_sha256, artifact_id, captured_at, created_at)
        VALUES (${input.capture.id}, ${input.capture.tenant_id}, ${input.capture.source_system}, ${input.capture.source_ref},
                ${input.capture.scope}, ${input.capture.title}, ${input.capture.body_r2_key}, ${input.capture.body_sha256},
                ${input.capture.artifact_id}, ${input.capture.captured_at}, ${input.capture.created_at})`,
      ...(input.artifact ? [this.sql`INSERT INTO haetsal_canonical.canonical_artifacts
        (id, tenant_id, capture_id, storage_kind, r2_key, media_type, filename, byte_length, sha256, created_at)
        VALUES (${input.artifact.id}, ${input.artifact.tenant_id}, ${input.artifact.capture_id}, ${input.artifact.storage_kind},
                ${input.artifact.r2_key}, ${input.artifact.media_type}, ${input.artifact.filename}, ${input.artifact.byte_length},
                ${input.artifact.sha256}, ${input.artifact.created_at})`] : []),
      this.sql`INSERT INTO haetsal_canonical.canonical_documents
        (id, tenant_id, capture_id, artifact_id, title, body_r2_key, body_sha256, chunk_count, created_at)
        VALUES (${input.document.id}, ${input.document.tenant_id}, ${input.document.capture_id}, ${input.document.artifact_id},
                ${input.document.title}, ${input.document.body_r2_key}, ${input.document.body_sha256},
                ${input.document.chunk_count}, ${input.document.created_at})`,
      ...input.chunks.map((chunk) => this.sql`INSERT INTO haetsal_canonical.canonical_chunks
        (id, tenant_id, document_id, ordinal, start_offset, end_offset, chunk_sha256, created_at)
        VALUES (${chunk.id}, ${chunk.tenant_id}, ${chunk.document_id}, ${chunk.ordinal}, ${chunk.start_offset},
                ${chunk.end_offset}, ${chunk.chunk_sha256}, ${chunk.created_at})`),
      this.sql`INSERT INTO haetsal_canonical.canonical_memory_operations
        (id, tenant_id, capture_id, operation_type, status, created_at, updated_at)
        VALUES (${input.operation.id}, ${input.operation.tenant_id}, ${input.operation.capture_id},
                ${input.operation.operation_type}, ${input.operation.status}, ${input.operation.created_at}, ${input.operation.updated_at})`,
      ...input.projectionJobs.map((job) => this.sql`INSERT INTO haetsal_canonical.canonical_projection_jobs
        (id, tenant_id, operation_id, capture_id, document_id, projection_kind, status, created_at, enqueued_at)
        VALUES (${job.id}, ${job.tenant_id}, ${job.operation_id}, ${job.capture_id}, ${job.document_id},
                ${job.projection_kind}, ${job.status}, ${job.created_at}, ${job.enqueued_at})`),
    ]
    await (this.sql as unknown as { transaction: (queries: unknown[]) => Promise<unknown> }).transaction(queries)
  }

  async getCapture(tenantId: string, captureId: string): Promise<CanonicalCaptureRecord | null> {
    return this.first<CanonicalCaptureRecord>(this.sql`
      SELECT id, tenant_id, source_system, source_ref, scope, title, body_r2_key, body_sha256, artifact_id, captured_at, created_at
      FROM haetsal_canonical.canonical_captures
      WHERE tenant_id = ${tenantId} AND id = ${captureId}
      LIMIT 1
    `)
  }

  async getCaptureBodyKey(tenantId: string, captureId: string): Promise<string | null> {
    return (await this.getCapture(tenantId, captureId))?.body_r2_key ?? null
  }

  async listRecentDocuments(tenantId: string, scope: string | null, limit: number): Promise<CanonicalListRow[]> {
    return this.rows<CanonicalListRow>(this.sql`
      SELECT c.id AS capture_id, d.id AS document_id, d.title, c.scope, c.source_system, c.source_ref, c.captured_at, d.body_r2_key
      FROM haetsal_canonical.canonical_documents d
      INNER JOIN haetsal_canonical.canonical_captures c ON c.id = d.capture_id
      WHERE d.tenant_id = ${tenantId} AND (${scope}::text IS NULL OR c.scope = ${scope})
      ORDER BY c.captured_at DESC
      LIMIT ${limit}
    `)
  }

  async getDocument(tenantId: string, documentId: string): Promise<CanonicalDocumentLookupRow | null> {
    return this.first<CanonicalDocumentLookupRow>(this.sql`
      SELECT c.id AS capture_id, d.id AS document_id, d.title, c.scope, c.source_system, c.source_ref, c.captured_at,
             d.body_r2_key, d.chunk_count, d.created_at AS document_created_at,
             a.id AS artifact_id, a.filename, a.media_type, a.byte_length, a.storage_kind, a.r2_key
      FROM haetsal_canonical.canonical_documents d
      INNER JOIN haetsal_canonical.canonical_captures c ON c.id = d.capture_id
      LEFT JOIN haetsal_canonical.canonical_artifacts a ON a.id = d.artifact_id
      WHERE d.tenant_id = ${tenantId} AND d.id = ${documentId}
      LIMIT 1
    `)
  }

  async getOperationById(tenantId: string, operationId: string): Promise<CanonicalOperationLookupRow | null> {
    return this.first<CanonicalOperationLookupRow>(this.sql`
      SELECT o.id, o.capture_id, o.operation_type, o.status, o.created_at, o.updated_at,
             c.source_system, c.source_ref, c.scope, c.title, c.captured_at
      FROM haetsal_canonical.canonical_memory_operations o
      INNER JOIN haetsal_canonical.canonical_captures c ON c.id = o.capture_id
      WHERE o.tenant_id = ${tenantId} AND o.id = ${operationId}
      LIMIT 1
    `)
  }

  async getLatestOperationForCapture(tenantId: string, captureId: string): Promise<CanonicalOperationLookupRow | null> {
    return this.first<CanonicalOperationLookupRow>(this.sql`
      SELECT o.id, o.capture_id, o.operation_type, o.status, o.created_at, o.updated_at,
             c.source_system, c.source_ref, c.scope, c.title, c.captured_at
      FROM haetsal_canonical.canonical_memory_operations o
      INNER JOIN haetsal_canonical.canonical_captures c ON c.id = o.capture_id
      WHERE o.tenant_id = ${tenantId} AND o.capture_id = ${captureId}
      ORDER BY o.created_at DESC
      LIMIT 1
    `)
  }

  async listProjectionStatesForOperation(tenantId: string, operationId: string): Promise<CanonicalProjectionStateRow[]> {
    return this.rows<CanonicalProjectionStateRow>(this.sql`
      SELECT j.id AS job_id, j.document_id, j.projection_kind, j.status,
             r.id AS projection_result_id, r.status AS result_status, r.target_ref, r.error_message,
             r.engine_document_id, r.engine_operation_id, r.engine_bank_id, r.updated_at AS result_updated_at
      FROM haetsal_canonical.canonical_projection_jobs j
      LEFT JOIN LATERAL (
        SELECT id, status, target_ref, error_message, engine_document_id, engine_operation_id, engine_bank_id, updated_at
        FROM haetsal_canonical.canonical_projection_results
        WHERE projection_job_id = j.id
        ORDER BY updated_at DESC, created_at DESC, id DESC
        LIMIT 1
      ) r ON true
      WHERE j.tenant_id = ${tenantId} AND j.operation_id = ${operationId}
      ORDER BY j.projection_kind ASC
    `)
  }

  async listProjectionJobsForOperation(tenantId: string, operationId: string): Promise<CanonicalProjectionJobSummary[]> {
    return this.rows<CanonicalProjectionJobSummary>(this.sql`
      SELECT id, projection_kind
      FROM haetsal_canonical.canonical_projection_jobs
      WHERE tenant_id = ${tenantId} AND operation_id = ${operationId}
      ORDER BY projection_kind ASC
    `)
  }

  async recordDispatchState(input: CanonicalDispatchStateInput): Promise<void> {
    await this.ensureSchema()
    const jobs = await this.listProjectionJobsForOperation(input.tenantId, input.operationId)
    const queries = [
      this.sql`UPDATE haetsal_canonical.canonical_memory_operations
        SET status = ${input.status}, updated_at = ${input.updatedAt}
        WHERE tenant_id = ${input.tenantId} AND id = ${input.operationId}`,
      ...jobs.map((job) => this.sql`UPDATE haetsal_canonical.canonical_projection_jobs
        SET status = ${input.status}, enqueued_at = ${input.updatedAt}
        WHERE tenant_id = ${input.tenantId} AND id = ${job.id}`),
      ...jobs.map((job) => this.sql`INSERT INTO haetsal_canonical.canonical_projection_results
        (id, tenant_id, projection_job_id, status, target_ref, error_message, engine_bank_id, engine_document_id, engine_operation_id, created_at, updated_at)
        VALUES (${crypto.randomUUID()}, ${input.tenantId}, ${job.id}, ${input.status}, NULL,
                ${input.status === 'failed' ? input.errorMessage ?? null : null}, NULL, NULL, NULL, ${input.updatedAt}, ${input.updatedAt})`),
    ]
    await (this.sql as unknown as { transaction: (queries: unknown[]) => Promise<unknown> }).transaction(queries)
  }

  async getProjectionJobContext(
    tenantId: string,
    projectionJobId: string,
    projectionKind: CanonicalProjectionKind,
  ): Promise<CanonicalProjectionJobContextRow | null> {
    return this.first<CanonicalProjectionJobContextRow>(this.sql`
      SELECT j.id, j.operation_id, j.capture_id, j.document_id, j.projection_kind,
             c.source_system, c.source_ref, c.scope, c.title, c.captured_at, c.body_r2_key,
             a.filename AS artifact_filename, a.media_type AS artifact_media_type, a.r2_key AS artifact_storage_key
      FROM haetsal_canonical.canonical_projection_jobs j
      INNER JOIN haetsal_canonical.canonical_captures c ON c.id = j.capture_id
      LEFT JOIN haetsal_canonical.canonical_artifacts a ON a.id = c.artifact_id
      WHERE j.tenant_id = ${tenantId} AND j.id = ${projectionJobId} AND j.projection_kind = ${projectionKind}
      LIMIT 1
    `)
  }

  async getLatestProjectionResult(tenantId: string, projectionJobId: string): Promise<CanonicalProjectionResultRecord | null> {
    return this.first<CanonicalProjectionResultRecord>(this.sql`
      SELECT id, tenant_id, projection_job_id, status, target_ref, error_message,
             engine_bank_id, engine_document_id, engine_operation_id, created_at, updated_at
      FROM haetsal_canonical.canonical_projection_results
      WHERE tenant_id = ${tenantId} AND projection_job_id = ${projectionJobId}
      ORDER BY updated_at DESC, created_at DESC, id DESC
      LIMIT 1
    `)
  }

  async getLatestProjectionResultForOperation(
    tenantId: string,
    operationId: string,
    projectionKind: CanonicalProjectionKind,
  ): Promise<CanonicalProjectionStateRow | null> {
    return (await this.listProjectionStatesForOperation(tenantId, operationId))
      .find((row) => row.projection_kind === projectionKind) ?? null
  }

  async recordProjectionState(input: CanonicalProjectionStateWriteInput): Promise<void> {
    await this.ensureSchema()
    const jobRows = await this.rows<CanonicalProjectionJobSummary>(this.sql`
      SELECT id, projection_kind
      FROM haetsal_canonical.canonical_projection_jobs
      WHERE tenant_id = ${input.tenantId} AND operation_id = ${input.operationId}
    `)
    const currentJobs = await this.rows<{ id: string; status: CanonicalProjectionJobRecord['status'] }>(this.sql`
      SELECT id, status
      FROM haetsal_canonical.canonical_projection_jobs
      WHERE tenant_id = ${input.tenantId} AND operation_id = ${input.operationId}
    `)
    const aggregateStatus = computeAggregateOperationStatus(
      currentJobs.map((row) => ({
        id: row.id,
        tenant_id: input.tenantId,
        operation_id: input.operationId,
        capture_id: '',
        document_id: '',
        projection_kind: (jobRows.find((job) => job.id === row.id)?.projection_kind ?? 'hindsight'),
        status: row.status,
        created_at: 0,
        enqueued_at: 0,
      })),
      input.operationId,
      input.jobId,
      input.jobStatus,
    )
    const queries = [
      this.sql`UPDATE haetsal_canonical.canonical_memory_operations
        SET status = ${aggregateStatus}, updated_at = ${input.updatedAt}
        WHERE tenant_id = ${input.tenantId} AND id = ${input.operationId}`,
      this.sql`UPDATE haetsal_canonical.canonical_projection_jobs
        SET status = ${input.jobStatus}
        WHERE tenant_id = ${input.tenantId} AND id = ${input.jobId}`,
      this.sql`INSERT INTO haetsal_canonical.canonical_projection_results
        (id, tenant_id, projection_job_id, status, target_ref, error_message, engine_bank_id, engine_document_id, engine_operation_id, created_at, updated_at)
        VALUES (${crypto.randomUUID()}, ${input.tenantId}, ${input.jobId}, ${input.resultStatus}, ${input.targetRef},
                ${input.errorMessage ?? null}, ${input.engineBankId ?? null}, ${input.engineDocumentId ?? null},
                ${input.engineOperationId ?? null}, ${input.updatedAt}, ${input.updatedAt})`,
      ...dedupeGraphMappings(input.graphMappings).map((mapping) => this.sql`INSERT INTO haetsal_canonical.canonical_graph_identity_mappings
        (id, tenant_id, projection_job_id, canonical_key, graph_ref, graph_kind, created_at, updated_at)
        VALUES (${crypto.randomUUID()}, ${input.tenantId}, ${input.jobId}, ${mapping.canonicalKey}, ${mapping.graphRef},
                ${mapping.graphKind}, ${input.updatedAt}, ${input.updatedAt})
        ON CONFLICT (projection_job_id, canonical_key, graph_kind)
        DO UPDATE SET graph_ref = EXCLUDED.graph_ref, updated_at = EXCLUDED.updated_at`),
    ]
    await (this.sql as unknown as { transaction: (queries: unknown[]) => Promise<unknown> }).transaction(queries)
  }

  async findHindsightProjectionByEngineOperation(
    tenantId: string,
    engineOperationId: string,
  ): Promise<{ projection_job_id: string; operation_id: string } | null> {
    return this.first<{ projection_job_id: string; operation_id: string }>(this.sql`
      SELECT r.projection_job_id, j.operation_id
      FROM haetsal_canonical.canonical_projection_results r
      INNER JOIN haetsal_canonical.canonical_projection_jobs j ON j.id = r.projection_job_id
      WHERE r.tenant_id = ${tenantId} AND r.engine_operation_id = ${engineOperationId}
      ORDER BY r.updated_at DESC, r.created_at DESC, r.id DESC
      LIMIT 1
    `)
  }

  async listCompletedProjectionOperationIds(
    tenantId: string,
    projectionKind: CanonicalProjectionKind,
  ): Promise<string[]> {
    const rows = await this.rows<{ operation_id: string }>(this.sql`
      SELECT DISTINCT j.operation_id
      FROM haetsal_canonical.canonical_projection_jobs j
      INNER JOIN LATERAL (
        SELECT status
        FROM haetsal_canonical.canonical_projection_results
        WHERE projection_job_id = j.id
        ORDER BY updated_at DESC, created_at DESC, id DESC
        LIMIT 1
      ) r ON true
      WHERE j.tenant_id = ${tenantId} AND j.projection_kind = ${projectionKind} AND r.status = 'completed'
      ORDER BY j.operation_id ASC
    `)
    return rows.map((row) => row.operation_id)
  }

  async findSemanticLinkback(
    tenantId: string,
    lookup: { captureId?: string | null; documentId?: string | null; operationId?: string | null; targetRef?: string | null },
  ): Promise<CanonicalSemanticLinkbackRow | null> {
    return this.first<CanonicalSemanticLinkbackRow>(this.sql`
      SELECT c.id AS capture_id, d.id AS document_id, o.id AS operation_id,
             j.id AS projection_job_id, r.id AS projection_result_id,
             c.scope, c.source_system, c.source_ref, d.title, c.captured_at,
             j.status AS projection_status, r.status AS result_status,
             r.target_ref, r.engine_document_id, r.engine_operation_id
      FROM haetsal_canonical.canonical_projection_jobs j
      INNER JOIN haetsal_canonical.canonical_captures c ON c.id = j.capture_id
      INNER JOIN haetsal_canonical.canonical_documents d ON d.id = j.document_id
      INNER JOIN haetsal_canonical.canonical_memory_operations o ON o.id = j.operation_id
      INNER JOIN LATERAL (
        SELECT id, status, target_ref, engine_document_id, engine_operation_id, updated_at, created_at
        FROM haetsal_canonical.canonical_projection_results
        WHERE projection_job_id = j.id
        ORDER BY updated_at DESC, created_at DESC, id DESC
        LIMIT 1
      ) r ON true
      WHERE j.tenant_id = ${tenantId}
        AND j.projection_kind = 'hindsight'
        AND (
          (${lookup.captureId ?? null}::text IS NOT NULL AND c.id = ${lookup.captureId ?? null})
          OR (${lookup.documentId ?? null}::text IS NOT NULL AND r.engine_document_id = ${lookup.documentId ?? null})
          OR (${lookup.operationId ?? null}::text IS NOT NULL AND r.engine_operation_id = ${lookup.operationId ?? null})
          OR (${lookup.targetRef ?? null}::text IS NOT NULL AND r.target_ref = ${lookup.targetRef ?? null})
      )
      ORDER BY r.updated_at DESC, r.created_at DESC, r.id DESC
      LIMIT 1
    `)
  }

  async listGraphEdgeObservations(tenantId: string): Promise<CanonicalGraphEdgeObservationRow[]> {
    return this.rows<CanonicalGraphEdgeObservationRow>(this.sql`
      SELECT m.canonical_key, m.graph_ref, j.id AS projection_job_id, r.id AS projection_result_id, r.target_ref,
             j.operation_id, c.id AS capture_id, j.document_id, c.scope, c.source_system, c.source_ref, c.title, c.captured_at
      FROM haetsal_canonical.canonical_graph_identity_mappings m
      INNER JOIN haetsal_canonical.canonical_projection_jobs j ON j.id = m.projection_job_id
      INNER JOIN haetsal_canonical.canonical_captures c ON c.id = j.capture_id
      LEFT JOIN LATERAL (
        SELECT id, target_ref
        FROM haetsal_canonical.canonical_projection_results
        WHERE projection_job_id = j.id
        ORDER BY updated_at DESC, created_at DESC, id DESC
        LIMIT 1
      ) r ON true
      WHERE m.tenant_id = ${tenantId}
        AND m.graph_kind = 'edge'
        AND j.projection_kind = 'graphiti'
        AND j.status = 'completed'
    `)
  }

  async getStats(tenantId: string): Promise<CanonicalStatsRow> {
    const counts = await this.first<{
      capture_count: number
      document_count: number
      chunk_count: number
      operation_count: number
      pending_projection_count: number
      completed_projection_count: number
      failed_projection_count: number
      last_capture_at: number | null
    }>(this.sql`
      SELECT
        (SELECT COUNT(*)::int FROM haetsal_canonical.canonical_captures WHERE tenant_id = ${tenantId}) AS capture_count,
        (SELECT COUNT(*)::int FROM haetsal_canonical.canonical_documents WHERE tenant_id = ${tenantId}) AS document_count,
        (SELECT COUNT(*)::int FROM haetsal_canonical.canonical_chunks WHERE tenant_id = ${tenantId}) AS chunk_count,
        (SELECT COUNT(*)::int FROM haetsal_canonical.canonical_memory_operations WHERE tenant_id = ${tenantId}) AS operation_count,
        (SELECT COUNT(*)::int FROM haetsal_canonical.canonical_projection_jobs WHERE tenant_id = ${tenantId} AND status IN ('accepted', 'queued')) AS pending_projection_count,
        (SELECT COUNT(*)::int FROM haetsal_canonical.canonical_projection_jobs WHERE tenant_id = ${tenantId} AND status = 'completed') AS completed_projection_count,
        (SELECT COUNT(*)::int FROM haetsal_canonical.canonical_projection_jobs WHERE tenant_id = ${tenantId} AND status = 'failed') AS failed_projection_count,
        (SELECT MAX(captured_at) FROM haetsal_canonical.canonical_captures WHERE tenant_id = ${tenantId}) AS last_capture_at
    `)
    const scopes = await this.rows<{ scope: string; count: number }>(this.sql`
      SELECT scope, COUNT(*)::int AS count
      FROM haetsal_canonical.canonical_captures
      WHERE tenant_id = ${tenantId}
      GROUP BY scope
      ORDER BY count DESC, scope ASC
    `)
    return {
      captureCount: counts?.capture_count ?? 0,
      documentCount: counts?.document_count ?? 0,
      chunkCount: counts?.chunk_count ?? 0,
      operationCount: counts?.operation_count ?? 0,
      pendingProjectionCount: counts?.pending_projection_count ?? 0,
      completedProjectionCount: counts?.completed_projection_count ?? 0,
      failedProjectionCount: counts?.failed_projection_count ?? 0,
      lastCaptureAt: counts?.last_capture_at ?? null,
      scopes: scopes.map((row) => ({ scope: row.scope, count: row.count })),
    }
  }

  async getLatestHindsightProjection(
    tenantId: string,
    args: { captureId?: string | null; operationId?: string | null },
  ): Promise<CanonicalHindsightProjectionLookupRow | null> {
    return this.first<CanonicalHindsightProjectionLookupRow>(this.sql`
      SELECT c.id AS capture_id, d.id AS document_id, o.id AS operation_id,
             j.id AS projection_job_id, r.id AS projection_result_id,
             j.status AS projection_status, r.status AS result_status,
             r.engine_document_id, r.engine_operation_id, r.target_ref
      FROM haetsal_canonical.canonical_projection_jobs j
      INNER JOIN haetsal_canonical.canonical_captures c ON c.id = j.capture_id
      INNER JOIN haetsal_canonical.canonical_documents d ON d.id = j.document_id
      INNER JOIN haetsal_canonical.canonical_memory_operations o ON o.id = j.operation_id
      INNER JOIN LATERAL (
        SELECT id, status, engine_document_id, engine_operation_id, target_ref, updated_at, created_at
        FROM haetsal_canonical.canonical_projection_results
        WHERE projection_job_id = j.id
        ORDER BY updated_at DESC, created_at DESC, id DESC
        LIMIT 1
      ) r ON true
      WHERE j.tenant_id = ${tenantId}
        AND j.projection_kind = 'hindsight'
        AND (
          (${args.captureId ?? null}::text IS NOT NULL AND c.id = ${args.captureId ?? null})
          OR (${args.operationId ?? null}::text IS NOT NULL AND o.id = ${args.operationId ?? null})
      )
      ORDER BY r.updated_at DESC, r.created_at DESC, r.id DESC
      LIMIT 1
    `)
  }

  async listGraphIdentityMappings(tenantId: string): Promise<CanonicalGraphIdentityMappingRecord[]> {
    return this.rows<CanonicalGraphIdentityMappingRecord>(this.sql`
      SELECT id, tenant_id, projection_job_id, canonical_key, graph_ref, graph_kind, created_at, updated_at
      FROM haetsal_canonical.canonical_graph_identity_mappings
      WHERE tenant_id = ${tenantId}
      ORDER BY graph_kind ASC, canonical_key ASC
    `)
  }
}
