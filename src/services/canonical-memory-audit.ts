import type { D1Database } from '@cloudflare/workers-types'
import type { CanonicalProjectionKind } from '../types/canonical-memory'

interface CanonicalAuditArgs {
  tenantId: string
  captureId: string
  operationId: string
  projectionKinds: CanonicalProjectionKind[]
  createdAt: number
}

export function buildCanonicalAuditBatch(
  db: D1Database,
  args: CanonicalAuditArgs,
): D1PreparedStatement[] {
  const accepted = db.prepare(
    `INSERT INTO memory_audit
     (id, tenant_id, created_at, operation, memory_id, provenance, domain)
     VALUES (?, ?, ?, 'memory.capture.accepted', ?, 'canonical', 'canonical')`,
  ).bind(
    crypto.randomUUID(),
    args.tenantId,
    args.createdAt,
    args.captureId,
  )

  const projections = args.projectionKinds.map(kind => db.prepare(
    `INSERT INTO memory_audit
     (id, tenant_id, created_at, operation, memory_id, provenance, domain)
     VALUES (?, ?, ?, 'memory.projection.enqueued', ?, ?, 'canonical')`,
  ).bind(
    crypto.randomUUID(),
    args.tenantId,
    args.createdAt,
    args.operationId,
    kind,
  ))

  return [accepted, ...projections]
}
