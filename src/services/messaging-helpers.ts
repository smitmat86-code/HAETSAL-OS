// src/services/messaging-helpers.ts
// Shared inbound-messaging helpers used by every chat channel (Sendblue,
// Telegram, future WhatsApp/Discord). One retrieval + one gemma call per
// inbound message. Law 2: no plaintext logging inside this module.

import type { Env } from '../types/env'
import { searchCanonicalMemory } from './canonical-memory-query'
import { runGatewayChat, runGatewayVision } from './workers-ai-chat'

/** Race a promise against a timeout so slow retrieval never blocks the reply. */
async function withTimeout<T>(p: Promise<T>, ms: number, tag: string): Promise<T | null> {
  return await Promise.race([
    p.then((v) => v).catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => {
      console.warn(`${tag}_TIMEOUT`, { ms })
      resolve(null)
    }, ms)),
  ])
}

/** Memory-grounded reply. `channel` is only used in the system prompt phrasing. */
export async function buildGroundedReply(
  env: Env,
  tenantId: string,
  text: string,
  channel: string,
): Promise<string> {
  let contextBlock = ''
  // Retrieval budget: 10s. Neon auto-suspends after ~5 min idle and cold-
  // start latency runs 5-8s; Hyperdrive doesn't cache (Law 2). Lexical FTS
  // is fast once warm. Timeout still fires so the reply always ships; the
  // long-term fix (a keepalive ping or a warm-connection pool) belongs in
  // Phase 10/11 broker tuning.
  const context = await withTimeout(
    searchCanonicalMemory({ tenantId, query: text, mode: 'lexical', limit: 5 }, env, tenantId),
    10000, 'RETRIEVAL',
  )
  if (context && context.items.length > 0) {
    contextBlock = '\n\nRelevant memories (cite naturally when useful):\n' + context.items
      .map((item) => `- [${item.sourceSystem ?? 'memory'}${item.capturedAt ? ', ' + new Date(item.capturedAt).toISOString().slice(0, 10) : ''}] ${item.preview}`)
      .join('\n')
  }
  const reply = await runGatewayChat(env, [
    {
      role: 'system',
      content: `You are Haetsal, a warm and capable personal AI assistant reached over ${channel}. Keep replies concise and conversational. Ground answers in the provided memories when relevant; if a needed source (like Gmail or calendar) is not connected yet, say so honestly.` + contextBlock,
    },
    { role: 'user', content: text },
  ])
  return reply ?? 'I had trouble thinking just now - try me again in a moment.'
}

/** Vision description of an inbound photo. */
export async function describeInboundPhoto(
  env: Env,
  imageBytes: ArrayBuffer,
  mediaType: string,
): Promise<string> {
  const description = await runGatewayVision(
    env,
    'Describe this image concisely and concretely for a personal memory archive: subjects, any legible text, and context. 2-4 sentences.',
    imageBytes,
    mediaType,
  )
  return description ?? 'Photo captured (no description available).'
}
