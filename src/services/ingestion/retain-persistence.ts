import { reconcileHindsightOperationSoon } from '../../cron/hindsight-operations'
import type { Env } from '../../types/env'
import type { HindsightRetainResponse } from '../../types/hindsight'
import type { IngestionArtifact } from '../../types/ingestion'
import { ensureHindsightWorkersRunning } from '../hindsight'

export async function archiveEncryptedContent(
  env: Env,
  tenantId: string,
  contentEncrypted: string,
  ctx?: Pick<ExecutionContext, 'waitUntil'>,
): Promise<string> {
  const stoneR2Key = `stone/${tenantId}/${Date.now()}-${crypto.randomUUID()}.enc`
  const write = env.R2_ARTIFACTS.put(stoneR2Key, contentEncrypted).catch(() => {})
  if (ctx) ctx.waitUntil(write)
  else await write
  return stoneR2Key
}

export async function persistQueuedRetain(args: {
  artifact: IngestionArtifact
  env: Env
  dedupHash: string
  stoneR2Key: string
  memoryType: string
  domain: string
  salienceTier: number
  salienceSurpriseScore: number
  documentId: string
  hindsightData: HindsightRetainResponse
  memoryId: string
  operationId: string | null
}): Promise<void> {
  const now = Date.now()
  const a = args
  const operationDedupHash = `${a.dedupHash}:${a.operationId ?? a.memoryId}`
  await a.env.D1_US.batch([
    a.env.D1_US.prepare(
      `INSERT OR IGNORE INTO ingestion_events
       (id, tenant_id, created_at, source, salience_tier, surprise_score, memory_id, r2_key, dedup_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(), a.artifact.tenantId, now, a.artifact.source,
      a.salienceTier, a.salienceSurpriseScore, null, a.stoneR2Key, a.dedupHash,
    ),
    a.env.D1_US.prepare(
      `INSERT INTO memory_audit
       (id, tenant_id, created_at, operation, memory_id, memory_type, domain, provenance, salience_tier)
       VALUES (?, ?, ?, 'retain_queued', ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(), a.artifact.tenantId, now,
      a.operationId, a.memoryType, a.domain, a.artifact.provenance ?? a.artifact.source, a.salienceTier,
    ),
    a.env.D1_US.prepare(
      `INSERT INTO hindsight_operations
       (operation_id, tenant_id, bank_id, source_document_id, source, provenance, domain,
        memory_type, salience_tier, dedup_hash, stone_r2_key, operation_type, status,
        error_message, requested_at, created_at, updated_at, completed_at, last_checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'retain', 'pending', NULL, ?, ?, ?, NULL, NULL)`,
    ).bind(
      a.operationId ?? a.memoryId,
      a.artifact.tenantId,
      a.hindsightData.bank_id,
      a.documentId,
      a.artifact.source,
      a.artifact.provenance ?? a.artifact.source,
      a.domain,
      a.memoryType,
      a.salienceTier,
      operationDedupHash,
      a.stoneR2Key,
      now,
      now,
      now,
    ),
  ])
}

export async function persistRetained(args: {
  artifact: IngestionArtifact
  env: Env
  dedupHash: string
  stoneR2Key: string
  memoryType: string
  domain: string
  salienceTier: number
  salienceSurpriseScore: number
  memoryId: string
}): Promise<void> {
  const now = Date.now()
  const a = args
  await a.env.D1_US.batch([
    a.env.D1_US.prepare(
      `INSERT OR IGNORE INTO ingestion_events
       (id, tenant_id, created_at, source, salience_tier, surprise_score, memory_id, r2_key, dedup_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(), a.artifact.tenantId, now, a.artifact.source,
      a.salienceTier, a.salienceSurpriseScore, a.memoryId, a.stoneR2Key, a.dedupHash,
    ),
    a.env.D1_US.prepare(
      `INSERT INTO memory_audit
       (id, tenant_id, created_at, operation, memory_id, memory_type, domain, provenance, salience_tier)
       VALUES (?, ?, ?, 'retained', ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(), a.artifact.tenantId, now,
      a.memoryId, a.memoryType, a.domain, a.artifact.provenance ?? a.artifact.source, a.salienceTier,
    ),
  ])
}

export async function scheduleQueuedRetainFollowUps(args: {
  env: Env
  tenantId: string
  operationId: string | null
  memoryId: string
  ctx?: Pick<ExecutionContext, 'waitUntil'>
}): Promise<void> {
  const warmDedicatedWorkers = ensureHindsightWorkersRunning(args.env).catch((error) => {
    console.error('RETAIN_CONTENT_WORKER_WARM_FAILED', {
      tenantId: args.tenantId,
      operationId: args.operationId,
      error: error instanceof Error ? error.message : String(error),
    })
  })
  if (args.ctx) {
    const reconcileOperation = reconcileHindsightOperationSoon(args.operationId ?? args.memoryId, args.env).catch((error) => {
      console.error('RETAIN_CONTENT_RECONCILE_FAILED', {
        tenantId: args.tenantId,
        operationId: args.operationId,
        error: error instanceof Error ? error.message : String(error),
      })
    })
    args.ctx.waitUntil(warmDedicatedWorkers)
    args.ctx.waitUntil(reconcileOperation)
    return
  }
  await warmDedicatedWorkers
}
