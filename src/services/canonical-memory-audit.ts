import type { D1Database } from '@cloudflare/workers-types'
import type { CanonicalProjectionKind } from '../types/canonical-memory'

type CaptureAuditArgs = { tenantId: string; createdAt: number; captureId: string }
type OperationAuditArgs = { tenantId: string; createdAt: number; operationId: string }
type ProjectionAuditArgs = OperationAuditArgs & { projectionKinds: CanonicalProjectionKind[] }

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

