// src/services/messaging-helpers.ts
// Shared inbound-messaging helpers used by every chat channel (Sendblue,
// Telegram, future WhatsApp/Discord). One retrieval + one gemma call per
// inbound message. Law 2: no plaintext logging inside this module.

import type { Env } from '../types/env'
import { searchCanonicalMemory } from './canonical-memory-query'
import { runGatewayChat, runGatewayVision } from './workers-ai-chat'
import { createCanonicalPostgresSql } from './postgres-sql'

/**
 * Warm the canonical Postgres connection so the retrieval query that follows
 * doesn't eat a 2-5s Neon cold-start. No-op on hot connections; ~3s the first
 * message after ~5 min idle. Runs synchronously against the Hyperdrive pool
 * so the following real query reuses the warmed connection.
 */
export async function warmCanonicalPostgres(env: Env): Promise<void> {
  try {
    const sql = createCanonicalPostgresSql(env)
    await sql`SELECT 1`
  } catch (error) {
    console.warn('NEON_WARM_FAILED', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

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

/** Memory-grounded reply. `channel` is only used in the system prompt phrasing.
 *  `sessionBlock` (Phase 9) is the decrypted recent-conversation window. */
export async function buildGroundedReply(
  env: Env,
  tenantId: string,
  text: string,
  channel: string,
  sessionBlock = '',
): Promise<string> {
  let contextBlock = ''
  // Warm the pool FIRST so the retrieval query reuses a hot connection.
  // Doing this in parallel races both queries against the same cold-start;
  // running it serially costs 3s on cold but 0ms once Neon is warm.
  await warmCanonicalPostgres(env)
  // Retrieval budget: 10s post-warm. Lexical FTS on a hot connection returns
  // in tens of milliseconds; the timeout is a safety net for the unusual case.
  const context = await withTimeout(
    searchCanonicalMemory({ tenantId, query: text, mode: 'lexical', limit: 5 }, env, tenantId),
    10000, 'RETRIEVAL',
  )
  if (context && context.items.length > 0) {
    contextBlock = '\n\nRelevant memories (cite naturally when useful):\n' + context.items
      .map((item) => `- [${item.sourceSystem ?? 'memory'}${item.capturedAt ? ', ' + new Date(item.capturedAt).toISOString().slice(0, 10) : ''}] ${item.preview}`)
      .join('\n')
  }
  const sessionContext = sessionBlock
    ? `\n\nConversation so far (continue it naturally):\n${sessionBlock}`
    : ''
  const reply = await runGatewayChat(env, [
    {
      role: 'system',
      content: `You are Haetsal, a warm and capable personal AI assistant reached over ${channel}. Keep replies concise and conversational. Ground answers in the provided memories when relevant; if a needed source (like Gmail or calendar) is not connected yet, say so honestly.` + contextBlock + sessionContext,
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
  console.log('VISION_ATTEMPT', { byteLength: imageBytes.byteLength, mediaType })
  const description = await runGatewayVision(
    env,
    'Describe this image concisely and concretely for a personal memory archive: subjects, any legible text, and context. 2-4 sentences.',
    imageBytes,
    mediaType,
  )
  if (!description) {
    console.warn('VISION_EMPTY', { byteLength: imageBytes.byteLength, mediaType })
  }
  return description ?? 'Photo captured (no description available).'
}
