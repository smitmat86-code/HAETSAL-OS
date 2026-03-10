// src/tools/recall.ts
// Real Hindsight recall — encrypt query with TMK, send to Hindsight, decrypt results
// Law 2: query encrypted before Hindsight, results decrypted with TMK in DO

import type { RecallInput, RecallOutput } from '../types/tools'
import type { Env } from '../types/env'
import type { HindsightRecallResponse } from '../types/hindsight'

/**
 * Encrypt a query string with TMK for Hindsight
 */
async function encryptQuery(query: string, tmk: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = new TextEncoder().encode(query)
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, tmk, data)
  const combined = new Uint8Array(iv.length + ciphertext.byteLength)
  combined.set(iv)
  combined.set(new Uint8Array(ciphertext), iv.length)
  return btoa(String.fromCharCode(...combined))
}

/**
 * Decrypt content returned from Hindsight
 */
async function decryptContent(encrypted: string, tmk: CryptoKey): Promise<string> {
  const combined = new Uint8Array(atob(encrypted).split('').map(c => c.charCodeAt(0)))
  const iv = combined.slice(0, 12)
  const ciphertext = combined.slice(12)
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, tmk, ciphertext)
  return new TextDecoder().decode(decrypted)
}

/**
 * Real recall via Hindsight — called from DO where TMK is available
 */
export async function recallViaService(
  input: RecallInput,
  tenantId: string,
  tmk: CryptoKey | null,
  env: Env,
): Promise<RecallOutput> {
  if (!tmk) {
    return {
      results: [],
      synthesis: 'Memory system unavailable — no active session.',
    }
  }

  const queryEncrypted = await encryptQuery(input.query, tmk)

  const res = await env.HINDSIGHT.fetch('http://hindsight/api/recall', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tenant_id: tenantId,
      query_encrypted: queryEncrypted,
      domain: input.domain,
      mode: input.mode ?? 'default',
      limit: input.limit ?? 10,
    }),
  })

  const data = await res.json() as HindsightRecallResponse

  // Decrypt each result's content with TMK (Law 2: zero-knowledge)
  const results = await Promise.all(
    data.results.map(async (r) => ({
      memory_id: r.memory_id,
      content: await decryptContent(r.content_encrypted, tmk),
      memory_type: r.memory_type,
      confidence: r.confidence,
      relevance: r.relevance,
    })),
  )

  return {
    results,
    synthesis: results.length > 0
      ? `Found ${results.length} relevant memories.`
      : 'No matching memories found.',
  }
}

// Keep stub export for backward compatibility with tests
export async function recallStub(input: RecallInput): Promise<RecallOutput> {
  return {
    results: [{
      memory_id: crypto.randomUUID(),
      content: `[Stub] Query: "${input.query}"`,
      memory_type: 'episodic',
      confidence: 0,
      relevance: 0,
    }],
    synthesis: '[Stub] Recall stub — use recallViaService for real recall.',
  }
}
