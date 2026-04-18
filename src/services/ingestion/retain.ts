import type { Env } from '../../types/env'
import type { IngestionArtifact, RetainResult } from '../../types/ingestion'
import type { HindsightRetainResponse } from '../../types/hindsight'
import { computeDedupHash, checkDedup } from './dedup'
import { scoreSalience } from './salience'
import { inferDomain, inferMemoryType } from './domain'
import { runWritePolicyValidator } from './write-policy'
import { encryptContentForArchive } from './encryption'
import { ensureHindsightBankConfigured } from '../bootstrap/hindsight-config'
import { maybeShadowWriteCanonicalCapture } from '../canonical-memory'
import { retainMemory } from '../hindsight'
import { archiveEncryptedContent, persistQueuedRetain, persistRetained, scheduleQueuedRetainFollowUps } from './retain-persistence'
import { buildHindsightRetainRequest } from './retain-request'

export async function retainContent(
  artifact: IngestionArtifact,
  tmk: CryptoKey | null,
  env: Env,
  ctx?: Pick<ExecutionContext, 'waitUntil'>,
  options?: { contentEncrypted?: string; hindsightAsync?: boolean },
): Promise<RetainResult | null> {
  const { tenantId, content, source } = artifact
  console.log('RETAIN_CONTENT_START', {
    tenantId,
    source,
    occurredAt: artifact.occurredAt,
    memoryType: artifact.memoryType ?? null,
    domain: artifact.domain ?? null,
  })

  const dedupHash = await computeDedupHash(source, content)
  const isDuplicate = await checkDedup(dedupHash, tenantId, env)
  if (isDuplicate) {
    console.log('RETAIN_CONTENT_DEDUP_HIT', { tenantId, source, dedupHash })
    return null
  }

  const memoryType = inferMemoryType(content, artifact.memoryType)
  const policyResult = await runWritePolicyValidator(content, memoryType, env)
  if (policyResult.isProcedural) {
    await env.D1_US.prepare(
      `INSERT OR IGNORE INTO anomaly_signals (id, tenant_id, created_at, signal_type, severity, detail_json)
       VALUES (?, ?, ?, 'write_policy_violation', 'medium', ?)`,
    ).bind(
      crypto.randomUUID(), tenantId, Date.now(),
      JSON.stringify({ method: policyResult.method, source }),
    ).run()
    return null
  }

  const salience = scoreSalience(artifact)
  const domain = artifact.domain ?? inferDomain(content)

  const contentEncrypted = options?.contentEncrypted
    ?? (tmk ? await encryptContentForArchive(content, tmk) : null)
  if (!contentEncrypted) {
    throw new Error('retainContent requires TMK or pre-encrypted archival content')
  }
  ctx?.waitUntil(maybeShadowWriteCanonicalCapture({ tenantId, sourceSystem: source, scope: domain, body: content, bodyEncrypted: contentEncrypted }, env).catch((error) => {
    console.error('RETAIN_CONTENT_CANONICAL_SHADOW_FAILED', {
      tenantId,
      source,
      error: error instanceof Error ? error.message : String(error),
    })
  }))

  const stoneR2Key = await archiveEncryptedContent(env, tenantId, contentEncrypted, ctx)

  const { documentId, request: hindsightReq } = buildHindsightRetainRequest(
    artifact,
    dedupHash,
    memoryType,
    domain,
    salience.tier,
    options?.hindsightAsync ?? false,
  )
  console.log('RETAIN_CONTENT_HINDSIGHT_REQUEST', {
    tenantId,
    source,
    documentId,
    tags: hindsightReq.items[0]?.tags ?? [],
  })
  await ensureHindsightBankConfigured(tenantId, tenantId, env)
  let hindsightData: HindsightRetainResponse
  try {
    hindsightData = await retainMemory(tenantId, hindsightReq, env) as HindsightRetainResponse
  } catch (error) {
    console.error('RETAIN_CONTENT_HINDSIGHT_ERROR', {
      tenantId,
      source,
      documentId,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
  const memoryId = hindsightData.operation_id ?? documentId
  const operationId = hindsightData.operation_id ?? null
  console.log('RETAIN_CONTENT_HINDSIGHT_DONE', {
    tenantId,
    source,
    documentId,
    memoryId,
    operationId,
    async: hindsightReq.async ?? false,
  })

  if (hindsightReq.async) {
    await persistQueuedRetain({
      artifact, env, dedupHash, stoneR2Key, memoryType, domain,
      salienceTier: salience.tier,
      salienceSurpriseScore: salience.surpriseScore,
      documentId, hindsightData, memoryId, operationId,
    })

    console.log('RETAIN_CONTENT_QUEUED', {
      tenantId,
      memoryId,
      operationId,
      bankId: hindsightData.bank_id,
      dedupHash,
      stoneR2Key,
    })

    await scheduleQueuedRetainFollowUps({ env, tenantId, operationId, memoryId, ctx })

    return { memoryId, operationId, documentId, salienceTier: salience.tier, dedupHash, stoneR2Key }
  }

  await persistRetained({
    artifact, env, dedupHash, stoneR2Key, memoryType, domain,
    salienceTier: salience.tier,
    salienceSurpriseScore: salience.surpriseScore,
    memoryId,
  })

  console.log('RETAIN_CONTENT_D1_DONE', {
    tenantId,
    memoryId,
    dedupHash,
    stoneR2Key,
  })

  return { memoryId, operationId, documentId, salienceTier: salience.tier, dedupHash, stoneR2Key }
}
