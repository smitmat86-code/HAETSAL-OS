import type { Env } from '../types/env'
import type { CanonicalReflectionStatus } from '../types/canonical-memory-query'

interface ReflectionAuditRow {
  id: string
  created_at: number
  operation: 'memory.projection.hindsight_reflect_started'
    | 'memory.projection.hindsight_reflect_completed'
    | 'memory.projection.hindsight_reflect_failed'
}

interface ConsolidationRunRow {
  id: string
  error_message: string | null
}

interface TenantBankRow {
  hindsight_tenant_id: string | null
}

function pickLatestReflectionStatus(rows: ReflectionAuditRow[]): ReflectionAuditRow | null {
  if (!rows.length) return null
  return rows.sort((left, right) => {
    if (right.created_at !== left.created_at) return right.created_at - left.created_at
    const rank = (value: ReflectionAuditRow['operation']): number => {
      if (value === 'memory.projection.hindsight_reflect_completed') return 2
      if (value === 'memory.projection.hindsight_reflect_failed') return 1
      return 0
    }
    if (rank(right.operation) !== rank(left.operation)) {
      return rank(right.operation) - rank(left.operation)
    }
    return right.id.localeCompare(left.id)
  })[0] ?? null
}

async function readReflectionAuditRows(
  env: Env,
  tenantId: string,
  operationId: string,
): Promise<ReflectionAuditRow[]> {
  const rows = await env.D1_US.prepare(
    `SELECT id, created_at, operation
     FROM memory_audit
     WHERE tenant_id = ? AND memory_id = ? AND operation IN (
       'memory.projection.hindsight_reflect_started',
       'memory.projection.hindsight_reflect_completed',
       'memory.projection.hindsight_reflect_failed'
     )
     ORDER BY created_at DESC, id DESC
     LIMIT 8`,
  ).bind(tenantId, operationId).all<ReflectionAuditRow>()
  return rows.results ?? []
}

async function resolveBankId(env: Env, tenantId: string): Promise<string> {
  const tenant = await env.D1_US.prepare(
    `SELECT hindsight_tenant_id
     FROM tenants
     WHERE id = ?`,
  ).bind(tenantId).first<TenantBankRow>()
  return tenant?.hindsight_tenant_id ?? tenantId
}

export async function readCanonicalHindsightReflectionStatus(args: {
  env: Env
  tenantId: string
  operationId: string
  semanticReady: boolean
  projectedAt: number | null
}): Promise<CanonicalReflectionStatus | null> {
  if (!args.semanticReady) return null
  const bankId = await resolveBankId(args.env, args.tenantId)
  const audit = pickLatestReflectionStatus(
    await readReflectionAuditRows(args.env, args.tenantId, args.operationId),
  )

  if (!audit) {
    return {
      mode: 'hindsight',
      status: 'pending',
      targetRef: null,
      updatedAt: args.projectedAt,
      errorMessage: null,
    }
  }

  if (audit.operation === 'memory.projection.hindsight_reflect_failed') {
    const run = await args.env.D1_US.prepare(
      `SELECT id, error_message
       FROM consolidation_runs
       WHERE tenant_id = ? AND status = 'failed'
       ORDER BY completed_at DESC, started_at DESC, id DESC
       LIMIT 1`,
    ).bind(args.tenantId).first<ConsolidationRunRow>()
    return {
      mode: 'hindsight',
      status: 'failed',
      targetRef: run ? `hindsight://banks/${bankId}/consolidation-runs/${run.id}` : null,
      updatedAt: audit.created_at,
      errorMessage: run?.error_message ?? null,
    }
  }

  const run = await args.env.D1_US.prepare(
    `SELECT id
     FROM consolidation_runs
     WHERE tenant_id = ? AND status = ?
     ORDER BY COALESCE(completed_at, started_at) DESC, id DESC
     LIMIT 1`,
  ).bind(
    args.tenantId,
    audit.operation === 'memory.projection.hindsight_reflect_completed' ? 'completed' : 'running',
  ).first<Pick<ConsolidationRunRow, 'id'>>()

  return {
    mode: 'hindsight',
    status: audit.operation === 'memory.projection.hindsight_reflect_completed' ? 'completed' : 'queued',
    targetRef: run ? `hindsight://banks/${bankId}/consolidation-runs/${run.id}` : null,
    updatedAt: audit.created_at,
    errorMessage: null,
  }
}
