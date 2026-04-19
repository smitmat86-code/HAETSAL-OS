import type { Env } from '../../types/env'
import type { IngestionArtifact, RetainResult } from '../../types/ingestion'
import { computeDedupHash, checkDedup } from './dedup'
import { scoreSalience } from './salience'
import { inferDomain, inferMemoryType } from './domain'
import { runWritePolicyValidator } from './write-policy'
import { encryptContentForArchive } from './encryption'
import { captureThroughCanonicalPipeline } from '../canonical-capture-pipeline'

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
  const pipeline = await captureThroughCanonicalPipeline({
    tenantId,
    sourceSystem: source,
    sourceRef: dedupHash,
    scope: domain,
    title: typeof artifact.metadata?.title === 'string' ? artifact.metadata.title : null,
    body: content,
    bodyEncrypted: contentEncrypted,
    capturedAt: artifact.occurredAt,
    memoryType,
    compatibilityMode: 'current_hindsight',
    provenance: artifact.provenance ?? source,
    metadata: artifact.metadata,
    dedupHash,
    salienceTier: salience.tier,
    salienceSurpriseScore: salience.surpriseScore,
    hindsightAsync: options?.hindsightAsync ?? false,
  }, env, tenantId, ctx)

  console.log('RETAIN_CONTENT_CANONICAL_PIPELINE_DONE', {
    tenantId,
    source,
    canonicalCaptureId: pipeline.capture.captureId,
    canonicalOperationId: pipeline.capture.operationId,
    compatibilityStatus: pipeline.compatibility.status,
  })

  return {
    memoryId: pipeline.compatibility.memoryId ?? pipeline.capture.operationId,
    operationId: pipeline.compatibility.operationId ?? pipeline.capture.operationId,
    documentId: pipeline.compatibility.documentId ?? pipeline.capture.documentId,
    salienceTier: salience.tier,
    dedupHash,
    stoneR2Key: pipeline.compatibility.stoneR2Key,
    canonicalCaptureId: pipeline.capture.captureId,
    canonicalDocumentId: pipeline.capture.documentId,
    canonicalOperationId: pipeline.capture.operationId,
    canonicalDispatchStatus: pipeline.dispatch.status,
    compatibilityStatus: pipeline.compatibility.status,
  }
}
