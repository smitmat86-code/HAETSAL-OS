import type { env } from 'cloudflare:test'
import { getCanonicalMemoryStore } from '../../src/services/canonical-postgres'
import type { CanonicalProjectionStatus } from '../../src/services/canonical-postgres-schema'

/**
 * The Hindsight WRITE path was severed in mission Phase 1: captures can no
 * longer request a 'hindsight' projection kind (captureCanonicalMemory
 * throws, and submitHindsightProjection no longer exists). The Hindsight
 * READ path (semantic recall linkback, reflection status, reconciliation of
 * already-queued projections) stays alive until Phase 2 and still needs
 * coverage over historical data.
 *
 * This helper simulates that historical state on top of a capture that
 * already went through the real (graphiti-only) pipeline: it appends an
 * extra 'hindsight' projection job to the canonical store via writeCapture
 * (which — unlike captureCanonicalMemory — does not validate projection
 * kinds) reusing the capture/document/operation rows that already exist,
 * then records a projection result for that job through the store's normal
 * recordProjectionState API.
 */
export interface SeedHistoricalHindsightProjectionOnCaptureArgs {
  testEnv: typeof env
  tenantId: string
  captureId: string
  documentId: string
  operationId: string
  jobStatus?: CanonicalProjectionStatus
  resultStatus?: CanonicalProjectionStatus
  engineBankId?: string | null
  engineDocumentId?: string | null
  engineOperationId?: string | null
  targetRef?: string | null
  errorMessage?: string | null
}

export interface SeedHistoricalHindsightProjectionOnCaptureResult {
  projectionJobId: string
  engineDocumentId: string | null
  engineOperationId: string | null
}

/**
 * NOTE: distinct from seedHistoricalHindsightProjection in
 * ./historical-hindsight-seed.ts, which builds a fully synthetic standalone
 * capture. This variant seeds a hindsight projection onto a capture that
 * already exists (e.g. one just written by the real graphiti-only pipeline),
 * so captureId/documentId/operationId stay identical across both projections
 * — required by tests asserting status/reconciliation on that shared operation.
 */
export async function seedHistoricalHindsightProjectionOnCapture(
  args: SeedHistoricalHindsightProjectionOnCaptureArgs,
): Promise<SeedHistoricalHindsightProjectionOnCaptureResult> {
  const store = getCanonicalMemoryStore(args.testEnv)
  const now = Date.now()
  const jobId = crypto.randomUUID()

  const [capture, document, operation] = await Promise.all([
    store.getCapture(args.tenantId, args.captureId),
    store.getDocument(args.tenantId, args.documentId),
    store.getOperationById(args.tenantId, args.operationId),
  ])
  if (!capture) throw new Error(`seedHistoricalHindsightProjectionOnCapture: capture not found (${args.captureId})`)
  if (!document) throw new Error(`seedHistoricalHindsightProjectionOnCapture: document not found (${args.documentId})`)
  if (!operation) throw new Error(`seedHistoricalHindsightProjectionOnCapture: operation not found (${args.operationId})`)

  await store.writeCapture({
    capture,
    artifact: null,
    document: {
      id: document.document_id,
      tenant_id: args.tenantId,
      capture_id: capture.id,
      artifact_id: document.artifact_id,
      title: document.title,
      body_r2_key: document.body_r2_key,
      body_sha256: capture.body_sha256,
      chunk_count: document.chunk_count,
      created_at: document.document_created_at,
    },
    chunks: [],
    operation: {
      id: operation.id,
      tenant_id: args.tenantId,
      capture_id: operation.capture_id,
      operation_type: operation.operation_type,
      status: operation.status,
      created_at: operation.created_at,
      updated_at: operation.updated_at,
    },
    projectionJobs: [{
      id: jobId,
      tenant_id: args.tenantId,
      operation_id: args.operationId,
      capture_id: args.captureId,
      document_id: args.documentId,
      projection_kind: 'hindsight',
      status: args.jobStatus ?? 'accepted',
      created_at: now,
      enqueued_at: now,
    }],
    event: null,
  })

  const engineBankId = args.engineBankId ?? `hindsight-${args.tenantId}`
  const engineDocumentId = args.engineDocumentId ?? `${args.tenantId}:${args.documentId}`
  const engineOperationId = args.engineOperationId ?? `op-${crypto.randomUUID()}`
  const targetRef = args.targetRef
    ?? `hindsight://banks/${engineBankId}/documents/${engineDocumentId}/operations/${engineOperationId}`

  await store.recordProjectionState({
    tenantId: args.tenantId,
    jobId,
    operationId: args.operationId,
    jobStatus: args.resultStatus ?? 'completed',
    resultStatus: args.resultStatus ?? 'completed',
    targetRef,
    errorMessage: args.errorMessage ?? null,
    engineBankId,
    engineDocumentId,
    engineOperationId,
    updatedAt: now,
  })

  return { projectionJobId: jobId, engineDocumentId, engineOperationId }
}

/**
 * Seeds a D1 hindsight_operations row directly. Nothing in production writes
 * this table anymore (the async retain path that created it was severed in
 * mission Phase 1), but reconcileHindsightOperation/handleHindsightOperationsTick
 * still poll it — that reconciliation-of-already-queued-work coverage is
 * preserved here by simulating the row a legacy queued retain would have left.
 */
export interface SeedPendingHindsightOperationArgs {
  testEnv: typeof env
  tenantId: string
  bankId: string
  operationId: string
  sourceDocumentId: string
}

export async function seedPendingHindsightOperation(
  args: SeedPendingHindsightOperationArgs,
): Promise<void> {
  const now = Date.now()
  await args.testEnv.D1_US.prepare(
    `INSERT INTO hindsight_operations
     (operation_id, tenant_id, bank_id, source_document_id, source, dedup_hash, operation_type, status, requested_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'mcp_retain', ?, 'retain', 'pending', ?, ?, ?)`,
  ).bind(
    args.operationId,
    args.tenantId,
    args.bankId,
    args.sourceDocumentId,
    crypto.randomUUID(),
    now,
    now,
    now,
  ).run()
}

/**
 * Seeds a D1 hindsight_operations row already settled with a materialized
 * document (availability_source = 'document'). isSemanticReady() in
 * canonical-memory-status.ts reads this column, so historical projections
 * that should read back as "semantically ready" need this row alongside the
 * canonical projection result seeded by seedHistoricalHindsightProjectionOnCapture.
 */
export interface SeedAvailableHindsightOperationArgs {
  testEnv: typeof env
  tenantId: string
  bankId: string
  operationId: string
  sourceDocumentId: string
  available?: boolean
}

export async function seedAvailableHindsightOperation(
  args: SeedAvailableHindsightOperationArgs,
): Promise<void> {
  const now = Date.now()
  const available = args.available ?? true
  await args.testEnv.D1_US.prepare(
    `INSERT INTO hindsight_operations
     (operation_id, tenant_id, bank_id, source_document_id, source, dedup_hash, operation_type, status,
      requested_at, created_at, updated_at, completed_at, available_at, availability_source)
     VALUES (?, ?, ?, ?, 'mcp_retain', ?, 'retain', 'completed', ?, ?, ?, ?, ?, ?)`,
  ).bind(
    args.operationId,
    args.tenantId,
    args.bankId,
    args.sourceDocumentId,
    crypto.randomUUID(),
    now,
    now,
    now,
    now,
    available ? now : null,
    available ? 'document' : null,
  ).run()
}
