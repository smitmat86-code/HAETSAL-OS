import { CANONICAL_POSTGRES_SCHEMA } from './canonical-postgres-schema'
import { assertCanonicalArtifactManifestShape } from './canonical-artifact-manifest'
import { CANONICAL_BASE_DDL } from './canonical-postgres-base-ddl'
import { CANONICAL_GOVERNANCE_DDL } from './canonical-governance-ddl'
import type { PostgresSql } from './postgres-sql'
import type {
  CanonicalArtifactRecord,
  CanonicalCaptureRecord,
  CanonicalCaptureWrite,
  CanonicalDispatchStateInput,
  CanonicalDocumentLookupRow,
  CanonicalGraphIdentityMapping,
  CanonicalGraphIdentityMappingRecord,
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
  CanonicalRetrievalRow,
  CanonicalStatsRow,
} from './canonical-postgres-schema'

export interface CanonicalMemoryStore {
  writeCapture(input: CanonicalCaptureWrite): Promise<void>
  listRecentEvents(tenantId: string, limit: number): Promise<NonNullable<CanonicalCaptureWrite['event']>[]>
  /** Phase 2 retrieval surface. */
  searchChunksLexical(tenantId: string, query: string, scope: string | null, limit: number): Promise<CanonicalRetrievalRow[]>
  searchChunksSemantic(tenantId: string, embedding: number[], scope: string | null, limit: number): Promise<CanonicalRetrievalRow[]>
  updateChunkEmbeddings(tenantId: string, updates: Array<{ chunkId: string; embedding: number[] }>): Promise<void>
  listCapturesBetween(tenantId: string, fromMs: number, toMs: number, scope: string | null, limit: number): Promise<CanonicalRetrievalRow[]>
  vectorSearchAvailable(): Promise<boolean>
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
  listCompletedProjectionOperationIds(
    tenantId: string,
    projectionKind: CanonicalProjectionKind,
  ): Promise<string[]>
  getStats(tenantId: string): Promise<CanonicalStatsRow>
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

function assertValidCanonicalCaptureWrite(input: CanonicalCaptureWrite): void {
  const ids = new Set(input.artifacts.map(artifact => artifact.id))
  if (ids.size !== input.artifacts.length) throw new Error('Duplicate canonical artifact id')
  if (input.capture.tenant_id !== input.document.tenant_id || input.capture.id !== input.document.capture_id) {
    throw new Error('Canonical document tenant/capture mismatch')
  }
  if (input.capture.artifact_id !== input.document.artifact_id) {
    throw new Error('Canonical primary artifact pointers disagree')
  }
  if (input.artifacts.length > 0 && !input.capture.artifact_id) {
    throw new Error('Canonical artifact manifest requires a primary pointer')
  }
  if (input.capture.artifact_id && !ids.has(input.capture.artifact_id)) {
    throw new Error('Canonical primary artifact is absent from manifest')
  }
  if (new Set(input.artifacts.map(artifact => artifact.ordinal)).size !== input.artifacts.length) {
    throw new Error('Canonical artifact manifest has duplicate ordinals')
  }
  for (const artifact of input.artifacts) {
    if (artifact.tenant_id !== input.capture.tenant_id || artifact.capture_id !== input.capture.id) {
      throw new Error('Canonical artifact tenant/capture mismatch')
    }
  }
  // Shared structural contract with capture normalization and the
  // artifact-intake finalization schema (canonical-artifact-manifest.ts).
  const ordered = [...input.artifacts].sort((first, second) => first.ordinal - second.ordinal)
  assertCanonicalArtifactManifestShape(ordered.map(artifact => ({
    id: artifact.id,
    role: artifact.role,
    parentId: artifact.parent_artifact_id,
    primary: artifact.id === input.capture.artifact_id,
  })))
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
  private readonly events = new Map<string, NonNullable<CanonicalCaptureWrite['event']>>()
  private readonly chunkEmbeddings = new Map<string, number[]>()

  async writeCapture(input: CanonicalCaptureWrite): Promise<void> {
    assertValidCanonicalCaptureWrite(input)
    this.captures.set(input.capture.id, { ...input.capture })
    input.artifacts.forEach((artifact) => { this.artifactRows.set(artifact.id, { ...artifact }) })
    this.documents.set(input.document.id, { ...input.document })
    input.chunks.forEach((chunk) => { this.chunks.set(chunk.id, { ...chunk }) })
    this.operations.set(input.operation.id, { ...input.operation })
    input.projectionJobs.forEach((job) => { this.projectionJobs.set(job.id, { ...job }) })
    if (input.event) this.events.set(input.event.id, { ...input.event })
  }

  async listRecentEvents(tenantId: string, limit: number): Promise<NonNullable<CanonicalCaptureWrite['event']>[]> {
    return [...this.events.values()]
      .filter((event) => event.tenant_id === tenantId)
      .sort((left, right) => right.occurred_at - left.occurred_at || right.id.localeCompare(left.id))
      .slice(0, limit)
      .map((event) => ({ ...event }))
  }

  private retrievalRow(
    chunk: CanonicalCaptureWrite['chunks'][number] | null,
    capture: CanonicalCaptureRecord,
    document: CanonicalCaptureWrite['document'],
    score: number | null,
  ): CanonicalRetrievalRow {
    return {
      capture_id: capture.id,
      document_id: document.id,
      chunk_id: chunk?.id ?? null,
      title: capture.title,
      scope: capture.scope,
      source_system: capture.source_system,
      source_ref: capture.source_ref,
      captured_at: capture.captured_at,
      chunk_text: chunk?.chunk_text ?? null,
      score,
      trust_state: capture.trust_state,
      use_policy: capture.use_policy,
      memory_class: capture.memory_class,
      author_kind: capture.author_kind,
    }
  }

  private chunkJoin(tenantId: string, scope: string | null): Array<{
    chunk: CanonicalCaptureWrite['chunks'][number]
    capture: CanonicalCaptureRecord
    document: CanonicalCaptureWrite['document']
  }> {
    const joined: Array<{ chunk: CanonicalCaptureWrite['chunks'][number]; capture: CanonicalCaptureRecord; document: CanonicalCaptureWrite['document'] }> = []
    for (const chunk of this.chunks.values()) {
      if (chunk.tenant_id !== tenantId) continue
      const document = this.documents.get(chunk.document_id)
      if (!document) continue
      const capture = this.captures.get(document.capture_id)
      if (!capture || (scope && capture.scope !== scope)) continue
      joined.push({ chunk, capture, document })
    }
    return joined
  }

  async searchChunksLexical(tenantId: string, query: string, scope: string | null, limit: number): Promise<CanonicalRetrievalRow[]> {
    const terms = query.toLowerCase().split(/\W+/).filter((term) => term.length > 1)
    if (terms.length === 0) return []
    return this.chunkJoin(tenantId, scope)
      .map(({ chunk, capture, document }) => {
        const text = (chunk.chunk_text ?? '').toLowerCase()
        if (!text) return null
        const matched = terms.filter((term) => text.includes(term)).length
        return matched > 0 ? this.retrievalRow(chunk, capture, document, matched / terms.length) : null
      })
      .filter((row): row is CanonicalRetrievalRow => row !== null)
      .sort((left, right) => (right.score ?? 0) - (left.score ?? 0) || right.captured_at - left.captured_at)
      .slice(0, limit)
  }

  async searchChunksSemantic(tenantId: string, embedding: number[], scope: string | null, limit: number): Promise<CanonicalRetrievalRow[]> {
    const cosine = (left: number[], right: number[]): number => {
      let dot = 0, normLeft = 0, normRight = 0
      const length = Math.min(left.length, right.length)
      for (let i = 0; i < length; i++) {
        dot += left[i]! * right[i]!
        normLeft += left[i]! * left[i]!
        normRight += right[i]! * right[i]!
      }
      return normLeft && normRight ? dot / (Math.sqrt(normLeft) * Math.sqrt(normRight)) : 0
    }
    return this.chunkJoin(tenantId, scope)
      .map(({ chunk, capture, document }) => {
        const stored = this.chunkEmbeddings.get(chunk.id)
        return stored ? this.retrievalRow(chunk, capture, document, cosine(embedding, stored)) : null
      })
      .filter((row): row is CanonicalRetrievalRow => row !== null)
      .sort((left, right) => (right.score ?? 0) - (left.score ?? 0) || right.captured_at - left.captured_at)
      .slice(0, limit)
  }

  async updateChunkEmbeddings(tenantId: string, updates: Array<{ chunkId: string; embedding: number[] }>): Promise<void> {
    for (const update of updates) {
      const chunk = this.chunks.get(update.chunkId)
      if (chunk?.tenant_id === tenantId) this.chunkEmbeddings.set(update.chunkId, [...update.embedding])
    }
  }

  async listCapturesBetween(tenantId: string, fromMs: number, toMs: number, scope: string | null, limit: number): Promise<CanonicalRetrievalRow[]> {
    const rows: CanonicalRetrievalRow[] = []
    for (const document of this.documents.values()) {
      if (document.tenant_id !== tenantId) continue
      const capture = this.captures.get(document.capture_id)
      if (!capture || capture.captured_at < fromMs || capture.captured_at > toMs) continue
      if (scope && capture.scope !== scope) continue
      rows.push(this.retrievalRow(null, capture, document, null))
    }
    return rows
      .sort((left, right) => right.captured_at - left.captured_at)
      .slice(0, limit)
  }

  async vectorSearchAvailable(): Promise<boolean> {
    return true
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
    const artifactManifest = [...this.artifactRows.values()]
      .filter(row => row.tenant_id === tenantId && row.capture_id === capture.id)
      .sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id))
      .map(row => ({
        artifact_id: row.id,
        role: row.role,
        parent_artifact_id: row.parent_artifact_id,
        storage_kind: row.storage_kind,
        r2_key: row.r2_key,
        media_type: row.media_type,
        filename: row.filename,
        byte_length: row.byte_length,
        sha256: row.sha256,
        cipher_sha256: row.cipher_sha256,
        encryption_family: row.encryption_family,
        ordinal: row.ordinal,
        primary: row.id === capture.artifact_id,
      }))
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
      artifact_manifest: artifactManifest,
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

}

export class PostgresCanonicalMemoryStore implements CanonicalMemoryStore {
  private schemaReadyPromise: Promise<void> | null = null

  constructor(private readonly sql: PostgresSql) {}

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
    await this.sql.query(`CREATE SCHEMA IF NOT EXISTS ${CANONICAL_POSTGRES_SCHEMA}`)
    for (const statement of [...CANONICAL_BASE_DDL, ...CANONICAL_GOVERNANCE_DDL]) {
      await this.sql.query(statement)
    }
  }

  private async rows<T>(query: Promise<unknown[]>): Promise<T[]> {
    await this.ensureSchema()
    return (await query as T[]).map((row) => normalizeDbRow(row))
  }

  private async first<T>(query: Promise<unknown[]>): Promise<T | null> {
    return (await this.rows<T>(query))[0] ?? null
  }

  async writeCapture(input: CanonicalCaptureWrite): Promise<void> {
    await this.ensureSchema()
    assertValidCanonicalCaptureWrite(input)
    const queries = [
      this.sql.prepare`INSERT INTO haetsal_canonical.canonical_captures
        (id, tenant_id, source_system, source_ref, scope, title, body_r2_key, body_sha256, artifact_id, captured_at, created_at,
         memory_class, trust_state, use_policy, author_kind, agent_identity, model_runtime, confidence, retention,
         provenance_note, memory_type, dedup_hash, salience_tier, governance_downgraded_json)
        VALUES (${input.capture.id}, ${input.capture.tenant_id}, ${input.capture.source_system}, ${input.capture.source_ref},
                ${input.capture.scope}, ${input.capture.title}, ${input.capture.body_r2_key}, ${input.capture.body_sha256},
                ${input.capture.artifact_id}, ${input.capture.captured_at}, ${input.capture.created_at},
                ${input.capture.memory_class}, ${input.capture.trust_state}, ${input.capture.use_policy},
                ${input.capture.author_kind}, ${input.capture.agent_identity}, ${input.capture.model_runtime},
                ${input.capture.confidence}, ${input.capture.retention}, ${input.capture.provenance_note},
                ${input.capture.memory_type}, ${input.capture.dedup_hash}, ${input.capture.salience_tier},
                ${input.capture.governance_downgraded_json})`,
      ...input.artifacts.map(artifact => this.sql.prepare`INSERT INTO haetsal_canonical.canonical_artifacts
        (id, tenant_id, capture_id, storage_kind, r2_key, media_type, filename, byte_length, sha256,
         cipher_sha256, encryption_family, role, parent_artifact_id, ordinal, created_at)
        VALUES (${artifact.id}, ${artifact.tenant_id}, ${artifact.capture_id}, ${artifact.storage_kind},
                ${artifact.r2_key}, ${artifact.media_type}, ${artifact.filename}, ${artifact.byte_length},
                ${artifact.sha256}, ${artifact.cipher_sha256}, ${artifact.encryption_family}, ${artifact.role},
                ${artifact.parent_artifact_id}, ${artifact.ordinal}, ${artifact.created_at})`),
      this.sql.prepare`INSERT INTO haetsal_canonical.canonical_documents
        (id, tenant_id, capture_id, artifact_id, title, body_r2_key, body_sha256, chunk_count, created_at)
        VALUES (${input.document.id}, ${input.document.tenant_id}, ${input.document.capture_id}, ${input.document.artifact_id},
                ${input.document.title}, ${input.document.body_r2_key}, ${input.document.body_sha256},
                ${input.document.chunk_count}, ${input.document.created_at})`,
      ...input.chunks.map((chunk) => this.sql.prepare`INSERT INTO haetsal_canonical.canonical_chunks
        (id, tenant_id, document_id, ordinal, start_offset, end_offset, chunk_sha256, chunk_text, created_at)
        VALUES (${chunk.id}, ${chunk.tenant_id}, ${chunk.document_id}, ${chunk.ordinal}, ${chunk.start_offset},
                ${chunk.end_offset}, ${chunk.chunk_sha256}, ${chunk.chunk_text}, ${chunk.created_at})`),
      this.sql.prepare`INSERT INTO haetsal_canonical.canonical_memory_operations
        (id, tenant_id, capture_id, operation_type, status, created_at, updated_at)
        VALUES (${input.operation.id}, ${input.operation.tenant_id}, ${input.operation.capture_id},
                ${input.operation.operation_type}, ${input.operation.status}, ${input.operation.created_at}, ${input.operation.updated_at})`,
      ...input.projectionJobs.map((job) => this.sql.prepare`INSERT INTO haetsal_canonical.canonical_projection_jobs
        (id, tenant_id, operation_id, capture_id, document_id, projection_kind, status, created_at, enqueued_at)
        VALUES (${job.id}, ${job.tenant_id}, ${job.operation_id}, ${job.capture_id}, ${job.document_id},
                ${job.projection_kind}, ${job.status}, ${job.created_at}, ${job.enqueued_at})`),
      ...(input.event ? [this.sql.prepare`INSERT INTO haetsal_canonical.canonical_events
        (id, tenant_id, event_type, subject_kind, subject_id, capture_id, actor_kind, actor_identity, occurred_at, recorded_at, detail_json)
        VALUES (${input.event.id}, ${input.event.tenant_id}, ${input.event.event_type}, ${input.event.subject_kind},
                ${input.event.subject_id}, ${input.event.capture_id}, ${input.event.actor_kind}, ${input.event.actor_identity},
                ${input.event.occurred_at}, ${input.event.recorded_at}, ${input.event.detail_json})`] : []),
    ]
    await this.sql.transaction(queries)
  }

  async getCapture(tenantId: string, captureId: string): Promise<CanonicalCaptureRecord | null> {
    return this.first<CanonicalCaptureRecord>(this.sql`
      SELECT id, tenant_id, source_system, source_ref, scope, title, body_r2_key, body_sha256, artifact_id, captured_at, created_at,
             memory_class, trust_state, use_policy, author_kind, agent_identity, model_runtime, confidence, retention,
             provenance_note, memory_type, dedup_hash, salience_tier, governance_downgraded_json
      FROM haetsal_canonical.canonical_captures
      WHERE tenant_id = ${tenantId} AND id = ${captureId}
      LIMIT 1
    `)
  }

  async listRecentEvents(tenantId: string, limit: number): Promise<NonNullable<CanonicalCaptureWrite['event']>[]> {
    return this.rows<NonNullable<CanonicalCaptureWrite['event']>>(this.sql`
      SELECT id, tenant_id, event_type, subject_kind, subject_id, capture_id, actor_kind, actor_identity,
             occurred_at, recorded_at, detail_json
      FROM haetsal_canonical.canonical_events
      WHERE tenant_id = ${tenantId}
      ORDER BY occurred_at DESC, id DESC
      LIMIT ${limit}
    `)
  }

  private vectorReadyPromise: Promise<boolean> | null = null

  /**
   * Probes pgvector availability and provisions the embedding column lazily.
   * Neon and the pgvector dev image support it; environments without the
   * extension degrade semantic search to lexical (never fail captures).
   */
  async vectorSearchAvailable(): Promise<boolean> {
    if (!this.vectorReadyPromise) {
      this.vectorReadyPromise = (async () => {
        await this.ensureSchema()
        try {
          await this.sql.query('CREATE EXTENSION IF NOT EXISTS vector')
          await this.sql.query(`ALTER TABLE ${CANONICAL_POSTGRES_SCHEMA}.canonical_chunks
            ADD COLUMN IF NOT EXISTS embedding vector(768)`)
          return true
        } catch (error) {
          console.warn('CANONICAL_VECTOR_UNAVAILABLE', {
            error: error instanceof Error ? error.message : String(error),
          })
          return false
        }
      })()
    }
    return this.vectorReadyPromise
  }

  async searchChunksLexical(tenantId: string, query: string, scope: string | null, limit: number): Promise<CanonicalRetrievalRow[]> {
    return this.rows<CanonicalRetrievalRow>(this.sql`
      SELECT c.id AS capture_id, d.id AS document_id, ch.id AS chunk_id, c.title, c.scope,
             c.source_system, c.source_ref, c.captured_at, ch.chunk_text,
             ts_rank(to_tsvector('english', COALESCE(ch.chunk_text, '')), websearch_to_tsquery('english', ${query}))::float8 AS score,
             c.trust_state, c.use_policy, c.memory_class, c.author_kind
      FROM haetsal_canonical.canonical_chunks ch
      INNER JOIN haetsal_canonical.canonical_documents d ON d.id = ch.document_id
      INNER JOIN haetsal_canonical.canonical_captures c ON c.id = d.capture_id
      WHERE ch.tenant_id = ${tenantId}
        AND ch.chunk_text IS NOT NULL
        AND to_tsvector('english', COALESCE(ch.chunk_text, '')) @@ websearch_to_tsquery('english', ${query})
        AND (${scope}::text IS NULL OR c.scope = ${scope})
      ORDER BY score DESC, c.captured_at DESC
      LIMIT ${limit}
    `)
  }

  async searchChunksSemantic(tenantId: string, embedding: number[], scope: string | null, limit: number): Promise<CanonicalRetrievalRow[]> {
    if (!(await this.vectorSearchAvailable())) return []
    const vector = `[${embedding.join(',')}]`
    return this.rows<CanonicalRetrievalRow>(this.sql`
      SELECT c.id AS capture_id, d.id AS document_id, ch.id AS chunk_id, c.title, c.scope,
             c.source_system, c.source_ref, c.captured_at, ch.chunk_text,
             (1 - (ch.embedding <=> ${vector}::vector))::float8 AS score,
             c.trust_state, c.use_policy, c.memory_class, c.author_kind
      FROM haetsal_canonical.canonical_chunks ch
      INNER JOIN haetsal_canonical.canonical_documents d ON d.id = ch.document_id
      INNER JOIN haetsal_canonical.canonical_captures c ON c.id = d.capture_id
      WHERE ch.tenant_id = ${tenantId}
        AND ch.embedding IS NOT NULL
        AND (${scope}::text IS NULL OR c.scope = ${scope})
      ORDER BY ch.embedding <=> ${vector}::vector ASC
      LIMIT ${limit}
    `)
  }

  async updateChunkEmbeddings(tenantId: string, updates: Array<{ chunkId: string; embedding: number[] }>): Promise<void> {
    if (updates.length === 0 || !(await this.vectorSearchAvailable())) return
    await this.sql.transaction(updates.map((update) => this.sql.prepare`
      UPDATE haetsal_canonical.canonical_chunks
      SET embedding = ${`[${update.embedding.join(',')}]`}::vector
      WHERE tenant_id = ${tenantId} AND id = ${update.chunkId}
    `))
  }

  async listCapturesBetween(tenantId: string, fromMs: number, toMs: number, scope: string | null, limit: number): Promise<CanonicalRetrievalRow[]> {
    return this.rows<CanonicalRetrievalRow>(this.sql`
      SELECT c.id AS capture_id, d.id AS document_id, NULL AS chunk_id, c.title, c.scope,
             c.source_system, c.source_ref, c.captured_at, NULL AS chunk_text, NULL::float8 AS score,
             c.trust_state, c.use_policy, c.memory_class, c.author_kind
      FROM haetsal_canonical.canonical_captures c
      INNER JOIN haetsal_canonical.canonical_documents d ON d.capture_id = c.id
      WHERE c.tenant_id = ${tenantId}
        AND c.captured_at >= ${fromMs} AND c.captured_at <= ${toMs}
        AND (${scope}::text IS NULL OR c.scope = ${scope})
      ORDER BY c.captured_at DESC
      LIMIT ${limit}
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
    const row = await this.first<Omit<CanonicalDocumentLookupRow, 'artifact_manifest'>>(this.sql`
      SELECT c.id AS capture_id, d.id AS document_id, d.title, c.scope, c.source_system, c.source_ref, c.captured_at,
             d.body_r2_key, d.chunk_count, d.created_at AS document_created_at,
             a.id AS artifact_id, a.filename, a.media_type, a.byte_length, a.storage_kind, a.r2_key
      FROM haetsal_canonical.canonical_documents d
      INNER JOIN haetsal_canonical.canonical_captures c ON c.id = d.capture_id
      LEFT JOIN haetsal_canonical.canonical_artifacts a ON a.id = d.artifact_id
      WHERE d.tenant_id = ${tenantId} AND d.id = ${documentId}
      LIMIT 1
    `)
    if (!row) return null
    const manifest = await this.rows<CanonicalDocumentLookupRow['artifact_manifest'][number]>(this.sql`
      SELECT a.id AS artifact_id, a.role, a.parent_artifact_id, a.storage_kind, a.r2_key, a.media_type, a.filename,
             a.byte_length, a.sha256, a.cipher_sha256, a.encryption_family, a.ordinal,
             (a.id = c.artifact_id) AS primary
      FROM haetsal_canonical.canonical_artifacts a
      INNER JOIN haetsal_canonical.canonical_captures c ON c.id = a.capture_id AND c.tenant_id = a.tenant_id
      WHERE a.tenant_id = ${tenantId} AND a.capture_id = ${row.capture_id}
      ORDER BY a.ordinal ASC, a.id ASC
    `)
    return { ...row, artifact_manifest: manifest.map(item => ({ ...item, primary: Boolean(item.primary) })) }
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
      this.sql.prepare`UPDATE haetsal_canonical.canonical_memory_operations
        SET status = ${input.status}, updated_at = ${input.updatedAt}
        WHERE tenant_id = ${input.tenantId} AND id = ${input.operationId}`,
      ...jobs.map((job) => this.sql.prepare`UPDATE haetsal_canonical.canonical_projection_jobs
        SET status = ${input.status}, enqueued_at = ${input.updatedAt}
        WHERE tenant_id = ${input.tenantId} AND id = ${job.id}`),
      ...jobs.map((job) => this.sql.prepare`INSERT INTO haetsal_canonical.canonical_projection_results
        (id, tenant_id, projection_job_id, status, target_ref, error_message, engine_bank_id, engine_document_id, engine_operation_id, created_at, updated_at)
        VALUES (${crypto.randomUUID()}, ${input.tenantId}, ${job.id}, ${input.status}, NULL,
                ${input.status === 'failed' ? input.errorMessage ?? null : null}, NULL, NULL, NULL, ${input.updatedAt}, ${input.updatedAt})`),
    ]
    await this.sql.transaction(queries)
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
        projection_kind: (jobRows.find((job) => job.id === row.id)?.projection_kind ?? 'unknown'),
        status: row.status,
        created_at: 0,
        enqueued_at: 0,
      })),
      input.operationId,
      input.jobId,
      input.jobStatus,
    )
    const queries = [
      this.sql.prepare`UPDATE haetsal_canonical.canonical_memory_operations
        SET status = ${aggregateStatus}, updated_at = ${input.updatedAt}
        WHERE tenant_id = ${input.tenantId} AND id = ${input.operationId}`,
      this.sql.prepare`UPDATE haetsal_canonical.canonical_projection_jobs
        SET status = ${input.jobStatus}
        WHERE tenant_id = ${input.tenantId} AND id = ${input.jobId}`,
      this.sql.prepare`INSERT INTO haetsal_canonical.canonical_projection_results
        (id, tenant_id, projection_job_id, status, target_ref, error_message, engine_bank_id, engine_document_id, engine_operation_id, created_at, updated_at)
        VALUES (${crypto.randomUUID()}, ${input.tenantId}, ${input.jobId}, ${input.resultStatus}, ${input.targetRef},
                ${input.errorMessage ?? null}, ${input.engineBankId ?? null}, ${input.engineDocumentId ?? null},
                ${input.engineOperationId ?? null}, ${input.updatedAt}, ${input.updatedAt})`,
      ...dedupeGraphMappings(input.graphMappings).map((mapping) => this.sql.prepare`INSERT INTO haetsal_canonical.canonical_graph_identity_mappings
        (id, tenant_id, projection_job_id, canonical_key, graph_ref, graph_kind, created_at, updated_at)
        VALUES (${crypto.randomUUID()}, ${input.tenantId}, ${input.jobId}, ${mapping.canonicalKey}, ${mapping.graphRef},
                ${mapping.graphKind}, ${input.updatedAt}, ${input.updatedAt})
        ON CONFLICT (projection_job_id, canonical_key, graph_kind)
        DO UPDATE SET graph_ref = EXCLUDED.graph_ref, updated_at = EXCLUDED.updated_at`),
    ]
    await this.sql.transaction(queries)
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

}

export { PostgresCanonicalMemoryStore as NeonCanonicalMemoryStore }
