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
  options?: { contentEncrypted?: string; eagerProjectionDispatch?: boolean },
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
    sourceRef: artifact.sourceRef ?? dedupHash,
    scope: domain,
    title: typeof artifact.metadata?.title === 'string' ? artifact.metadata.title : null,
    body: content,
    bodyEncrypted: contentEncrypted,
    artifactRef: artifact.artifactRef ?? null,
    capturedAt: artifact.occurredAt,
    memoryType,
    provenance: artifact.provenance ?? source,
    metadata: artifact.metadata,
    dedupHash,
    salienceTier: salience.tier,
    salienceSurpriseScore: salience.surpriseScore,
    eagerProjectionDispatch: options?.eagerProjectionDispatch ?? false,
    governance: artifact.governance ?? null,
  }, env, tenantId, ctx, tmk)

  console.log('RETAIN_CONTENT_CANONICAL_PIPELINE_DONE', {
    tenantId,
    source,
    canonicalCaptureId: pipeline.capture.captureId,
    canonicalOperationId: pipeline.capture.operationId,
    memoryClass: pipeline.capture.governance.memoryClass,
    trustState: pipeline.capture.governance.trustState,
  })

  // Operational ingestion trail. Load-bearing: checkDedup() reads
  // ingestion_events.dedup_hash, so this insert is what makes dedup stick.
  // Metadata only — no content (Law 2).
  await env.D1_US.prepare(
    `INSERT OR IGNORE INTO ingestion_events
     (id, tenant_id, created_at, source, salience_tier, surprise_score, memory_id, r2_key, dedup_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(), tenantId, Date.now(), source,
    salience.tier, salience.surpriseScore,
    pipeline.capture.operationId, pipeline.capture.bodyR2Key, dedupHash,
  ).run()

  return {
    memoryId: pipeline.capture.operationId,
    operationId: pipeline.capture.operationId,
    documentId: pipeline.capture.documentId,
    salienceTier: salience.tier,
    dedupHash,
    canonicalCaptureId: pipeline.capture.captureId,
    canonicalDocumentId: pipeline.capture.documentId,
    canonicalOperationId: pipeline.capture.operationId,
    canonicalDispatchStatus: pipeline.dispatch.status,
    governance: pipeline.capture.governance,
  }
}
