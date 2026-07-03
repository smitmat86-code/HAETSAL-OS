// src/services/messaging-helpers.ts
// Shared inbound-messaging helpers used by every chat channel (Sendblue,
// Telegram, future WhatsApp/Discord). One retrieval + one gemma call per
// inbound message. Law 2: no plaintext logging inside this module.

import type { Env } from '../types/env'
import { searchCanonicalMemory } from './canonical-memory-query'
import { runGatewayChat, runGatewayVision } from './workers-ai-chat'

/** Memory-grounded reply. `channel` is only used in the system prompt phrasing. */
export async function buildGroundedReply(
  env: Env,
  tenantId: string,
  text: string,
  channel: string,
): Promise<string> {
  let contextBlock = ''
  try {
    const context = await searchCanonicalMemory(
      { tenantId, query: text, mode: 'composed', limit: 5 }, env, tenantId,
    )
    if (context.items.length > 0) {
      contextBlock = '\n\nRelevant memories (cite naturally when useful):\n' + context.items
        .map((item) => `- [${item.sourceSystem ?? 'memory'}${item.capturedAt ? ', ' + new Date(item.capturedAt).toISOString().slice(0, 10) : ''}] ${item.preview}`)
        .join('\n')
    }
  } catch {
    // Retrieval failures never block a reply.
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
