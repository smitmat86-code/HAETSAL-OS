import type { D1Database } from '@cloudflare/workers-types'
import type { CanonicalProjectionKind } from '../types/canonical-memory'

type CaptureAuditArgs = { tenantId: string; createdAt: number; captureId: string }
type OperationAuditArgs = { tenantId: string; createdAt: number; operationId: string }
type ProjectionAuditArgs = OperationAuditArgs & { projectionKinds: CanonicalProjectionKind[] }
type ProjectionAuditAction =
  | 'memory.projection.hindsight_started'
  | 'memory.projection.hindsight_queued'
  | 'memory.projection.hindsight_completed'
  | 'memory.projection.hindsight_failed'
  | 'memory.projection.hindsight_reflect_started'
  | 'memory.projection.hindsight_reflect_completed'
  | 'memory.projection.hindsight_reflect_failed'
  | 'memory.projection.graphiti_started'
  | 'memory.projection.graphiti_queued'
  | 'memory.projection.graphiti_completed'
  | 'memory.projection.graphiti_failed'

function insertCanonicalAudit(
  db: D1Database,
  args: { tenantId: string; createdAt: number; action: string; memoryId: string; provenance: string; domain: string; memoryType?: string },
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO memory_audit
     (id, tenant_id, created_at, operation, memory_id, provenance, domain, memory_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    args.tenantId,
    args.createdAt,
    args.action,
    args.memoryId,
    args.provenance,
    args.domain,
    args.memoryType ?? null,
  )
}

function buildProjectionAuditBatch(
  db: D1Database,
  args: OperationAuditArgs & { action: ProjectionAuditAction; provenance: 'hindsight' | 'graphiti' },
): D1PreparedStatement[] {
  return [insertCanonicalAudit(db, {
    tenantId: args.tenantId,
    createdAt: args.createdAt,
    action: args.action,
    memoryId: args.operationId,
    provenance: args.provenance,
    domain: 'canonical',
    memoryType: 'world',
  })]
}

export function buildCanonicalCaptureAcceptedAuditBatch(
  db: D1Database,
  args: CaptureAuditArgs,
): D1PreparedStatement[] {
  return [insertCanonicalAudit(db, {
    tenantId: args.tenantId,
    createdAt: args.createdAt,
    action: 'memory.capture.accepted',
    memoryId: args.captureId,
    provenance: 'canonical',
    domain: 'canonical',
  })]
}

export function buildCanonicalProjectionQueuedAuditBatch(
  db: D1Database,
  args: ProjectionAuditArgs,
): D1PreparedStatement[] {
  return args.projectionKinds.map((kind) => insertCanonicalAudit(db, {
    tenantId: args.tenantId,
    createdAt: args.createdAt,
    action: 'memory.projection.queued',
    memoryId: args.operationId,
    provenance: kind,
    domain: 'canonical',
    memoryType: 'world',
  }))
}

export function buildCanonicalCaptureFailedAuditBatch(
  db: D1Database,
  args: OperationAuditArgs,
): D1PreparedStatement[] {
  return [insertCanonicalAudit(db, {
    tenantId: args.tenantId,
    createdAt: args.createdAt,
    action: 'memory.capture.failed',
    memoryId: args.operationId,
    provenance: 'canonical',
    domain: 'canonical',
  })]
}

export function buildCanonicalCompatibilityAuditBatch(
  db: D1Database,
  args: OperationAuditArgs & { failed?: boolean },
): D1PreparedStatement[] {
  return [insertCanonicalAudit(db, {
    tenantId: args.tenantId,
    createdAt: args.createdAt,
    action: args.failed ? 'memory.capture.compatibility_retain_failed' : 'memory.capture.compatibility_retain_started',
    memoryId: args.operationId,
    provenance: 'current_hindsight',
    domain: 'canonical',
  })]
}

export function buildCanonicalHindsightProjectionAuditBatch(
  db: D1Database,
  args: OperationAuditArgs & { action: Extract<ProjectionAuditAction, `memory.projection.hindsight_${string}`> },
): D1PreparedStatement[] {
  return buildProjectionAuditBatch(db, { ...args, provenance: 'hindsight' })
}

export function buildCanonicalHindsightReflectionAuditBatch(
  db: D1Database,
  args: OperationAuditArgs & { action: Extract<ProjectionAuditAction, `memory.projection.hindsight_reflect_${string}`> },
): D1PreparedStatement[] {
  return buildProjectionAuditBatch(db, { ...args, provenance: 'hindsight' })
}

export function buildCanonicalGraphitiProjectionAuditBatch(
  db: D1Database,
  args: OperationAuditArgs & { action: Extract<ProjectionAuditAction, `memory.projection.graphiti_${string}`> },
): D1PreparedStatement[] {
  return buildProjectionAuditBatch(db, { ...args, provenance: 'graphiti' })
}
