// src/services/ingestion/retain.ts
// The single path for ALL memory writes — retainContent()
// Pipeline: dedup → write policy → encrypt (AES-256-GCM) → R2 STONE → Hindsight retain → D1 batch
// LESSON: D1 batch for every (operation + audit) pair — atomic
// LESSON: INSERT OR IGNORE for dedup (at-least-once safety)

import type { Env } from '../../types/env'
import type { IngestionArtifact, RetainResult } from '../../types/ingestion'
import type { HindsightRetainRequest, HindsightRetainResponse } from '../../types/hindsight'
import { computeDedupHash, checkDedup } from './dedup'
import { scoreSalience } from './salience'
import { inferDomain, inferMemoryType } from './domain'
import { runWritePolicyValidator } from './write-policy'

/**
 * Encrypt content with AES-256-GCM using the tenant TMK
 * Returns base64 string of IV + ciphertext
 */
async function encryptContent(content: string, tmk: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = new TextEncoder().encode(content)
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    tmk,
    data,
  )
  // Concatenate IV + ciphertext and base64 encode
  const combined = new Uint8Array(iv.length + ciphertext.byteLength)
  combined.set(iv)
  combined.set(new Uint8Array(ciphertext), iv.length)
  return btoa(String.fromCharCode(...combined))
}

/**
 * The single path for all memory writes
 * Returns null if dedup hit or write policy violation (silent drop)
 */
export async function retainContent(
  artifact: IngestionArtifact,
  tmk: CryptoKey,
  env: Env,
  ctx?: ExecutionContext,
): Promise<RetainResult | null> {
  const { tenantId, content, source } = artifact

  // Step 1: Dedup check
  const dedupHash = await computeDedupHash(source, content)
  const isDuplicate = await checkDedup(dedupHash, tenantId, env)
  if (isDuplicate) return null

  // Step 2: Write policy validation (Law 3)
  const memoryType = inferMemoryType(content, artifact.memoryType)
  const policyResult = await runWritePolicyValidator(content, memoryType, env)
  if (policyResult.isProcedural) {
    // Silent drop — log anomaly, return null (LESSON: no error to prevent doom loops)
    await env.D1_US.prepare(
      `INSERT OR IGNORE INTO anomaly_signals (id, tenant_id, created_at, signal_type, severity, detail_json)
       VALUES (?, ?, ?, 'write_policy_violation', 'medium', ?)`,
    ).bind(
      crypto.randomUUID(), tenantId, Date.now(),
      JSON.stringify({ method: policyResult.method, source }),
    ).run()
    return null
  }

  // Step 3: Salience scoring + domain inference
  const salience = scoreSalience(artifact)
  const domain = artifact.domain ?? inferDomain(content)

  // Step 4: Encrypt content (Law 2: zero-knowledge)
  const contentEncrypted = await encryptContent(content, tmk)

  // Step 5: R2 STONE archive (non-blocking via waitUntil)
  const stoneR2Key = `stone/${tenantId}/${Date.now()}-${crypto.randomUUID()}.enc`
  if (ctx) {
    ctx.waitUntil(
      env.R2_ARTIFACTS.put(stoneR2Key, contentEncrypted).catch(() => {
        // STONE write failure is non-critical — log but don't block
      }),
    )
  } else {
    // Sync fallback when no execution context (direct MCP call)
    await env.R2_ARTIFACTS.put(stoneR2Key, contentEncrypted).catch(() => {})
  }

  // Step 6: Hindsight retain (encrypted content — Law 2)
  const hindsightReq: HindsightRetainRequest = {
    tenant_id: tenantId,
    content_encrypted: contentEncrypted,
    memory_type: memoryType,
    domain,
    provenance: artifact.provenance ?? source,
    salience_tier: salience.tier,
    occurred_at: artifact.occurredAt,
    metadata: artifact.metadata,
  }

  const hindsightRes = await env.HINDSIGHT.fetch('http://hindsight/api/retain', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(hindsightReq),
  })

  const hindsightData = await hindsightRes.json() as HindsightRetainResponse
  const memoryId = hindsightData.memory_id

  // Step 7: D1 batch — ingestion_events + memory_audit (atomic)
  // LESSON: D1 batch for atomic operation + audit pair
  // LESSON: INSERT OR IGNORE for at-least-once queue safety
  await env.D1_US.batch([
    env.D1_US.prepare(
      `INSERT OR IGNORE INTO ingestion_events
       (id, tenant_id, created_at, source, salience_tier, surprise_score, memory_id, r2_key, dedup_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(), tenantId, Date.now(), source,
      salience.tier, salience.surpriseScore, memoryId, stoneR2Key, dedupHash,
    ),
    env.D1_US.prepare(
      `INSERT INTO memory_audit
       (id, tenant_id, created_at, operation, memory_id, memory_type, domain, provenance, salience_tier)
       VALUES (?, ?, ?, 'retained', ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(), tenantId, Date.now(),
      memoryId, memoryType, domain, artifact.provenance ?? source, salience.tier,
    ),
  ])

  return { memoryId, salienceTier: salience.tier, dedupHash, stoneR2Key }
}
