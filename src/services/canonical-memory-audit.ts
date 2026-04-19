import type { D1Database } from '@cloudflare/workers-types'
import type { CanonicalProjectionKind } from '../types/canonical-memory'

interface CanonicalCaptureAcceptedArgs {
  tenantId: string
  captureId: string
  createdAt: number
}

interface CanonicalProjectionAuditArgs {
  tenantId: string
  operationId: string
  projectionKinds: CanonicalProjectionKind[]
  createdAt: number
}

interface CanonicalCompatibilityAuditArgs {
  tenantId: string
  operationId: string
  createdAt: number
  failed?: boolean
}

interface CanonicalHindsightProjectionAuditArgs {
  tenantId: string
  operationId: string
  createdAt: number
  action: 'memory.projection.hindsight_started'
    | 'memory.projection.hindsight_queued'
    | 'memory.projection.hindsight_completed'
    | 'memory.projection.hindsight_failed'
}

export function buildCanonicalCaptureAcceptedAuditBatch(
  db: D1Database,
  args: CanonicalCaptureAcceptedArgs,
): D1PreparedStatement[] {
  return [db.prepare(
    `INSERT INTO memory_audit
     (id, tenant_id, created_at, operation, memory_id, provenance, domain)
     VALUES (?, ?, ?, 'memory.capture.accepted', ?, 'canonical', 'canonical')`,
  ).bind(
    crypto.randomUUID(),
    args.tenantId,
    args.createdAt,
    args.captureId,
  )]
}

export function buildCanonicalProjectionQueuedAuditBatch(
  db: D1Database,
  args: CanonicalProjectionAuditArgs,
): D1PreparedStatement[] {
  return args.projectionKinds.map(kind => db.prepare(
    `INSERT INTO memory_audit
     (id, tenant_id, created_at, operation, memory_id, provenance, domain, memory_type)
     VALUES (?, ?, ?, 'memory.projection.queued', ?, ?, 'canonical', 'world')`,
  ).bind(
    crypto.randomUUID(),
    args.tenantId,
    args.createdAt,
    args.operationId,
    kind,
  ))
}

export function buildCanonicalCaptureFailedAuditBatch(
  db: D1Database,
  args: Pick<CanonicalProjectionAuditArgs, 'tenantId' | 'operationId' | 'createdAt'>,
): D1PreparedStatement[] {
  return [db.prepare(
    `INSERT INTO memory_audit
     (id, tenant_id, created_at, operation, memory_id, provenance, domain)
     VALUES (?, ?, ?, 'memory.capture.failed', ?, 'canonical', 'canonical')`,
  ).bind(
    crypto.randomUUID(),
    args.tenantId,
    args.createdAt,
    args.operationId,
  )]
}

export function buildCanonicalCompatibilityAuditBatch(
  db: D1Database,
  args: CanonicalCompatibilityAuditArgs,
): D1PreparedStatement[] {
  return [db.prepare(
    `INSERT INTO memory_audit
     (id, tenant_id, created_at, operation, memory_id, provenance, domain)
     VALUES (?, ?, ?, ?, ?, 'current_hindsight', 'canonical')`,
  ).bind(
    crypto.randomUUID(),
    args.tenantId,
    args.createdAt,
    args.failed
      ? 'memory.capture.compatibility_retain_failed'
      : 'memory.capture.compatibility_retain_started',
    args.operationId,
  )]
}

export function buildCanonicalHindsightProjectionAuditBatch(
  db: D1Database,
  args: CanonicalHindsightProjectionAuditArgs,
): D1PreparedStatement[] {
  return [db.prepare(
    `INSERT INTO memory_audit
     (id, tenant_id, created_at, operation, memory_id, provenance, domain, memory_type)
     VALUES (?, ?, ?, ?, ?, 'hindsight', 'canonical', 'world')`,
  ).bind(
    crypto.randomUUID(),
    args.tenantId,
    args.createdAt,
    args.action,
    args.operationId,
  )]
}
